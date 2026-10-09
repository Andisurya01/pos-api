// Single source of truth for permission codes (docs/alur/02-pengguna-dan-hak-akses.md).
// Synced into the `permissions` table on startup; admins can only tick these per role.
// Pattern: modul.menu.aksi. `pin: true` = the permission can approve a [PIN] action.

type PermissionDef = { readonly label: string; readonly pin?: boolean };

export const PERMISSION_REGISTRY = {
  // Pengaturan
  'pengaturan.toko.ubah': { label: 'Ubah pengaturan toko' },
  'pengaturan.perangkat.ubah': { label: 'Atur laci kasir, printer, dan metode bayar' },
  'pengaturan.pengguna.lihat': { label: 'Lihat pengguna' },
  'pengaturan.pengguna.buat': { label: 'Tambah pengguna' },
  'pengaturan.pengguna.ubah': { label: 'Ubah pengguna dan reset kata sandi' },
  'pengaturan.pengguna.nonaktifkan': { label: 'Nonaktifkan pengguna' },
  'pengaturan.hak_akses.lihat': { label: 'Lihat hak akses' },
  'pengaturan.hak_akses.ubah': { label: 'Ubah hak akses dan role' },
  'pengaturan.integritas.jalankan': { label: 'Jalankan pemeriksaan integritas' },

  // Produk dan master
  'produk.produk.lihat': { label: 'Lihat produk' },
  'produk.produk.buat': { label: 'Tambah produk' },
  'produk.produk.ubah': { label: 'Ubah produk' },
  'produk.produk.nonaktifkan': { label: 'Nonaktifkan produk' },
  'produk.produk.impor': { label: 'Impor produk' },
  'produk.produk.ekspor': { label: 'Ekspor produk' },
  'produk.kategori.ubah': { label: 'Kelola kategori, merek, dan satuan' },
  'produk.harga.lihat': { label: 'Lihat harga jual' },
  'produk.harga.ubah': { label: 'Ubah harga jual' },
  'produk.harga.lihat_modal': { label: 'Lihat HPP dan harga beli' },
  'produk.bundel.lihat': { label: 'Lihat bundel' },
  'produk.bundel.buat': { label: 'Tambah bundel' },
  'produk.bundel.ubah': { label: 'Ubah bundel' },
  'promo.promo.lihat': { label: 'Lihat promo' },
  'promo.promo.buat': { label: 'Tambah promo' },
  'promo.promo.ubah': { label: 'Ubah promo' },
  'promo.promo.nonaktifkan': { label: 'Nonaktifkan promo' },
  'member.member.lihat': { label: 'Lihat member' },
  'member.member.buat': { label: 'Daftarkan member' },
  'member.member.ubah': { label: 'Ubah member' },

  // Penjualan
  'penjualan.kasir.lihat': { label: 'Buka layar kasir' },
  'penjualan.transaksi.buat': { label: 'Buat transaksi penjualan' },
  'penjualan.transaksi.void': { label: 'Void transaksi', pin: true },
  'penjualan.transaksi.cetak_ulang': { label: 'Cetak ulang struk', pin: true },
  'penjualan.retur.buat': { label: 'Retur penjualan', pin: true },
  'penjualan.kasir.ubah_harga': { label: 'Ubah harga di kasir', pin: true },
  'penjualan.kasir.diskon_manual': { label: 'Beri diskon manual', pin: true },
  'penjualan.kasir.jual_stok_minus': { label: 'Jual saat stok toko habis', pin: true },
  'penjualan.kasir.buka_laci': { label: 'Buka laci tanpa transaksi', pin: true },
  'penjualan.shift.buka': { label: 'Buka shift' },
  'penjualan.shift.tutup': { label: 'Tutup shift' },
  'penjualan.shift.tutup_paksa': { label: 'Tutup paksa shift kasir lain' },
  'penjualan.shift.kas_masuk': { label: 'Kas masuk di laci' },
  'penjualan.shift.kas_keluar': { label: 'Kas keluar dari laci' },

  // Pembelian
  'pembelian.supplier.lihat': { label: 'Lihat supplier' },
  'pembelian.supplier.ubah': { label: 'Tambah dan ubah supplier' },
  'pembelian.po.lihat': { label: 'Lihat PO' },
  'pembelian.po.buat': { label: 'Buat PO' },
  'pembelian.po.ubah': { label: 'Ubah PO' },
  'pembelian.po.batalkan': { label: 'Batalkan atau tutup PO' },
  'pembelian.po.setujui': { label: 'Setujui PO' },
  'pembelian.po.cetak': { label: 'Cetak PO' },
  'pembelian.penerimaan.lihat': { label: 'Lihat penerimaan barang' },
  'pembelian.penerimaan.buat': { label: 'Catat penerimaan barang' },
  'pembelian.penerimaan.batalkan': { label: 'Batalkan penerimaan barang' },
  'pembelian.penerimaan.lebih_dari_po': { label: 'Terima melebihi sisa PO', pin: true },
  'pembelian.penerimaan_langsung.buat': { label: 'Penerimaan langsung tanpa PO' },
  'pembelian.tagihan.lihat': { label: 'Lihat tagihan supplier' },
  'pembelian.tagihan.buat': { label: 'Catat tagihan supplier' },
  'pembelian.tagihan.setujui_selisih': { label: 'Setujui selisih tagihan' },
  'pembelian.pembayaran.lihat': { label: 'Lihat pembayaran hutang' },
  'pembelian.pembayaran.buat': { label: 'Bayar hutang supplier' },
  'pembelian.retur.lihat': { label: 'Lihat retur pembelian' },
  'pembelian.retur.buat': { label: 'Buat retur pembelian' },
  'pembelian.retur.setujui': { label: 'Setujui retur pembelian' },
  'pembelian.saran.lihat': { label: 'Lihat saran pembelian' },

  // Gudang
  'gudang.lokasi.lihat': { label: 'Lihat lokasi' },
  'gudang.lokasi.buat': { label: 'Tambah lokasi' },
  'gudang.lokasi.ubah': { label: 'Ubah lokasi' },
  'gudang.pemindahan.lihat': { label: 'Lihat pemindahan stok' },
  'gudang.pemindahan.buat': { label: 'Pindahkan stok' },
  'gudang.opname.lihat': { label: 'Lihat stock opname' },
  'gudang.opname.buat': { label: 'Buat stock opname' },
  'gudang.opname.hitung': { label: 'Input hasil hitung opname' },
  'gudang.opname.setujui': { label: 'Setujui selisih opname' },
  'gudang.penyesuaian.lihat': { label: 'Lihat penyesuaian stok' },
  'gudang.penyesuaian.buat': { label: 'Buat penyesuaian stok' },
  'gudang.penyesuaian.setujui': { label: 'Setujui penyesuaian stok' },
  'gudang.saldo_awal.buat': { label: 'Isi saldo awal stok' },
  'gudang.saldo_awal.setujui': { label: 'Setujui saldo awal stok' },
  'gudang.kartu_stok.lihat': { label: 'Lihat kartu stok' },

  // Keuangan
  'keuangan.akun.lihat': { label: 'Lihat bagan akun' },
  'keuangan.akun.ubah': { label: 'Ubah bagan akun dan pemetaan akun' },
  'keuangan.saldo_awal.buat': { label: 'Isi saldo awal akun dan hutang' },
  'keuangan.saldo_awal.setujui': { label: 'Setujui dan kunci saldo awal' },
  'keuangan.mutasi_kas.buat': { label: 'Mutasi kas antar akun' },
  'keuangan.pengeluaran.lihat': { label: 'Lihat pengeluaran' },
  'keuangan.pengeluaran.buat': { label: 'Catat pengeluaran' },
  'keuangan.pengeluaran.setujui': { label: 'Setujui pengeluaran' },
  'keuangan.kas_masuk.buat': { label: 'Catat kas masuk lain-lain' },
  'keuangan.jurnal.lihat': { label: 'Lihat jurnal' },
  'keuangan.jurnal.buat': { label: 'Buat jurnal manual' },
  'keuangan.jurnal.setujui': { label: 'Setujui jurnal manual' },
  'keuangan.rekonsiliasi.lihat': { label: 'Lihat rekonsiliasi bank' },
  'keuangan.rekonsiliasi.buat': { label: 'Kerjakan rekonsiliasi bank' },
  'keuangan.rekonsiliasi.selesaikan': { label: 'Selesaikan rekonsiliasi bank' },
  'keuangan.periode.tutup': { label: 'Tutup periode' },
  'keuangan.periode.buka_kembali': { label: 'Buka kembali periode' },

  // Laporan
  'laporan.penjualan.lihat': { label: 'Laporan penjualan' },
  'laporan.penjualan.ekspor': { label: 'Ekspor laporan penjualan' },
  'laporan.laba_kotor.lihat': { label: 'Laporan laba kotor' },
  'laporan.persediaan.lihat': { label: 'Laporan persediaan (jumlah)' },
  'laporan.persediaan.lihat_nilai': { label: 'Laporan nilai persediaan' },
  'laporan.persediaan.ekspor': { label: 'Ekspor laporan persediaan' },
  'laporan.pembelian.lihat': { label: 'Laporan pembelian dan hutang' },
  'laporan.pembelian.ekspor': { label: 'Ekspor laporan pembelian' },
  'laporan.keuangan.lihat': { label: 'Laporan keuangan' },
  'laporan.keuangan.ekspor': { label: 'Ekspor laporan keuangan' },
  'laporan.pajak.lihat': { label: 'Rekap PPN' },
  'laporan.kontrol.lihat': { label: 'Audit log dan laporan kontrol' },
} as const satisfies Record<string, PermissionDef>;

export type PermissionCode = keyof typeof PERMISSION_REGISTRY;

export const PERMISSION_CODES = Object.keys(
  PERMISSION_REGISTRY,
) as PermissionCode[];

export const MODULE_LABELS: Record<string, string> = {
  pengaturan: 'Pengaturan',
  produk: 'Produk',
  promo: 'Promo',
  member: 'Member',
  penjualan: 'Penjualan',
  pembelian: 'Pembelian',
  gudang: 'Gudang',
  keuangan: 'Keuangan',
  laporan: 'Laporan',
};

/** Rows for the `permissions` table, in registry order. */
export function permissionRows() {
  return PERMISSION_CODES.map((code, index) => {
    const [module, menu, action] = code.split('.');
    const def: PermissionDef = PERMISSION_REGISTRY[code];
    return {
      code,
      module,
      menu,
      action,
      label: def.label,
      sortOrder: index,
      isPinApprovable: def.pin ?? false,
    };
  });
}
