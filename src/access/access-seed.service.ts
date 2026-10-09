import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { notInArray, sql } from 'drizzle-orm';
import { DB, type Database } from '../database/database.module.js';
import {
  permissions,
  rolePermissions,
  roles,
} from '../database/schema/index.js';
import { DEFAULT_ROLES } from './default-roles.js';
import { PERMISSION_CODES, permissionRows } from './permission-registry.js';

/**
 * On every start: make the `permissions` table match the registry in code.
 * On a fresh install only: create the built-in roles.
 */
@Injectable()
export class AccessSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AccessSeedService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  async onApplicationBootstrap() {
    await this.db.transaction(async (tx) => {
      // Serialize concurrent starts (e.g. API restarted while a test runs).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('access-seed'))`);

      await tx
        .insert(permissions)
        .values(permissionRows())
        .onConflictDoUpdate({
          target: permissions.code,
          set: {
            module: sql`excluded.module`,
            menu: sql`excluded.menu`,
            action: sql`excluded.action`,
            label: sql`excluded.label`,
            sortOrder: sql`excluded.sort_order`,
            isPinApprovable: sql`excluded.is_pin_approvable`,
          },
        });
      // Codes removed from the registry disappear, with their role ticks (FK cascade).
      await tx
        .delete(permissions)
        .where(notInArray(permissions.code, PERMISSION_CODES));

      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(roles);
      if (count > 0) return;

      for (const def of DEFAULT_ROLES) {
        const [role] = await tx
          .insert(roles)
          .values({
            name: def.name,
            description: def.description,
            isSystem: true,
            isOwner: def.isOwner ?? false,
          })
          .returning({ id: roles.id });
        if (def.permissions.length > 0) {
          await tx.insert(rolePermissions).values(
            def.permissions.map((code) => ({
              roleId: role.id,
              permissionCode: code,
            })),
          );
        }
      }
      this.logger.log(`Created ${DEFAULT_ROLES.length} built-in roles`);
    });
  }
}
