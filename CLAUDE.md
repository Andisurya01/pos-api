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
| Database | PostgreSQL 15+ dengan Drizzle (belum dipasang) |
| Test | Vitest (`pnpm test`, `pnpm test:e2e`) |
| Lint / format | oxlint (`pnpm lint`), Prettier (`pnpm format`) |
| Package manager | pnpm |
| Port dev | 4000 (3000 dipakai frontend `pos`) |

## Gate verifikasi

Sebelum menyatakan selesai: `pnpm build`, `pnpm lint`, `pnpm test`.

## Repo

Repo git terpisah dari frontend (`../pos`). Folder `../docs` dan `../CLAUDE.md` tidak berada di repo mana pun.
