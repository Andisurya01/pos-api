// Default chart of accounts for an Indonesian retail store (docs/alur/01, docs/erd/06).
// Installed once; clients may add accounts and rename, mapped accounts cannot be removed.

type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
type CashKind = 'DRAWER' | 'CASH' | 'PETTY_CASH' | 'BANK' | 'CLEARING';

export interface TemplateAccount {
  code: string;
  name: string;
  type: AccountType;
  parent?: string;
  /** Group headers only hold children. */
  header?: boolean;
  control?: boolean;
  cash?: CashKind;
  /** Contra accounts flip the normal balance of their type. */
  contra?: boolean;
}

export const CHART_TEMPLATE: readonly TemplateAccount[] = [
  { code: '1-0000', name: 'Aset', type: 'ASSET', header: true },
  { code: '1-1000', name: 'Kas dan Setara Kas', type: 'ASSET', parent: '1-0000', header: true },
  { code: '1-1100', name: 'Kas Besar', type: 'ASSET', parent: '1-1000', cash: 'CASH' },
  { code: '1-1110', name: 'Kas Kecil', type: 'ASSET', parent: '1-1000', cash: 'PETTY_CASH' },
  { code: '1-1120', name: 'Kas Laci Kasir', type: 'ASSET', parent: '1-1000', header: true },
  { code: '1-1200', name: 'Bank', type: 'ASSET', parent: '1-1000', header: true },
  { code: '1-1300', name: 'Piutang EDC/QRIS', type: 'ASSET', parent: '1-0000', header: true },
  { code: '1-1310', name: 'Piutang QRIS', type: 'ASSET', parent: '1-1300', cash: 'CLEARING', control: true },
  { code: '1-1320', name: 'Piutang Kartu Debit/Kredit', type: 'ASSET', parent: '1-1300', cash: 'CLEARING', control: true },
  { code: '1-1400', name: 'Persediaan Barang Dagang', type: 'ASSET', parent: '1-0000', control: true },
  { code: '1-1500', name: 'PPN Masukan', type: 'ASSET', parent: '1-0000' },
  { code: '1-1600', name: 'Biaya Dibayar di Muka', type: 'ASSET', parent: '1-0000' },
  { code: '1-2000', name: 'Aset Tetap', type: 'ASSET', parent: '1-0000', header: true },
  { code: '1-2100', name: 'Peralatan Toko', type: 'ASSET', parent: '1-2000' },

  { code: '2-0000', name: 'Kewajiban', type: 'LIABILITY', header: true },
  { code: '2-1100', name: 'Hutang Usaha', type: 'LIABILITY', parent: '2-0000', control: true },
  { code: '2-1200', name: 'Barang Diterima Belum Ditagih', type: 'LIABILITY', parent: '2-0000', control: true },
  { code: '2-1300', name: 'PPN Keluaran', type: 'LIABILITY', parent: '2-0000' },
  { code: '2-1400', name: 'Hutang Lain-lain', type: 'LIABILITY', parent: '2-0000' },

  { code: '3-0000', name: 'Ekuitas', type: 'EQUITY', header: true },
  { code: '3-1000', name: 'Modal Pemilik', type: 'EQUITY', parent: '3-0000' },
  { code: '3-2000', name: 'Laba Ditahan', type: 'EQUITY', parent: '3-0000' },
  { code: '3-3000', name: 'Laba Tahun Berjalan', type: 'EQUITY', parent: '3-0000' },
  { code: '3-9000', name: 'Ekuitas Saldo Awal', type: 'EQUITY', parent: '3-0000' },

  { code: '4-0000', name: 'Pendapatan', type: 'REVENUE', header: true },
  { code: '4-1000', name: 'Penjualan', type: 'REVENUE', parent: '4-0000' },
  { code: '4-1100', name: 'Potongan Penjualan', type: 'REVENUE', parent: '4-0000', contra: true },
  { code: '4-1200', name: 'Retur Penjualan', type: 'REVENUE', parent: '4-0000', contra: true },
  { code: '4-2000', name: 'Pendapatan Lain-lain', type: 'REVENUE', parent: '4-0000', header: true },
  { code: '4-2100', name: 'Pendapatan Pembulatan', type: 'REVENUE', parent: '4-2000' },
  { code: '4-2200', name: 'Pendapatan Selisih Kas', type: 'REVENUE', parent: '4-2000' },
  { code: '4-2300', name: 'Pendapatan Selisih Persediaan', type: 'REVENUE', parent: '4-2000' },
  { code: '4-2900', name: 'Pendapatan Lain-lain Umum', type: 'REVENUE', parent: '4-2000' },

  { code: '5-0000', name: 'Harga Pokok Penjualan', type: 'EXPENSE', header: true },
  { code: '5-1000', name: 'HPP Barang Dagang', type: 'EXPENSE', parent: '5-0000' },
  { code: '5-1100', name: 'Selisih Harga Retur Pembelian', type: 'EXPENSE', parent: '5-0000' },

  { code: '6-0000', name: 'Beban', type: 'EXPENSE', header: true },
  { code: '6-1000', name: 'Beban Operasional', type: 'EXPENSE', parent: '6-0000', header: true },
  { code: '6-1100', name: 'Beban Listrik', type: 'EXPENSE', parent: '6-1000' },
  { code: '6-1200', name: 'Beban Air', type: 'EXPENSE', parent: '6-1000' },
  { code: '6-1300', name: 'Beban Internet dan Telepon', type: 'EXPENSE', parent: '6-1000' },
  { code: '6-1400', name: 'Beban Sewa', type: 'EXPENSE', parent: '6-1000' },
  { code: '6-1500', name: 'Beban Gaji dan Upah', type: 'EXPENSE', parent: '6-1000' },
  { code: '6-1600', name: 'Beban Transport', type: 'EXPENSE', parent: '6-1000' },
  { code: '6-1700', name: 'Beban ATK', type: 'EXPENSE', parent: '6-1000' },
  { code: '6-1800', name: 'Beban Kebersihan', type: 'EXPENSE', parent: '6-1000' },
  { code: '6-1900', name: 'Beban Perbaikan', type: 'EXPENSE', parent: '6-1000' },
  { code: '6-1990', name: 'Beban Lain-lain', type: 'EXPENSE', parent: '6-1000' },
  { code: '6-2000', name: 'Beban Persediaan', type: 'EXPENSE', parent: '6-0000', header: true },
  { code: '6-2100', name: 'Beban Selisih Persediaan', type: 'EXPENSE', parent: '6-2000' },
  { code: '6-2200', name: 'Beban Kerusakan Barang', type: 'EXPENSE', parent: '6-2000' },
  { code: '6-2300', name: 'Beban Pemakaian Sendiri', type: 'EXPENSE', parent: '6-2000' },
  { code: '6-2400', name: 'Beban Promosi', type: 'EXPENSE', parent: '6-2000' },
  { code: '6-3000', name: 'Beban Keuangan', type: 'EXPENSE', parent: '6-0000', header: true },
  { code: '6-3100', name: 'Beban MDR', type: 'EXPENSE', parent: '6-3000' },
  { code: '6-3200', name: 'Beban Administrasi Bank', type: 'EXPENSE', parent: '6-3000' },
  { code: '6-3300', name: 'Beban Pembulatan', type: 'EXPENSE', parent: '6-3000' },
  { code: '6-3400', name: 'Beban Selisih Kas', type: 'EXPENSE', parent: '6-3000' },
];

export type MappingKey =
  | 'INVENTORY' | 'GRNI' | 'COGS'
  | 'SALES' | 'SALES_DISCOUNT' | 'SALES_RETURN' | 'VAT_OUT' | 'ROUNDING_GAIN' | 'ROUNDING_LOSS'
  | 'ACCOUNTS_PAYABLE' | 'VAT_IN' | 'PURCHASE_RETURN_VARIANCE'
  | 'MAIN_CASH' | 'CASH_OVER' | 'CASH_SHORT' | 'MDR_EXPENSE' | 'BANK_FEE'
  | 'INV_SHRINKAGE' | 'INV_GAIN' | 'DAMAGE_EXPENSE' | 'SELF_USE_EXPENSE' | 'PROMO_EXPENSE'
  | 'OPENING_EQUITY' | 'CURRENT_YEAR_EARNINGS' | 'RETAINED_EARNINGS';

/** Which template account each automatic journal uses. */
export const DEFAULT_MAPPINGS: Record<MappingKey, string> = {
  INVENTORY: '1-1400',
  GRNI: '2-1200',
  COGS: '5-1000',
  SALES: '4-1000',
  SALES_DISCOUNT: '4-1100',
  SALES_RETURN: '4-1200',
  VAT_OUT: '2-1300',
  ROUNDING_GAIN: '4-2100',
  ROUNDING_LOSS: '6-3300',
  ACCOUNTS_PAYABLE: '2-1100',
  VAT_IN: '1-1500',
  PURCHASE_RETURN_VARIANCE: '5-1100',
  MAIN_CASH: '1-1100',
  CASH_OVER: '4-2200',
  CASH_SHORT: '6-3400',
  MDR_EXPENSE: '6-3100',
  BANK_FEE: '6-3200',
  INV_SHRINKAGE: '6-2100',
  INV_GAIN: '4-2300',
  DAMAGE_EXPENSE: '6-2200',
  SELF_USE_EXPENSE: '6-2300',
  PROMO_EXPENSE: '6-2400',
  OPENING_EQUITY: '3-9000',
  CURRENT_YEAR_EARNINGS: '3-3000',
  RETAINED_EARNINGS: '3-2000',
};

const NORMAL: Record<AccountType, 'DEBIT' | 'CREDIT'> = {
  ASSET: 'DEBIT',
  EXPENSE: 'DEBIT',
  LIABILITY: 'CREDIT',
  EQUITY: 'CREDIT',
  REVENUE: 'CREDIT',
};

export function normalBalanceOf(type: AccountType, contra = false): 'DEBIT' | 'CREDIT' {
  const normal = NORMAL[type];
  if (!contra) return normal;
  return normal === 'DEBIT' ? 'CREDIT' : 'DEBIT';
}
