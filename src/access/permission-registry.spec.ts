import { DEFAULT_ROLES } from './default-roles.js';
import {
  MODULE_LABELS,
  PERMISSION_CODES,
  PERMISSION_REGISTRY,
  permissionRows,
} from './permission-registry.js';

describe('permission registry', () => {
  it('uses the modul.menu.aksi pattern for every code', () => {
    for (const code of PERMISSION_CODES) {
      expect(code).toMatch(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/);
    }
  });

  it('has a label for every module', () => {
    for (const row of permissionRows()) {
      expect(MODULE_LABELS[row.module]).toBeDefined();
    }
  });

  it('marks exactly the [PIN] actions from docs/alur/02 as PIN-approvable', () => {
    const pinCodes = PERMISSION_CODES.filter(
      (c) => (PERMISSION_REGISTRY[c] as { pin?: boolean }).pin,
    ).sort();
    expect(pinCodes).toEqual(
      [
        'pembelian.penerimaan.lebih_dari_po',
        'penjualan.kasir.buka_laci',
        'penjualan.kasir.diskon_manual',
        'penjualan.kasir.jual_stok_minus',
        'penjualan.kasir.ubah_harga',
        'penjualan.retur.buat',
        'penjualan.transaksi.cetak_ulang',
        'penjualan.transaksi.void',
      ].sort(),
    );
  });
});

describe('default roles', () => {
  const byName = (name: string) => DEFAULT_ROLES.find((r) => r.name === name)!;

  it('only references registered codes, without duplicates', () => {
    for (const role of DEFAULT_ROLES) {
      for (const code of role.permissions) {
        expect(PERMISSION_CODES).toContain(code);
      }
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
    }
  });

  it('has exactly one owner role', () => {
    expect(DEFAULT_ROLES.filter((r) => r.isOwner)).toHaveLength(1);
  });

  it('gives the cashier no discount, price-change or void power (owner decision 2026-10-08)', () => {
    const kasir = byName('Kasir').permissions;
    expect(kasir).not.toContain('penjualan.kasir.diskon_manual');
    expect(kasir).not.toContain('penjualan.kasir.ubah_harga');
    expect(kasir).not.toContain('penjualan.transaksi.void');
  });

  it('reserves reopening a closed period for the owner', () => {
    for (const role of DEFAULT_ROLES.filter((r) => !r.isOwner)) {
      expect(role.permissions).not.toContain('keuangan.periode.buka_kembali');
    }
  });
});
