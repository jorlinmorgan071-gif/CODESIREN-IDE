# App Security Notes

## Audit gate: `npm audit --omit=dev --audit-level=high`

The CI audit job (`.github/workflows/ci.yml`, `audit` job → `App audit (production deps only)`)
runs the app audit with `--omit=dev` so the gate only fails on vulnerabilities in
packages that actually ship to users. This is intentional and matches how the app is
distributed: the production build (`npm run build`) bundles only `dependencies`, never
`devDependencies`.

### Why `--omit=dev`

A full `npm audit` (including devDependencies) currently reports **5 high** advisories:

| Package                 | Severity | Chain                                     | Ships to users? |
|-------------------------|----------|-------------------------------------------|-----------------|
| `braces`                | high     | `tailwindcss` → `fast-glob` → `micromatch` → `braces` | **No** (devDep) |
| `chokidar`              | high     | `tailwindcss` → `chokidar`                | **No** (devDep) |
| `fast-glob`             | high     | `tailwindcss` → `fast-glob`               | **No** (devDep) |
| `micromatch`            | high     | `tailwindcss` → `fast-glob` → `micromatch`| **No** (devDep) |
| `tailwindcss`           | high     | `tailwindcss` (direct devDep)             | **No** (devDep) |

All 5 live in the **Tailwind v3 build tooling chain** — they run only at build time
(CSS generation, file watching) and are never bundled into the production output.
There is **no non-breaking fix** within the Tailwind v3.x line; the upstream fix
requires upgrading to **Tailwind CSS v4**, which is a major breaking change
(new engine, new config format, PostCSS plugin replaced by a Vite plugin, class
name changes). That migration is tracked as a **post-launch task**.

### What ships: 2 moderate, 0 high

With `--omit=dev`, the audit reports **2 moderate** advisories (in the
`postcss-selector-parser` chain used by Tailwind at build time and `dompurify`
via `monaco-editor`), both below the `--audit-level=high` gate. The gate passes.

### Post-launch task: Tailwind v4 migration

- **Goal:** eliminate the 5 high advisories in the Tailwind v3 build chain.
- **Scope:** `app/tailwind.config.js`, `app/postcss.config.js`, `app/vite.config.ts`,
  every `@apply` / `@tailwind` directive in `app/src/index.css`, and any
  Tailwind-specific utility classes that changed names in v4.
- **Constraint:** do **not** attempt this under pre-launch pressure. The v4 engine
  rewrite has changed enough class names and config semantics that a rushed
  migration will regress the UI. Schedule it as a dedicated, separately-tested
  change after launch.
- **Verification after migration:** the CI `audit` job's `App audit` step can be
  reverted to a plain `npm audit --audit-level=high` (drop `--omit=dev`) once the
  dev chain is clean.

## Lockfile hygiene: no mirror registries

The CI `lockfile-hygiene` job fails if any `package-lock.json` references a mirror
registry (e.g. `registry.npmmirror.com`). Mirror URLs leaked into a public repo
break installs in regions that block the mirror and signal that a lockfile was
generated inside a sandbox with a non-default registry. Integrity hashes protect
content, but the `resolved` URL must still point at the canonical npm registry
(`registry.npmjs.org`).

When regenerating lockfiles, always pass the registry explicitly:

```bash
npm install --registry=https://registry.npmjs.org/
```

The `app/.npmrc` pins `registry=https://registry.npmjs.org/` so plain `npm install`
also targets the official registry.
