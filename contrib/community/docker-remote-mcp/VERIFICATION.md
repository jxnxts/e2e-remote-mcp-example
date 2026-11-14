# Verification receipt

Reverified locally on 2026-11-13 after independent review of candidate
`8c438f4348e0a237f0876e88986b7c5a3057fc7f`. Base remains
`e167149af1d390492af09e5fe28bb64072e9df64`. No upstream API changes, remote
deployment, issue comments, PRs, approvals or merges were made.

The review reproduced three gaps in the initial receipt: closing a POST
socket did not cancel the runner without an MCP notification; a disconnected
GET left its SSE channel reserved; and the cleanup test could overlook a
live reparented process. The original logs remain preserved, but their cleanup
claims were insufficient for these cases. Both HTTP regressions fail against
the original bridge and pass with the fixes; the orphan fixture demonstrates
why the old verifier was insufficient.

| Prior runtime checks at 0fad116f | Observed result |
| --- | --- |
| Host, Node 24.22.2 and published e2e 0.23.1 | 4/4 tests passed with real Chromium |
| Host, same tests with this checkout's built e2e CLI | 4/4 passed |
| New Linux arm64 image | `sha256:20ca3add844dd3e7e10b50645acace375c156a2beb385a1ea1ef079c2cc06ec5` |
| Full suite inside that image under init | 4/4 passed, container exit 0, no OOM |
| Full suite under Compose limits | 4/4 passed, container exit 0, no OOM |
| Host SDK clients against the published localhost Compose port | Two clients, same-session reconnect, ownership refusal, runner exit 0 and actual report/PNG |
| Raw host HTTP sockets against that Compose service | Three GET reconnects returned 200; disconnecting a running POST invalidated the session and removed captured runner/browser identities in 541 ms, before its 30-second deadline |
| Host raw POST regression | Cleanup in 153 ms, session 404, before the 20-second deadline |
| Docker and Compose raw POST regressions | Cleanup in 330 ms and 240 ms respectively, session 404, before the 20-second deadline |
| Cleanup verifier | Detects a live reparented fixture, rejects a different identity for the same PID, confirms fixture reaping |
| Existing lifecycle proof | Explicit cancellation, DELETE, idle and shutdown leave no captured identities in the global process table; synthetic app ports close |
| Source/image consistency | Ten runtime, proof and fixture SHA256 values match the tested image |
| Companion oxlint and diff whitespace | Passed |
| Final PNGs | Visually inspected for both host paths, Docker, Compose suite and Compose host probe |

The process verifier discovers children in the owned tree, captures PID and
start identity, then checks them globally without depending on current PPID.
Linux uses `/proc` start ticks and macOS uses the POSIX start timestamp.
Checks do not kill processes. The corrected orphan fixture uses a private
inherited pipe and an eight-second self-expiry, with no PID-based signals.

The re-review of `0fad116f` found that a denied inspection after spawning
the orphan fixture could leak its child and incorrectly record an empty
survivor array. That unsafe fixture was not repeated. The coordinator had
already cleaned its one identified process before this revision.
The new fixture owns its child before inspection, confirms controlled exit
through pipe EOF after parent exit, and records global inspection as unknown
when unavailable. Original errors are retained if cleanup or receipts also fail.

Focused revalidation for this fixture-only revision:

- Host: four fixture tests passed, covering reparenting, denial injected after
  spawn, cleanup/receipt error aggregation, and independent eight-second expiry.
- Protected red: reinstating the old skip-cleanup policy made the new regression
  fail; an outer pipe safeguard still confirmed child exit. This used a bounded
  reconstruction of the failure path, not the old unbounded fixture.
- Docker and Compose: the same four focused tests passed, with container exit 0
  in both environments. Tested Linux arm64 image
  `sha256:21d0cf002aed72f5a1d7898612570efac1b4751496f588b494f3eccf4c248014`
  incorporates the corrected fixture; all eleven runtime/proof source hashes
  are checked in `.contribution-evidence/revision3/`.

The bridge, clients, process inspector and public API did not change in this
revision. Prior browser/runtime checks above remain historical; monorepo gates
and unchanged runtime scenarios were not repeated by routine.

The full root `pnpm check` passed on the initial candidate. It was not
repeated for this companion-only revision: no core runtime, TypeScript
contract, dependency pin, schema, registry, root configuration or docs-site
page changed. Current evidence is the focused lint, real HTTP/browser tests,
Docker build and Compose probes above. Full root `pnpm test` was not run.

The proof uses synthetic data and deterministic actions, with no model calls.
macOS arm64 and Linux arm64 were exercised; amd64, Windows, TLS/OAuth,
hostile project isolation, multi-tenant security, restart persistence and
in-flight replay remain unverified. Static Bearer tokens and in-memory
sessions remain experimental. Containers and published ports were removed;
local artifact volumes and images are retained for review.

Run [proof.test.mjs](proof.test.mjs), [lifecycle.test.mjs](lifecycle.test.mjs),
[probe.mjs](probe.mjs) and [remote-proof.mjs](remote-proof.mjs) using
[README.md](README.md). Original receipts stay in `.contribution-evidence/`;
the runtime-fix review, red/green runs, source hashes, reports and screenshots
are preserved separately in `.contribution-evidence/revision2/`. This fixture
correction and its focused receipts are in `.contribution-evidence/revision3/`
for another independent review. No upstream readiness label or approval is implied.
