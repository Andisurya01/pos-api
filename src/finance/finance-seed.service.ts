import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../database/database.module.js';
import { accountMappings, accounts } from '../database/schema/index.js';
import {
  CHART_TEMPLATE,
  DEFAULT_MAPPINGS,
  type MappingKey,
  normalBalanceOf,
} from './chart-template.js';

/** Fresh install: the retail chart of accounts and every automatic-journal mapping. */
@Injectable()
export class FinanceSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FinanceSeedService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  async onApplicationBootstrap() {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('finance-seed'))`);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(accounts);
      if (count > 0) return;

      const idByCode = new Map<string, string>();
      for (const a of CHART_TEMPLATE) {
        const [row] = await tx
          .insert(accounts)
          .values({
            code: a.code,
            name: a.name,
            type: a.type,
            normalBalance: normalBalanceOf(a.type, a.contra),
            parentId: a.parent ? idByCode.get(a.parent)! : null,
            isPostable: !a.header,
            isControl: a.control ?? false,
            cashKind: a.cash ?? null,
            cashFlowGroup: a.cash ? null : 'OPERATING',
            isSystem: true,
          })
          .returning({ id: accounts.id });
        idByCode.set(a.code, row.id);
      }
      await tx.insert(accountMappings).values(
        (Object.entries(DEFAULT_MAPPINGS) as [MappingKey, string][]).map(([key, code]) => ({
          key,
          accountId: idByCode.get(code)!,
        })),
      );
      this.logger.log(`Installed chart of accounts (${CHART_TEMPLATE.length} accounts)`);
    });
  }
}
