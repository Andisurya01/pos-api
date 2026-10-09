import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { docMonth } from '../common/business-date.js';
import type { DbTransaction } from '../database/database.module.js';
import { documentSequences } from '../database/schema/index.js';

/** Document type codes (docs/alur/README.md §3). */
export type DocType =
  | 'PJ' | 'RJ' | 'VD' | 'PO' | 'PB' | 'TG' | 'BH' | 'RB'
  | 'PM' | 'SO' | 'PS' | 'KK' | 'KM' | 'MK' | 'JU' | 'SA';

export const formatDocNo = (type: DocType, yymm: string, n: number) =>
  `${type}/${yymm}/${String(n).padStart(5, '0')}`;

/**
 * Gapless numbering per type per month. The upsert locks the counter row until the
 * posting transaction ends, so a rolled-back posting gives its number back.
 */
@Injectable()
export class DocumentNumberService {
  async next(tx: DbTransaction, type: DocType, businessDate: string) {
    const period = docMonth(businessDate);
    const [row] = await tx
      .insert(documentSequences)
      .values({ docType: type, period, lastNo: 1 })
      .onConflictDoUpdate({
        target: [documentSequences.docType, documentSequences.period],
        set: { lastNo: sql`${documentSequences.lastNo} + 1` },
      })
      .returning({ lastNo: documentSequences.lastNo });
    return formatDocNo(type, period, row.lastNo);
  }
}
