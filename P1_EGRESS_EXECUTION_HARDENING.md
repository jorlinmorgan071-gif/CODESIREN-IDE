# P1 Egress and Execution Hardening

## Purpose and audited baseline

This P1 slice replaces the prior narrow destination and shell deny lists with one **fail-closed egress and execution policy**. It covers the server-owned outbound HTTP capability, Operative browser requests, browser navigation, and command validation. It does not alter model selection, provider registration, or multi-provider architecture.

The audit found four material gaps. First, `http_request` sent caller-supplied URLs through ordinary `fetch`, which follows redirects automatically and did not reject private, link-local, loopback, or IPv6 destinations. Second, the browser validator blocked a few literal hostnames and schemes, but Playwright followed redirects without rechecking the final destination. Third, the terminal validator was a pattern deny list and did not reject shell chaining, substitution, or many equivalent command variants. Fourth, the Operative API accepted an arbitrary natural-language `prompt` and converted unknown text into a simulated navigation to `example.com`; that was neither a trustworthy browser plan nor an injection-safe execution request.

## Authoritative policy

| Boundary | Policy | Exact blocked outcome |
|---|---|---|
| HTTP egress | Only `https:` destinations are eligible. The URL must not contain credentials, must resolve exclusively to public global addresses, and every redirect target is independently validated before a follow. The transport pins its connection to the validated address. | `unsafe-destination`, `unsafe-redirect`, or `egress-unavailable`; no request is sent after refusal. |
| Browser navigation | The same URL policy evaluates every submitted destination. Real Playwright navigation is unavailable unless a redirect-aware, network-isolated browser egress proxy is configured; the existing test stub remains test-only. | `egress-unavailable`; the Operative task records the refusal. |
| Browser action input | API callers submit typed structured actions only. Natural-language browser planning is unavailable until a real planner can emit an independently reviewed action plan. Injection signatures are rejected before an action task is created. | `prompt-injection`; a tenant-scoped trace records the blocked request. |
| Terminal and workflow commands | Commands must be one simple command with no shell operators, substitution, expansion, redirects, or control operators. Dangerous executables and destructive variants remain denied. Real terminal execution remains unavailable until an isolated tenant/workspace PTY exists. | `shell-metacharacter`, `prompt-injection`, or `disallowed-call`; no process is executed. |
| Package installation | Direct `npm install` is unavailable because npm registry downloads and package scripts do not yet traverse the centralized pinned egress transport. | Exact unavailable result; no dependency is added. |

## DNS and redirect requirements

The URL policy treats a destination as unsafe if it is malformed, non-HTTPS, includes userinfo, is a blocked metadata name, is an IP literal in a non-public range, cannot be resolved, or resolves to **any** non-public address. It handles IPv4, IPv6, IPv4-mapped IPv6, loopback, link-local, RFC1918, carrier-grade NAT, documentation, benchmark, multicast, reserved, and unspecified ranges. Mixed public/private DNS answers fail closed.

The HTTP client does not rely on preflight DNS alone. It uses the approved address for the network connection while retaining the hostname for TLS server-name verification. It disables automatic redirects and validates each `Location` target, including relative locations, before following it. This avoids a browser or generic fetch silently traversing from an initially public destination to an internal address.

## Truth and trace contract

Blocked operations are not described as completed. HTTP failures return a redacted policy reason; browser refusals are recorded by the existing Operative task trace; terminal refusals remain existing terminal validation trace results; and rejected untrusted browser instructions create a tenant- and project-scoped trace with a `loop-guard` step and a failed tool result. The policy stores URL host/path metadata only, never credentials, headers, tokens, or response bodies in a refusal record.

## Safe correction adopted during audit

The browser client previously had no reliable mechanism to pin Chromium DNS resolution or to validate every redirect hop. Pretending that a preflight hostname block made real browser egress safe would be misleading. The safer correction is to keep typed action validation and preserve the existing approval and trace flow, while making real Playwright navigation explicitly unavailable pending a network-isolated redirect-aware browser proxy. Test-only stubs do not represent live navigation.

Likewise, arbitrary natural-language browser prompts cannot safely become actions without a real planner and a reviewable policy boundary. P1 rejects them rather than silently routing them to a placeholder destination.

The previously bundled Numbers API skill used an HTTP-only endpoint whose HTTPS certificate does not validate. It was removed rather than retaining a visibly listed capability that the policy must always block.

## Required proof cases

The regression suite must prove rejection of private IPv4 and IPv6 destinations, DNS answers containing any private address, metadata hostnames, forbidden schemes, credentials in URLs, redirect targets to private ranges, shell chaining/substitution/expansion and destructive variants, injected override instructions, and direct action payloads with unsafe destinations. It must also prove that safe policy decisions retain traceable result metadata and never reveal secrets.

## Checked-out definition

For this P1, **checked out** means the policy is applied from every audited egress/execution entry point; adversarial tests prove each refusal; no refusal produces simulated success; both complete server and application gates pass; protected assets remain untouched; the reviewed commit is pushed; and local `main` equals `origin/main`.
