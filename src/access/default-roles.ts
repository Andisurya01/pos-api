// Built-in roles, created once on a fresh install. After that, admins own the ticks.
import { PERMISSION_CODES, type PermissionCode } from './permission-registry.js';

export interface DefaultRole {
  name: string;
  description: string;
  isOwner?: boolean;
  permissions: readonly PermissionCode[];
}

const startsWith =
  (...prefixes: string[]) =>
  (code: PermissionCode) =>
    prefixes.some((p) => code.startsWith(p));

export const DEFAULT_ROLES: readonly DefaultRole[] = [
  {
    name: 'Owner',
    description: 'Pemilik. Selalu memegang semua izin.',
    isOwner: true,
    permissions: [], // implicit: all
  },
  {
    name: 'Admin',
    description: 'Mengelola toko sehari-hari.',
    // Reopening a closed period is reserved for the owner (docs/alur/07).
    permissions: PERMISSION_CODES.filter(
      (c) => c !== 'keuangan.periode.buka_kembali',
    ),
  },
  {
    name: 'Gudang',
    description: 'Penerimaan barang, stok, dan opname.',
    permissions: [
      ...PERMISSION_CODES.filter(startsWith('gudang.')).filter(
        (c) => c !== 'gudang.saldo_awal.setujui',
      ),
      'produk.produk.lihat',
      'pembelian.supplier.lihat',
      'pembelian.po.lihat',
      'pembelian.po.buat',
      'pembelian.penerimaan.lihat',
      'pembelian.penerimaan.buat',
      'pembelian.penerimaan_langsung.buat',
      'pembelian.retur.lihat',
      'pembelian.retur.buat',
      'pembelian.saran.lihat',
      'laporan.persediaan.lihat',
    ],
  },
  {
    name: 'Keuangan',
    description: 'Kas, bank, hutang, jurnal, dan laporan keuangan.',
    permissions: [
      ...PERMISSION_CODES.filter(startsWith('keuangan.', 'laporan.')).filter(
        (c) => c !== 'keuangan.periode.buka_kembali',
      ),
      'produk.produk.lihat',
      'produk.harga.lihat',
      'produk.harga.lihat_modal',
      'pembelian.supplier.lihat',
      'pembelian.po.lihat',
      'pembelian.penerimaan.lihat',
      'pembelian.tagihan.lihat',
      'pembelian.tagihan.buat',
      'pembelian.tagihan.setujui_selisih',
      'pembelian.pembayaran.lihat',
      'pembelian.pembayaran.buat',
      'pembelian.retur.lihat',
    ],
  },
  {
    name: 'Kasir',
    description: 'Transaksi di layar kasir. Tidak punya akses diskon.',
    permissions: [
      'penjualan.kasir.lihat',
      'penjualan.transaksi.buat',
      'penjualan.shift.buka',
      'penjualan.shift.tutup',
      'penjualan.shift.kas_masuk',
      'penjualan.shift.kas_keluar',
      'member.member.lihat',
      'member.member.buat',
    ],
  },
];
