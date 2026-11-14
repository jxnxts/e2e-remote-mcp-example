# Experimental remote MCP companion

This community experiment adapts the official MCP SDK's Streamable HTTP
transport to the existing `e2e mcp` stdio server. It is not an official e2e
transport, image, or deployment recommendation. It changes no e2e API and adds
no runner. `run_tests` calls the public tool and returns its result unchanged.

Use synthetic data only. The bundled citizen desk has no backend or model.
No model keys, paid inference, host project mounts, HOME mounts, or Docker
socket are needed. All code here is Apache-2.0.

## Run

Requires Node 24.8 or later and Docker Compose v2 for the container path.
Dependencies are pinned in `package-lock.json`, including e2e 0.23.1, web
0.16.0, MCP client/server 2.4.0 and Playwright 1.65.0.

```sh
cd contrib/community/docker-remote-mcp
npm ci --ignore-scripts
# Creates separate random local test credentials without writing an env file.
export MCP_TOKENS="$(node -e 'console.log(JSON.stringify({alice:require("node:crypto").randomBytes(32).toString("hex"),bob:require("node:crypto").randomBytes(32).toString("hex")}))')"
docker compose --env-file /dev/null up --build -d
```

Connect to `http://127.0.0.1:3100/mcp` using an MCP Streamable HTTP client
and a Bearer token from the operator's `MCP_TOKENS` JSON map. The server
refuses startup without distinct tokens of at least 32 characters. Tokens
identify principals. Treat them as credentials; don't publish rendered
Compose output with real tokens.

The Compose service binds inside its container on all interfaces, explicitly
enabled by `MCP_ALLOW_REMOTE_BIND`, but publishes only on host loopback.
`MCP_PORT=0 docker compose --env-file /dev/null up -d` requests an ephemeral host port; find it
with `docker compose --env-file /dev/null port mcp 3100`. There is no public deployment in this
example. A future remote deployment needs TLS termination, an explicit Host
and Origin allowlist, and an agreed authentication design. The static Bearer
map is an experimental operator configuration, not OAuth discovery.

For a local process instead of Docker, install matching Chromium once,
then run with an explicit browser cache location because each e2e process
receives its own empty HOME:

```sh
node node_modules/playwright-core/cli.js install chromium
PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" npm start
# Linux: use "$HOME/.cache/ms-playwright" instead.
```

## Client calls

`client.mjs` uses the official SDK. For an already running service:

```js
import { connect, invoke } from './client.mjs';
const tokens = JSON.parse(process.env.MCP_TOKENS);
const first = await connect('http://127.0.0.1:3100/mcp', tokens.alice);
const browser = await invoke(first, 'open_session');
console.log(browser); // Contains the e2e browser session and observation.
const id = first.transport.sessionId;
const version = first.transport.protocolVersion;
await first.client.close(); // Disconnects HTTP; keeps the execution alive.
const resumed = await connect('http://127.0.0.1:3100/mcp', tokens.alice, id, version);
console.log(await invoke(resumed, 'call', {tool: 'observe'}));
console.log(await invoke(resumed, 'run_tests')); // The existing runner.
const artifacts = await resumed.client.listResources();
const report = artifacts.resources.find(r => r.name === 'report.json');
console.log(await resumed.client.readResource({uri: report.uri}));
await invoke(resumed, 'close_session');
await resumed.transport.terminateSession(); // MCP HTTP DELETE, closes process.
await resumed.client.close();
```

`tools/list` exposes five tools with restricted schemas. `open_session {}`
uses the bundled config. `call` permits `observe`, `type`, `tap`, and
`screenshot`; `tools {tool}` describes these upstream tools. `run_tests`
defaults to `tests/smoke.e2e.ts` and also accepts the committed
`tests/slow.e2e.ts` cancellation fixture. Config paths, engine packages,
commands, URLs, `run_code`, arbitrary test files and runner flags are
refused. The native `open_session` response includes the upstream catalog;
entries outside this subset remain unavailable through this companion.

## Ownership and lifetime

Each HTTP initialization reserves one execution: one e2e stdio process,
one copy of the trusted project, one app on an ephemeral loopback port,
and at most one live browser session. No browser or report directory is
shared between executions. A principal may own several executions. An
execution ID belongs to its authenticated principal; a different principal
gets the same 404 as an unknown ID. A browser session ID is scoped further
by its owning stdio process, never looked up globally.

Completed calls can reconnect using the same HTTP session ID, protocol
version and principal until expiry. State is in memory; a bridge restart
loses all sessions. This example has no event store, in-flight response
replay, persistence across restart, or exactly-once delivery. Do not retry
an interrupted mutation blindly. Disconnecting an in-flight tool request,
cancelling it, or reaching its deadline retires that entire execution.
A later initialization creates a new browser.

Closing only a GET event stream releases that stream and preserves the
execution. The same client can reopen its SSE channel and continue using
the same browser. Closing the socket of an in-flight POST tool call retires
the execution even when no MCP cancellation notification is sent.

Defaults are four executions globally, one tool call in flight per
execution, 64 KiB HTTP bodies, 30 seconds per tool, 60 seconds idle and
five minutes total lifetime. GET keepalives do not refresh idle time by
themselves; a new HTTP request does. Initialization counts toward the
global limit before spawning a child. Extra initializations get 429.
Idle expiry also closes browsers. `close_session` releases the browser;
HTTP DELETE additionally releases the process and app port. SIGINT and
SIGTERM drain all executions before closing the listener. Failed startup
also tears down allocated resources. Process cleanup follows the SDK's
stdio close behavior, which ends stdin before escalating signals.

Artifacts stay in `state/<random-id>/.e2e`, or the Compose named volume.
Each initialization has its own directory. MCP `resources/list` and
`resources/read` expose that execution's report and files under `results/`
ending in `.json`, `.md`, or `.png`, at most 200 files and 2 MiB per file.
Reads use only listed paths and reject links escaping that directory.
There is no file upload, arbitrary path read, artifact HTTP endpoint, or
automatic disk retention policy. The operator must prune retained files.

## Trust boundary

Projects, test files, engines and tools execute trusted code. The file
allowlist limits this demonstration's inputs; it does not sandbox arbitrary
projects or hostile test code. All executions share one OS user and container.
Container limits are not a demonstrated multi-tenant security boundary.
Chromium's browser isolation proves independent application state here,
not resistance to a compromised browser. Do not use real citizens' data,
credentials, internal hosts or untrusted project uploads in this demo.

The bridge sets PATH, a private HOME, the synthetic app URL, browser cache
location and non-secret CLI flags. The SDK also adds its default safe POSIX
variables such as USER, LOGNAME, SHELL and TERM. It does not inherit model keys.
Host/Origin checks and authentication run before process allocation.

## Verify and stop

```sh
PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" npm test
# Runs the same proof inside the built image, including real Chromium:
docker compose --env-file /dev/null run --rm --no-deps -e PROOF_OUTPUT=/opt/companion/state/proof mcp npm test
MCP_URL=http://127.0.0.1:3100/mcp node probe.mjs
# Requires your own idle example service; inspects process metadata in that container.
MCP_PROOF_CONTAINER="$(docker compose --env-file /dev/null ps -q mcp)" MCP_URL=http://127.0.0.1:3100/mcp node remote-proof.mjs
docker compose --env-file /dev/null down
```

The proof starts its own ephemeral HTTP listener, uses two official SDK
clients and actual browsers, resumes a completed session, refuses foreign
ownership and unsafe inputs, runs `run_tests`, reads its report and PNG,
and checks processes and app ports after cancellation, DELETE, idle expiry
and shutdown. It also drops a raw POST socket without sending MCP cancellation,
reopens the GET SSE channel three times with browser state preserved, and
tests the cleanup verifier against a live reparented child.
It writes `proof-output/` locally; set `PROOF_OUTPUT` to keep receipts elsewhere.
Process discovery starts only in the proof's own tree. Captured PID/start-time
identities are then checked globally, so reparenting cannot count as exit.
Linux uses kernel start ticks; macOS uses the POSIX process start timestamp.
An identity mismatch prevents a reused PID from being treated as the old process.
Cleanup checks do not signal processes; only the dedicated orphan fixture is
stopped through its privately inherited control pipe, which is established
before inspection. That child also exits independently after eight seconds.
Pipe EOF after the parent exits confirms the controlled child's exit even
when global inspection is unavailable. Global inspection remains explicitly
unknown in that case; an absent captured identity never means no survivors.
An inspection error remains the primary failure if cleanup or receipt writing
also fails. The focused fixture tests inject a denial after spawn and exercise
both secondary failures and independent expiry, without querying or signalling
any other process:

```sh
node --test --test-name-pattern='orphan fixture' lifecycle.test.mjs
```

The reparenting check first requires process inspection. If the environment
denies it, that check fails before creating a fixture and records the limitation.
The injected-denial test exercises teardown after creation and needs no global
process query; it does not bypass a denied inspection command.
The test intentionally cancels a waiting assertion; that runner interruption
is expected evidence, while a nonzero `npm test` exit is a failed gate.

`docker compose --env-file /dev/null down` retains artifacts. Remove only this example's named
volume when its evidence is no longer needed. See [VERIFICATION.md](VERIFICATION.md)
for the actual validation scope and known limitations.

## Upstream discussion

[Issue #1100](https://github.com/e2e-inc/e2e/issues/1100) describes the
deployment need. Its statement that MCP has no runner tool is outdated;
[`run_tests`](https://github.com/e2e-inc/e2e/blob/e167149af1d390492af09e5fe28bb64072e9df64/packages/e2e/src/mcp/run-tests.ts)
already exists. Upstream's public MCP transport is stdio.
Any official transport or image requires maintainer agreement first.

Protocol references:
[MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
and [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
