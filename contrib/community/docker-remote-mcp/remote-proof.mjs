import assert from 'node:assert/strict';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connect, invoke } from './client.mjs';

const url = process.env.MCP_URL;
const container = process.env.MCP_PROOF_CONTAINER;
const token = JSON.parse(process.env.MCP_TOKENS ?? '{}').alice;
const output = process.env.PROOF_OUTPUT ?? 'proof-output/remote';
assert.ok(url && container && token, 'Set MCP_URL, MCP_PROOF_CONTAINER and synthetic MCP_TOKENS for your own local proof container');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads identities inside the explicit proof container, never from another container or host tree. */
function inspect(captured = [], appUrl) {
  const code = `import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {ownedProcesses,survivingProcesses} from '/opt/companion/process-proof.mjs';
const input=JSON.parse(readFileSync(0,'utf8'));
const rows=execFileSync('ps',['-A','-o','pid=,ppid='],{encoding:'utf8'}).trim().split('\\n').map(line=>line.trim().split(/\\s+/).map(Number));
const bridge=rows.find(([,ppid])=>ppid===1)?.[0];
if(!bridge) throw new Error('Expected the bridge under this proof container init');
const appPortClosed=input.appUrl ? await fetch(input.appUrl).then(()=>false,()=>true) : undefined;
console.log(JSON.stringify({bridge,owned:ownedProcesses(bridge),survivors:survivingProcesses(input.captured),appPortClosed}));`;
  return JSON.parse(execFileSync('docker', ['exec', '-i', container, 'node', '--input-type=module', '-e', code], { input: JSON.stringify({ captured, appUrl }), encoding: 'utf8' }));
}

/** Polls the observed remote identity state with a deadline shorter than the tool timeout. */
async function eventually(condition, label, limit = 5_000) {
  const end = Date.now() + limit;
  while (Date.now() < end) { if (await condition()) return; await sleep(100); }
  assert.fail(label);
}

await mkdir(output, { recursive: true });
let connection;
let raw;
let captured = [];
const sockets = [];
const result = {};
try {
  assert.equal(inspect().owned.length, 0, 'proof requires its own idle service container');
  connection = await connect(url, token);
  const opened = await invoke(connection, 'open_session');
  const appUrl = /App: (http:\/\/127\.0\.0\.1:\d+)\//.exec(opened)?.[1];
  assert.ok(appUrl, opened);
  const id = connection.transport.sessionId;
  const version = connection.transport.protocolVersion;
  const browserBefore = inspect().owned;
  await connection.client.close();
  await sleep(100);
  const headers = { Authorization: 'Bearer ' + token, Accept: 'text/event-stream', 'Mcp-Session-Id': id, 'Mcp-Protocol-Version': version };
  const statuses = [];
  for (let i = 0; i < 3; i += 1) {
    let socket;
    const response = await new Promise((resolve, reject) => {
      socket = request(url, { headers }, resolve);
      sockets.push(socket);
      socket.on('error', reject);
      socket.end();
    });
    statuses.push(response.statusCode);
    assert.equal(response.statusCode, 200);
    response.resume();
    socket.destroy();
    await sleep(100);
  }
  connection = await connect(url, token, id, version);
  assert.match(await invoke(connection, 'call', { tool: 'observe' }), /Synthetic citizen desk/);
  assert.deepEqual(inspect(browserBefore).survivors, browserBefore, 'same captured browser identities survive SSE reconnect');
  result.sse = { statuses, sameSession: connection.transport.sessionId === id, preservedBrowserIdentities: browserBefore };
  const beforeRun = inspect().owned;
  const oldPids = new Set(beforeRun.map((row) => row.pid));
  raw = request(url, { method: 'POST', headers: { ...headers, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' } });
  raw.on('error', () => {});
  raw.on('response', (response) => response.resume());
  raw.end(JSON.stringify({ jsonrpc: '2.0', id: 719, method: 'tools/call', params: { name: 'run_tests', arguments: { files: ['tests/slow.e2e.ts'] } } }));
  await eventually(() => inspect().owned.some((row) => !oldPids.has(row.pid) && /chrome|chromium/i.test(row.name)), 'runner must start another real browser', 10_000);
  captured = inspect().owned;
  const disconnectedAt = Date.now();
  raw.destroy();
  await eventually(() => inspect(captured).survivors.length === 0, 'all captured identities must exit before the 30-second tool deadline');
  const response = await fetch(url, { method: 'POST', headers: { ...headers, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 720, method: 'tools/list' }) });
  assert.equal(response.status, 404);
  await response.text();
  const final = inspect(captured, appUrl);
  assert.equal(final.owned.length, 0);
  assert.equal(final.appPortClosed, true);
  result.disconnect = { elapsedAfterDisconnectMs: Date.now() - disconnectedAt, toolDeadlineMs: 30_000, sessionStatus: response.status, captured, ...final };
  console.log(JSON.stringify({ sseStatuses: statuses, sessionStatus: response.status, elapsedAfterDisconnectMs: result.disconnect.elapsedAfterDisconnectMs, survivors: final.survivors, appPortClosed: true }));
} finally {
  for (const socket of sockets) socket.destroy();
  raw?.destroy();
  await connection?.transport.terminateSession().catch(() => {});
  await connection?.client.close();
  result.cleanup = inspect(captured);
  await writeFile(path.join(output, 'remote-lifecycle.json'), JSON.stringify(result, null, 2));
  assert.equal(result.cleanup.survivors.length, 0);
  assert.equal(result.cleanup.owned.length, 0);
}
