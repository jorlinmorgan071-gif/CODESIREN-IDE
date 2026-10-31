# P2 Extension and Language-Server Truthfulness

## Audit decision

Code Siren does **not** currently contain an installable VSIX host, a signed VSIX verification/install pipeline, a browser language-client transport, or a managed language-server lifecycle. The server dependency graph contains neither a VSIX package installer nor an LSP protocol runtime, while the browser dependency graph contains Monaco only and no Monaco language client. The existing `ExtensionAgent` and `/api/skills` routes manage TOML Skills Vault entries, not editor extensions or language servers.

The Settings UI nevertheless displayed a fixed list of third-party products as `running` or `paused`. Those values were not queried from any runtime, did not install a package, start a process, report a health probe, or remove resources. They were fabricated extension health claims.

## Safe corrective contract

Until Code Siren has all of the following, it must not claim extension or LSP support:

| Required capability | Current evidence | Result |
|---|---|---|
| Signed VSIX artifact validation and trusted publisher policy | Absent | Unsupported |
| Sandboxed VSIX extension host with resource limits | Absent | Unsupported |
| Monaco language-client transport and lifecycle integration | Absent | Unsupported |
| Installed-server registry with owner/project policy | Absent | Unsupported |
| Start, health, stop, and clean removal evidence | Absent | Unsupported |

The smallest safe P2 correction therefore removes the unsupported Extensions navigation and static Settings list, and rebrands the existing agent only as a **Skills Vault Agent**. The implementation removes the sidebar entry, the Settings tab, every fixed `running`/`paused` third-party status, and the unreachable `extensions` sidebar state. It preserves the stable internal `extension-agent` identifier only for existing orchestration compatibility; all user-facing agent and route error wording now says Skills Vault Agent. The actual signed-skill manifest behavior is unchanged, and no skill is described as a VSIX extension or language server.

## Actual editor capability boundary

Monaco continues to provide its built-in browser features for supported document languages. They are editor features, not a remote language server. A future extension/LSP project must introduce a separate, reviewed design covering signed artifact provenance, isolated process/container execution, tenant-bound install state, a constrained protocol bridge, health checks, shutdown, uninstall cleanup, and UI evidence. It must not reuse Skills Vault manifests as a substitute for that contract.

## Focused validation

The frontend `extension-claim-removal.test.ts` verifies that neither primary navigation nor Settings advertises an `extensions` entry or a fabricated static health state. The existing end-to-end Skills Vault pipeline passed with **6 tests**, including its real install/list/invoke behavior and the rebranded agent name. Server TypeScript validation passed after the correction. The final complete server suite passed with **70 files and 896 tests**; the final complete application suite passed with **16 files and 71 tests**; frontend lint and production build also passed.

> **Checked out** for this P2 means Code Siren has no user-facing claim of a running third-party extension or language server unless a future implementation can demonstrate signed installation, successful startup, health, and clean removal. It does not mean Monaco’s built-in browser services are an LSP or VSIX host.
