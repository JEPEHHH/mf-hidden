# Rencana Kerja: mend CLI

## Tujuan
Membangun CLI `mend` di `main.ts` (root repo, Node 22 + stdlib) sesuai kontrak penuh `starter/SPEC.md` dan `brief.md`, sambil mempertahankan hand-over `runner.ts`.

## Rencana Kerja (Commit Tiap Milestone)
1. **Milestone 1 — Setup & Baseline**
   - Siapkan `main.ts`, `runner.ts`, dan `LICENSE` di root repo berbasis `starter/`.
   - Jalankan `node starter/check.ts program/generator/practice.json` untuk baseline JSON/CLI.
2. **Milestone 2 — Core Tree, Line Handling & Matching (SPEC §2, §3, §5, §10)**
   - Lengkapi utilitas pemecahan baris CRLF/LF, final newline, dan tracking rename `R <old> -> <new>`.
   - Implementasikan pencocokan 3 tier (exact, rtrim, trim), flag `--strict`, preservasi baris konteks, dan re-indent tier 2.
3. **Milestone 3 — Format Unified Diff (SPEC §6)**
   - Parser section (`diff --git`, `---`/`+++`, `rename`, mode file, abaikan prose/code fence) dan hunk `@@`.
   - Applier create/delete/move/modify, pemilihan posisi terdekat `A - 1 + d`, dan aturan `\ No newline`.
4. **Milestone 4 — Format SEARCH/REPLACE (SPEC §7)**
   - Parser blok marker `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` serta resolusi path dan pengabaian code fence.
   - Applier create (saat old kosong) dan replace tepat satu kecocokan (atau `ambiguous`/`no-match`).
5. **Milestone 5 — Format V4A (SPEC §8)**
   - Parser `*** Begin/End Patch`, `Add/Delete/Update File`, `Move to`, chunk `@@ <anchor>`, dan `*** End of File`.
   - Applier berbasis cursor berurutan, pencarian anchor 3 tier, dan aturan EOF.
6. **Milestone 6 — Verifikasi, Edge Cases & Deliverable**
   - Audit ulang §1–§10 (termasuk JSON edits, kode error/baris parse, urutan byte UTF-8, `--check`, atomisitas).
   - Lulus 100% `practice.json` + suite uji edge-case mandiri; lengkapi deliverable wajib.

## Daftar Berkas yang Akan Dibuat
- `PLAN.md` — Rencana kerja dan daftar berkas ini.
- `main.ts` — Implementasi lengkap CLI `mend` (Node 22 stdlib) + hand-over `runner.ts`.
- `runner.ts` — Salinan utuh `starter/runner.ts` untuk eksekusi trial grader.
- `LICENSE` — Berkas lisensi MIT (OSI-approved) di root repo.
- `.makefun/owner.json` — Metadata pemilik untuk deliverable wajib kompetisi.
- `tests/spec.test.ts` — Pengujian otomatis edge-case untuk seluruh klausa `SPEC.md`.
