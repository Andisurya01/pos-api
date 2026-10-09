import { businessDate, docMonth, periodRange } from '../common/business-date.js';
import { CHART_TEMPLATE, DEFAULT_MAPPINGS, normalBalanceOf } from './chart-template.js';
import { formatDocNo } from './document-number.service.js';

describe('business dates (WIB)', () => {
  it('rolls over at midnight WIB, not UTC', () => {
    expect(businessDate(new Date('2026-10-08T16:59:59Z'))).toBe('2026-10-08');
    expect(businessDate(new Date('2026-10-08T17:00:00Z'))).toBe('2026-10-09');
  });

  it('computes period ranges, including February in a leap year', () => {
    expect(periodRange('2028-02-15')).toEqual({ id: '2028-02', startsOn: '2028-02-01', endsOn: '2028-02-29' });
    expect(periodRange('2026-12-31')).toEqual({ id: '2026-12', startsOn: '2026-12-01', endsOn: '2026-12-31' });
  });

  it('formats document numbers per type and month', () => {
    expect(formatDocNo('PJ', docMonth('2026-10-09'), 123)).toBe('PJ/2610/00123');
  });
});

describe('chart of accounts template', () => {
  const byCode = new Map(CHART_TEMPLATE.map((a) => [a.code, a]));

  it('maps every automatic-journal key to an existing postable account', () => {
    for (const code of Object.values(DEFAULT_MAPPINGS)) {
      const account = byCode.get(code);
      expect(account, code).toBeDefined();
      expect(account!.header, code).toBeFalsy();
    }
  });

  it('lists parents before children, under a header of the same type', () => {
    const seen = new Set<string>();
    for (const a of CHART_TEMPLATE) {
      if (a.parent) {
        expect(seen.has(a.parent), a.code).toBe(true);
        expect(byCode.get(a.parent)!.header, a.code).toBe(true);
        expect(byCode.get(a.parent)!.type, a.code).toBe(a.type);
      }
      seen.add(a.code);
    }
  });

  it('marks the sub-ledger accounts as control accounts', () => {
    for (const code of ['1-1400', '2-1100', '2-1200', '1-1310', '1-1320']) {
      expect(byCode.get(code)!.control, code).toBe(true);
    }
  });

  it('flips the normal balance of contra accounts', () => {
    expect(normalBalanceOf('REVENUE')).toBe('CREDIT');
    expect(normalBalanceOf('REVENUE', true)).toBe('DEBIT');
    expect(normalBalanceOf('ASSET')).toBe('DEBIT');
  });
});
