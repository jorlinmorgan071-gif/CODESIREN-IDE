# P0 Terminal Trust Hardening

## Contract

The Code Siren terminal must never present invented command output as process output. A command may execute only through a tenant-owned, WorkspaceService-bound isolated PTY session. Until that service exists, both the visible terminal and the terminal agent report an explicit unavailable state and execute no process.

## Audit findings and correction

The terminal UI generated canned responses for `ls`, `git`, `npm`, and arbitrary commands, while the Output tab displayed a fabricated Vite build transcript. Independently, the Terminal Agent used `execSync()` in server `/tmp`, which was a real host process but neither a PTY nor bound to a tenant workspace. It could not honestly be represented as an isolated IDE terminal.

The correction removes all visible generated command and build output. The input is disabled with a clear explanation, and the Output tab states that no isolated terminal session exists. The Terminal Agent retains validation and approval behavior but refuses post-approval execution with `TERMINAL_UNAVAILABLE`; it records `executed: false` rather than producing a command event, process output, or synthetic failure.

## Regression evidence

| Gate | Result |
|---|---|
| Backend typecheck after removing `execSync()` execution | Passed |
| Focused terminal intelligence and approval-gate suites | Passed: 23 tests |
| Frontend tests | Passed: 11 files / 63 tests |
| Frontend lint | Passed |

## Deliberate next boundary

A future terminal service must create a session only after resolving `{ userId, projectId }` through `WorkspaceService`, use an isolated per-workspace PTY/container runtime, stream exact stdout/stderr with session ownership checks, terminate sessions on disconnect or expiry, and expose no host paths or unrelated output. It must not reintroduce local `exec`, canned results, or global terminal broadcasts.

## Release status

Complete server tests passed with **65 files / 862 tests**. Focused terminal and approval coverage passed with **23 tests**. Frontend tests passed with **11 files / 63 tests**; frontend lint and production build passed. The source scan found no remaining simulated-output helper, canned Vite transcript, `Command executed` fallback, or `execSync(proposedCommand)` path. `git diff --check` and the protected-asset audit passed. Implementation commit `2c064f9` was pushed to `origin/main`, and local and remote `main` resolve to `2c064f90d2dd94ab7b9c7e728b90d901f78955b9`. The release status is **published**.
