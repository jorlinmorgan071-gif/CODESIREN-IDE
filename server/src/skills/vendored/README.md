# Vendored Skills

Upstream MIT-licensed skills, converted to Code Siren's TOML skill
format at boot by `loadVendoredSkills()` in
`server/src/skills/importer.ts`. Loaded from the repo — **no network at boot**.

- `MANIFEST.json` — every curated skill entry, its source repo, the pinned
  commit SHA, license, and `kept` status (with `dropReason` for dropped ones).
- `THIRD_PARTY_LICENSES.md` — combined upstream license notices.
- `<repo>/LICENSE` — each upstream LICENSE, verbatim.
- `<repo>/<skillDir>/SKILL.md` — the vendored skill source (only `kept: true`).

## Refreshing

Refreshing is the explicit `POST /api/skills/import` endpoint, which fetches
a repo's skills over the network (raw URLs use `HEAD`, so the repo's default
branch is used regardless of whether it is `main` or `master`). Boot does
**not** refresh — it only loads what is checked in here.

## Summary

- Curated entries: **46**
- Vendored (kept): **38**
- Dropped (Paperclip-platform-specific): **8**

Of the 9 `paperclipai/paperclip` skills, only **para-memory-files** works
standalone in Code Siren (generic PARA file-memory methodology; `qmd` is an
optional enhancement with a grep fallback). The other 8 target Paperclip's
own platform (Paperclip native tools, the `paperclipai` CLI, `$PAPERCLIP_*`
env vars, and `/api/companies/*` endpoints) and are recorded as
`kept: false` in the manifest for audit but not vendored.

