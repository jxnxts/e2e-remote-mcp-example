import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBridge } from './bridge.mjs';
import { connect, invoke } from './client.mjs';
import { ownedProcesses, survivingProcesses } from './process-proof.mjs';
import { startOrphanFixture, withOrphanFixture } from './orphan-fixture.mjs';

const token = 'review-synthetic-000000000000000000000000';
const output = process.env.PROOF_OUTPUT ?? 'proof-output';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls a condition with a strict deadline, retaining assertion failures as test failures. */
async function eventually(condition, label, limit = 5_000) {
  const end = Date.now() + limit;
  while (Date.now() < end) { if (await condition()) return; await sleep(50); }
  assert.fail(label);
}

/** Persists observations separately from the original independent review receipts. */
async function receipt(name, value) {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, name + '.json'), JSON.stringify(value, null, 2));
}

/** Opens a real SSE socket and resolves after the server's headers, with no cancellation notification. */
function getStream(url, headers) {
  let socket;
  const response = new Promise((resolve, reject) => {
    socket = request(url, { method: 'GET', headers }, resolve);
    socket.on('error', reject);
    socket.end();
  });
  return { socket, response };
}

test('socket disconnect interrupts the real runner before the tool deadline without MCP cancellation', { timeout: 30_000 }, async () => {
  const events = [];
  const bridge = await startBridge({ tokens: { review: token }, stateDir: path.resolve(output, 'disconnect-state'), callMs: 20_000, audit: (event) => events.push(event) });
  let connection;
  let raw;
  let captured = [];
  const observed = {};
  try {
    connection = await connect(bridge.url, token);
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': connection.transport.sessionId, 'Mcp-Protocol-Version': connection.transport.protocolVersion };
    raw = request(bridge.url, { method: 'POST', headers });
    raw.on('error', () => {});
    raw.on('response', (response) => response.resume());
    raw.end(JSON.stringify({ jsonrpc: '2.0', id: 719, method: 'tools/call', params: { name: 'run_tests', arguments: { files: ['tests/slow.e2e.ts'] } } }));
    await eventually(() => ownedProcesses().some((row) => /chrome|chromium/i.test(row.name)), 'real runner browser must start', 10_000);
    captured = ownedProcesses();
    const stdio = events.find((event) => event.event === 'started');
    assert.ok(captured.some((row) => row.ppid === stdio.pid), 'real runner is a child of the stdio server');
    const disconnectedAt = Date.now();
    raw.destroy();
    await eventually(() => events.some((event) => event.event === 'closed'), 'execution must close within 5 seconds of disconnect');
    await eventually(() => survivingProcesses(captured).length === 0, 'captured runner/browser identities must be globally absent');
    const response = await fetch(bridge.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 720, method: 'tools/list' }) });
    assert.equal(response.status, 404);
    await response.text();
    await assert.rejects(fetch(stdio.appUrl));
    Object.assign(observed, { elapsedAfterDisconnectMs: Date.now() - disconnectedAt, toolDeadlineMs: 20_000, sessionStatus: response.status, captured, survivors: survivingProcesses(captured), appPortClosed: true });
  } finally {
    raw?.destroy();
    await bridge.close();
    await connection?.client.close();
    await receipt('disconnect', { ...observed, events, survivorsAfterShutdown: survivingProcesses(captured) });
  }
});

test('GET SSE can disconnect and reconnect repeatedly without retiring the browser execution', { timeout: 30_000 }, async () => {
  const events = [];
  const bridge = await startBridge({ tokens: { review: token }, stateDir: path.resolve(output, 'sse-state'), audit: (event) => events.push(event) });
  let connection;
  const sockets = [];
  let captured = [];
  const statuses = [];
  try {
    connection = await connect(bridge.url, token);
    await invoke(connection, 'open_session');
    const observation = await invoke(connection, 'call', { tool: 'observe' });
    const textbox = /#(n\d+).*textbox "Request"/.exec(observation)?.[1];
    assert.ok(textbox, observation);
    await invoke(connection, 'call', { tool: 'type', args: { target: textbox, value: 'SSE preserved 42' } });
    // The SDK client owns an automatic GET stream; disconnect it before testing raw SSE sockets.
    const id = connection.transport.sessionId;
    const protocol = connection.transport.protocolVersion;
    await connection.client.close();
    await sleep(100);
    const headers = { Authorization: 'Bearer ' + token, Accept: 'text/event-stream', 'Mcp-Session-Id': id, 'Mcp-Protocol-Version': protocol };
    captured = ownedProcesses();
    for (let i = 0; i < 3; i += 1) {
      const stream = getStream(bridge.url, headers);
      sockets.push(stream.socket);
      const response = await stream.response;
      statuses.push(response.statusCode);
      assert.equal(response.statusCode, 200);
      response.resume();
      stream.socket.destroy();
      await sleep(100);
    }
    const resumed = await connect(bridge.url, token, id, protocol);
    connection = resumed;
    assert.match(await invoke(resumed, 'call', { tool: 'observe' }), /SSE preserved 42/);
    assert.equal(events.filter((event) => event.event === 'started').length, 1);
    assert.equal(events.filter((event) => event.event === 'closed').length, 0);
    await resumed.transport.terminateSession();
    await eventually(() => survivingProcesses(captured).length === 0, 'SSE browser identities must be globally absent after DELETE');
  } finally {
    for (const socket of sockets) socket.destroy();
    await bridge.close();
    await connection?.client.close();
    for (const event of events.filter((entry) => entry.event === 'started')) await assert.rejects(fetch(event.appUrl));
    await receipt('sse', { statuses, events, captured, survivors: survivingProcesses(captured), appPortsClosed: true });
  }
});

test('orphan fixture: cleanup verifier detects reparenting and another identity', { timeout: 15_000 }, async () => {
  let captured;
  const observed = {};
  // Respect inspection restrictions before creating any process; the failure-injection test also covers a later denial.
  try {
    ownedProcesses();
  } catch (error) {
    try { await receipt('orphan', { globalInspection: { status: 'unavailable', error: error.message }, cleanup: { status: 'not-created' } }); }
    catch (receiptError) {
      const combined = new AggregateError([error, receiptError], 'Inspection and receipt failed', { cause: error });
      throw combined;
    }
    throw error;
  }
  await withOrphanFixture(async ({ pid }, fixture) => {
    captured = ownedProcesses().find((row) => row.pid === pid);
    assert.ok(captured);
    await fixture.parentExit;
    await eventually(() => !ownedProcesses().some((row) => row.pid === pid), 'fixture child must be reparented');
    const survivors = survivingProcesses([captured]);
    assert.equal(survivors.length, 1, 'reparenting must not count as process exit');
    assert.equal(survivingProcesses([{ ...captured, identity: 'another-process' }]).length, 0, 'reused PID with another identity must not count as the owned process');
    Object.assign(observed, { captured, oldDescendantsPredicateWouldPass: true, survivingOwnedIdentities: survivors });
  }, { onCleanup: async (cleanup) => {
    const globalInspection = { status: 'unknown' };
    const failures = [];
    try {
      if (captured) {
        await eventually(() => survivingProcesses([captured]).length === 0, 'owned orphan fixture must be reaped');
        Object.assign(globalInspection, { status: 'confirmed', survivors: survivingProcesses([captured]) });
      }
    } catch (error) {
      Object.assign(globalInspection, { status: 'unavailable', error: error.message });
      failures.push(error);
    }
    try { await receipt('orphan', { ...observed, cleanup, globalInspection }); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Inspection or receipt failed', { cause: failures[0] });
  } });
});

test('orphan fixture: inspection denial after spawn preserves the failure and confirms child exit without ps', { timeout: 15_000 }, async () => {
  const denial = Object.assign(new Error('spawnSync ps EPERM (injected after spawn)'), { code: 'EPERM' });
  let owned;
  let child;
  let cleanup;
  let inspectionCalls = 0;
  const inspect = () => { inspectionCalls += 1; throw denial; };
  const failures = [];
  try {
    await assert.rejects(withOrphanFixture(async (ready) => {
      child = ready;
      assert.ok(child.pid, 'child ownership is established before inspection can fail');
      inspect();
    }, {
      createFixture: () => { owned = startOrphanFixture(); return owned; },
      onCleanup: (result) => { cleanup = result; },
    }), (error) => error === denial);
    assert.equal(cleanup.status, 'confirmed');
    assert.equal(cleanup.childPid, child.pid);
    assert.equal(cleanup.controlEof, true);
    assert.equal(cleanup.parentExit.code, 0);
    assert.equal(inspectionCalls, 1);
  } catch (error) { failures.push(error); }
  // Also contains a protected reproduction of the old skip-cleanup policy during the red regression.
  let safeguard;
  try { safeguard = await owned?.close(); }
  catch (error) { failures.push(error); }
  try { await receipt('orphan-inspection-denied', { originalFailure: { message: denial.message, code: denial.code }, child, cleanup, safeguard, inspectionCalls, globalInspection: { status: 'unavailable', reason: 'injected inspection denial; no global query attempted' } }); }
  catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Regression or safeguard failed', { cause: failures[0] });
});

test('orphan fixture: cleanup and receipt failures retain the original cause', { timeout: 15_000 }, async () => {
  const original = new Error('injected inspection failure');
  const cleanupFailure = new Error('injected cleanup reporting failure');
  const receiptFailure = new Error('injected receipt failure');
  let owned;
  let confirmed;
  let observed;
  const failures = [];
  try {
    await assert.rejects(withOrphanFixture(async () => { throw original; }, {
      createFixture: () => {
        owned = startOrphanFixture();
        return { ready: owned.ready, close: async () => { confirmed = await owned.close(); throw cleanupFailure; } };
      },
      onCleanup: (cleanup) => { observed = cleanup; throw receiptFailure; },
    }), (error) => error instanceof AggregateError && error.cause === original && error.errors[0] === original && error.errors[1] === cleanupFailure && error.errors[2] === receiptFailure);
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(observed.status, 'unknown');
  } catch (error) { failures.push(error); }
  let safeguard;
  try { safeguard = await owned?.close(); }
  catch (error) { failures.push(error); }
  try { await receipt('orphan-secondary-failures', { originalFailure: original.message, cleanupFailure: cleanupFailure.message, receiptFailure: receiptFailure.message, cleanup: observed, controlledExit: confirmed, safeguard }); }
  catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Regression or safeguard failed', { cause: failures[0] });
});

test('orphan fixture: independent expiry exits the child without inspection or a shutdown message', { timeout: 15_000 }, async () => {
  let child;
  await withOrphanFixture(async (ready, fixture) => {
    child = ready;
    await fixture.waitForExit();
  }, { onCleanup: (cleanup) => receipt('orphan-expiry', { child, cleanup, globalInspection: { status: 'not-requested' } }) });
});
