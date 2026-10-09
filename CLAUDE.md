# CLAUDE.md — pos-api

Backend POS Retail. Aturan proyek, keputusan, alur, dan ERD ada di folder induk:

- `../CLAUDE.md` — identitas proyek dan prinsip yang tidak boleh dilanggar
- `../docs/PRD.md`, `../docs/KEPUTUSAN.md`
- `../docs/alur/` — alur per modul (konsep posting di `README.md`)
- `../docs/erd/` — rancangan tabel; skema Drizzle harus mengikuti ini

## Stack

| | |
|---|---|
| Framework | NestJS 12 (ESM, `"type": "module"` — import relatif memakai akhiran `.js`) |
| Bahasa | TypeScript 6 (`--strict`) |
| Database | PostgreSQL 15+ dengan Drizzle ORM 0.45 + drizzle-kit, driver `pg`, `casing: 'snake_case'` (kunci TS camelCase, kolom DB snake_case) |
| Validasi | Zod 4 (env di `src/config/env.ts`) |
| Test | Vitest (`pnpm test`, `pnpm test:e2e`) |
| Lint / format | oxlint (`pnpm lint`), Prettier (`pnpm format`) |
| Package manager | pnpm |
| Port dev | 4000 (3000 dipakai frontend `pos`) |

## Struktur

```
src/
├── config/env.ts            ← skema env (Zod); app menolak start jika env salah
├── database/                ← provider global `DB` (Drizzle); schema/ satu file per domain ERD
├── common/                  ← ZodValidationPipe, paginasi {data,pagination}, quantity, business-date (WIB), PgErrorFilter (23505→409)
├── audit/                   ← AuditService.log(entry, tx) — selalu kirim tx yang sedang berjalan
├── access/                  ← daftar izin (permission-registry.ts), role bawaan, AuthGuard global, PIN supervisor, kelola role
├── auth/                    ← login/refresh/logout/me/change-password, wizard Owner pertama (/setup)
├── users/                   ← kelola pengguna, PIN pribadi
├── catalog/                 ← kategori/merek/satuan, produk-SKU-satuan-barcode-harga, bundel, promo, lookup kasir
├── partners/                ← supplier dan member (normalisasi nomor HP)
├── finance/                 ← bagan akun + pemetaan, periode, JournalService (posting/balik), DocumentNumberService
├── purchasing/              ← PO, penerimaan (+langsung), tagihan, pembayaran hutang, retur pembelian
├── sales/                   ← laci kasir, metode bayar, shift (transaksi penjualan menyusul)
├── stock/                   ← StockService (ledger + saldo + HPP rata-rata), penyesuaian & saldo awal stok, pemindahan, stock opname, kartu stok
└── health/                  ← GET /api/v1/health
drizzle/                     ← migrasi SQL (0000–0009), ikut di-commit
test/                        ← e2e per modul; helpers/db.ts mengosongkan pos_test sebelum tiap file
```

Semua route memakai prefix `/api/v1`.

## Konvensi kode

- **Izin:** setiap endpoint diberi `@RequirePermission(...)` / `@RequireAnyPermission(...)`, atau `@Public()`. Kode izin baru ditambahkan di `access/permission-registry.ts` (otomatis tersinkron ke DB saat start).
- **Posting dokumen:** satu `db.transaction`: kunci (`StockService.lock`), nomor (`DocumentNumberService.next`), ledger stok (`StockService.receive/issue/move`), jurnal (`JournalService.post`), status dokumen, `AuditService.log(..., tx)`. Contoh lengkap: `stock/adjustments.service.ts`.
- **Uang:** kolom `bigint` dibaca sebagai `number` (rupiah bulat). **Jumlah barang:** string 3 desimal (`numeric(18,3)`); hitungan stok/HPP memakai `stock/valuation.ts` (bigint milli-unit), jangan pakai float.
- **ID dokumen** dibuat klien (UUID). Kirim ulang dengan ID sama = idempotent.
- **Aksi [PIN]:** panggil `PinService.authorize(tx, principal, code, pinApprovalId, entity)` di dalam transaksi posting.
- Pesan error untuk pengguna dalam Bahasa Indonesia; komentar kode dalam bahasa Inggris.

## Database

- Lokal: role `pos`, database `pos_dev` (dev) dan `pos_test` (test). Kredensial di `.env` (tidak di-commit; contoh di `.env.example`).
- Ubah skema: edit `src/database/schema/*`, lalu `pnpm db:generate --name=<nama>`, lalu `pnpm db:migrate` dan `pnpm db:migrate:test`.
- SQL yang tidak bisa diekspresikan Drizzle (trigger, constraint trigger): `pnpm exec drizzle-kit generate --custom --name=<nama>`, lalu tulis SQL-nya.
- Migrasi yang sudah di-commit tidak boleh diedit; buat migrasi baru.
- Tabel buku (audit log, nanti ledger stok dan jurnal) dilindungi trigger `forbid_update_delete()`.

## Gate verifikasi

Sebelum menyatakan selesai: `pnpm build`, `pnpm lint`, `pnpm test`, dan `pnpm test:e2e` (butuh PostgreSQL lokal berjalan).

## Repo

Repo git terpisah dari frontend (`../pos`). Folder `../docs` dan `../CLAUDE.md` tidak berada di repo mana pun.
