import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from './bridge.mjs';
import { connect, invoke } from './client.mjs';
import { ownedProcesses as descendants, survivingProcesses } from './process-proof.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
// Public synthetic credentials used only on ephemeral localhost proof servers.
const tokens = { alice: 'synthetic-alice-000000000000000000000000', bob: 'synthetic-bob-000000000000000000000000' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls observable resource state rather than assuming a delay proves cleanup. */
async function eventually(predicate, label, limit = 15_000) {
  const end = Date.now() + limit;
  while (Date.now() < end) { if (await predicate()) return; await sleep(100); }
  assert.fail('Timed out: ' + label);
}

/** Extracts the current engine node for a deterministic interaction. */
function node(text, role, name) {
  const line = text.split('\n').find((l) => l.includes(role + ' "' + name + '"'));
  const id = /#(n\d+)/.exec(line ?? '')?.[1];
  assert.ok(id, text);
  return id;
}

test('real stdio tools over SDK HTTP: isolation, resume, runner, cancellation, expiry and shutdown', { timeout: 180_000 }, async () => {
  const output = process.env.PROOF_OUTPUT ?? path.join(root, 'proof-output');
  await mkdir(output, { recursive: true });
  const events = [];
  const bridge = await startBridge({ tokens, stateDir: path.join(output, 'state'), audit: (e) => events.push(e) });
  const connections = [];
  const connectOwned = async (...args) => { const c = await connect(...args); connections.push(c); return c; };
  const headers = { Authorization: 'Bearer ' + tokens.bob, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const result = {};
  try {
    assert.equal((await fetch(bridge.url)).status, 401);
    assert.equal((await fetch(bridge.url, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(bridge.url, { method: 'POST', headers, body: 'x'.repeat(65_537) })).status, 413);
    await assert.rejects(startBridge({ tokens: {} }), /tokens/);
    await assert.rejects(startBridge({ tokens, host: '0.0.0.0' }), /Non-loopback/);

    const [alice, bob] = await Promise.all([connectOwned(bridge.url, tokens.alice), connectOwned(bridge.url, tokens.bob)]);
    const opened = await Promise.all([invoke(alice, 'open_session'), invoke(bob, 'open_session')]);
    await writeFile(path.join(output, 'opened.txt'), opened.join('\n\n'));
    const started = events.filter((e) => e.event === 'started');
    assert.equal(started.length, 2);
    assert.notEqual(started[0].pid, started[1].pid);
    assert.notEqual(started[0].folder, started[1].folder);
    const foreignBrowserSession = /^Session (\S+) open/.exec(opened[0])[1];
    await assert.rejects(invoke(bob, 'call', { session: foreignBrowserSession, tool: 'observe' }), /session/i);
    const firstProcesses = descendants();
    assert.ok(firstProcesses.filter((p) => /chrome|chromium/i.test(p.name)).length >= 2, JSON.stringify(firstProcesses));
    let observation = await invoke(alice, 'call', { tool: 'observe' });
    await invoke(alice, 'call', { tool: 'type', args: { target: node(observation, 'textbox', 'Request'), value: 'Alice only 42' } });
    observation = await invoke(alice, 'call', { tool: 'observe' });
    await invoke(alice, 'call', { tool: 'tap', args: { target: node(observation, 'button', 'Submit') } });
    assert.match(await invoke(alice, 'call', { tool: 'observe' }), /Received: Alice only 42/);
    assert.doesNotMatch(await invoke(bob, 'call', { tool: 'observe' }), /Alice only 42/);

    const alien = await fetch(bridge.url, { method: 'POST', headers: { ...headers, 'Mcp-Session-Id': alice.transport.sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }) });
    assert.equal(alien.status, 404);
    const sessionId = alice.transport.sessionId;
    const protocolVersion = alice.transport.protocolVersion;
    await alice.client.close();
    const resumed = await connectOwned(bridge.url, tokens.alice, sessionId, protocolVersion);
    assert.equal(resumed.transport.sessionId, sessionId);
    assert.match(await invoke(resumed, 'call', { tool: 'observe' }), /Received: Alice only 42/);
    assert.equal(events.filter((e) => e.event === 'started').length, 2);
    result.isolationAndResume = { separateProcesses: true, browserStateIndependent: true, alienSessionStatus: alien.status, sameHttpSession: true };

    await assert.rejects(invoke(bob, 'open_session', { config: '/tmp/forbidden' }), /validation|unrecognized/i);
    await assert.rejects(invoke(bob, 'call', { tool: 'run_code', args: {} }), /validation|invalid/i);
    await assert.rejects(invoke(bob, 'run_tests', { files: ['../../outside.ts'] }), /validation|invalid/i);
    const runText = await invoke(bob, 'run_tests');
    await writeFile(path.join(output, 'run-tests.txt'), runText);
    assert.match(runText, /exit 0/);
    const listed = await bob.client.listResources();
    const reportResource = listed.resources.find((r) => r.name === 'report.json');
    assert.ok(reportResource, JSON.stringify(listed));
    const report = await bob.client.readResource({ uri: reportResource.uri });
    await writeFile(path.join(output, 'report.json'), report.contents[0].text);
    const reportJson = JSON.parse(report.contents[0].text);
    assert.equal(reportJson.schemaVersion, 'report-1');
    assert.equal(reportJson.run.status, 'passed');
    assert.equal(reportJson.run.exitCode, 0);
    const screenshots = listed.resources.filter((r) => r.mimeType === 'image/png');
    assert.ok(screenshots.length > 0, JSON.stringify(listed));
    const screenshot = await bob.client.readResource({ uri: screenshots[0].uri });
    await writeFile(path.join(output, 'submitted.png'), Buffer.from(screenshot.contents[0].blob, 'base64'));
    await assert.rejects(resumed.client.readResource({ uri: reportResource.uri }), /not available/i);
    result.runTests = { exit: 0, resourceNames: listed.resources.map((r) => r.name), screenshotBytes: Buffer.from(screenshot.contents[0].blob, 'base64').length };

    // Wait until the slow runner has spawned before sending the MCP cancellation notification.
    const beforeSlowPids = new Set(descendants().map((p) => p.pid));
    const cancel = new AbortController();
    const slow = invoke(bob, 'run_tests', { files: ['tests/slow.e2e.ts'] }, { signal: cancel.signal });
    const rejected = assert.rejects(slow);
    await eventually(() => descendants().some((p) => !beforeSlowPids.has(p.pid)), 'runner child started');
    const beforeCancel = descendants();
    cancel.abort();
    await rejected;
    await eventually(() => events.some((e) => e.event === 'closed' && e.reason === 'cancel-or-timeout'), 'cancel teardown');
    assert.equal((await fetch(bridge.url, { headers: { ...headers, 'Mcp-Session-Id': bob.transport.sessionId } })).status, 404);
    await invoke(resumed, 'close_session');
    await resumed.transport.terminateSession();
    await eventually(() => events.filter((e) => e.event === 'closed').length === 2, 'explicit DELETE teardown');
    await eventually(() => survivingProcesses(beforeCancel).length === 0, 'all captured browser and runner identities globally gone');
    for (const e of started) await assert.rejects(fetch(e.appUrl));
    result.cleanup = { originalProcessIds: beforeCancel.map((p) => p.pid), capturedIdentities: beforeCancel, survivors: survivingProcesses(beforeCancel), allGone: true, appPortsClosed: true };
    const active = await connectOwned(bridge.url, tokens.alice);
    await invoke(active, 'open_session');
    const beforeShutdown = descendants();
    await bridge.close();
    await eventually(() => survivingProcesses(beforeShutdown).length === 0, 'shutdown process identities globally gone');
    await assert.rejects(fetch(bridge.url));
    result.shutdown = { capturedIdentities: beforeShutdown, survivors: survivingProcesses(beforeShutdown), activeBrowserReleased: true, listenerClosed: true };
  } finally {
    await bridge.close().catch(() => {});
    await Promise.all(connections.map((c) => c.client.close().catch(() => {})));
    await writeFile(path.join(output, 'events.json'), JSON.stringify(events, null, 2));
    await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  }

  const idleEvents = [];
  const idle = await startBridge({ tokens, idleMs: 2_000, stateDir: path.join(output, 'idle-state'), audit: (e) => idleEvents.push(e) });
  let idleClient;
  try {
    idleClient = await connect(idle.url, tokens.alice);
    await invoke(idleClient, 'open_session');
    const idleProcesses = descendants();
    await eventually(() => idleEvents.some((e) => e.event === 'closed' && e.reason === 'expiry'), 'idle expiry');
    await eventually(() => survivingProcesses(idleProcesses).length === 0, 'idle browser identities globally gone');
    for (const entry of idleEvents.filter((event) => event.event === 'started')) await assert.rejects(fetch(entry.appUrl));
    result.idle = { capturedIdentities: idleProcesses, survivors: survivingProcesses(idleProcesses), browserReleased: true, appPortClosed: true };
  } finally {
    await idle.close();
    await idleClient?.client.close();
    await writeFile(path.join(output, 'idle-events.json'), JSON.stringify(idleEvents, null, 2));
    await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  }
});
