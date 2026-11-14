import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(import.meta.url);
const expiryMs = 8_000;

/** Bounds fixture waits independently of process inspection availability. */
function bounded(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), expiryMs + 2_000);
  })]).finally(() => clearTimeout(timer));
}

/** Owns a detached fixture through an inherited pipe before any fallible global inspection. */
export function startOrphanFixture() {
  const nonce = randomUUID();
  const parent = spawn(process.execPath, [entry, 'parent', nonce], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const control = parent.stdio[3];
  let childPid;
  let pipeError;
  let closing;
  let eof = false;
  const parentExit = new Promise((resolve) => {
    parent.on('error', (error) => { pipeError = error; resolve({ code: null, signal: null }); });
    parent.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const ended = new Promise((resolve) => {
    control.once('end', () => { eof = true; resolve(); });
    control.on('error', (error) => { pipeError = error; });
  });
  const ready = bounded(new Promise((resolve, reject) => {
    let buffered = '';
    control.setEncoding('utf8');
    control.on('data', (data) => {
      buffered += data;
      if (!buffered.includes('\n')) return;
      try {
        const message = JSON.parse(buffered.slice(0, buffered.indexOf('\n')));
        if (message.nonce !== nonce || !Number.isSafeInteger(message.pid) || message.pid <= 0) throw new Error('Invalid fixture ownership handshake');
        childPid = message.pid;
        resolve({ pid: childPid });
      } catch (error) { reject(error); }
    });
    control.once('end', () => { if (childPid === undefined) reject(new Error('Fixture ended before ownership handshake')); });
    parent.once('error', reject);
  }), 'Fixture ownership handshake timed out');
  // Cleanup can run before the caller starts awaiting ready.
  void ready.catch(() => {});
  return {
    ready,
    parentExit,
    /** Waits for both fixture writers to exit, including the child's independent expiry path. */
    waitForExit() { return bounded(Promise.all([parentExit, ended]), 'Fixture exit unconfirmed'); },
    /** Stops only the process holding our inherited pipe; never sends a PID-based signal. */
    close() {
      if (closing) return closing;
      closing = (async () => {
        if (!control.destroyed && !control.writableEnded) control.end('stop\n');
        const parentResult = await bounded(parentExit, 'Fixture parent exit unconfirmed');
        await bounded(ended, 'Fixture child pipe EOF unconfirmed');
        const result = { status: 'confirmed', childPid, controlEof: eof, parentExit: parentResult, ownership: 'inherited-pipe', expiryMs };
        if (childPid === undefined || pipeError || parentResult.code !== 0 || !eof) {
          const error = new Error('Fixture cleanup is unknown', { cause: pipeError });
          error.cleanup = { ...result, status: 'unknown', error: pipeError?.message };
          throw error;
        }
        return result;
      })();
      return closing;
    },
  };
}

/** Always tears down the owned fixture, retaining the original failure if cleanup or receipt writing also fails. */
export async function withOrphanFixture(run, { createFixture = startOrphanFixture, onCleanup = () => {} } = {}) {
  const fixture = createFixture();
  let primary;
  let hasPrimary = false;
  let value;
  const secondary = [];
  let cleanup = { status: 'unknown', reason: 'cleanup not yet confirmed' };
  try { value = await run(await fixture.ready, fixture); }
  catch (error) { primary = error; hasPrimary = true; }
  try { cleanup = await fixture.close(); }
  catch (error) { cleanup = error.cleanup ?? { status: 'unknown', error: error.message }; secondary.push(error); }
  try { await onCleanup(cleanup); }
  catch (error) { secondary.push(error); }
  if (secondary.length) {
    throw new AggregateError([...(hasPrimary ? [primary] : []), ...secondary], 'Fixture work or cleanup failed', { cause: hasPrimary ? primary : secondary[0] });
  }
  if (hasPrimary) throw primary;
  return value;
}

if (process.argv[1] === entry && process.argv[2] === 'parent') {
  const child = spawn(process.execPath, [entry, 'child', process.argv[3]], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 3] });
  child.on('error', () => process.exit(1));
  child.unref();
  setTimeout(() => process.exit(0), 800);
} else if (process.argv[1] === entry && process.argv[2] === 'child') {
  // The child never closes this pipe except by process.exit; EOF after the parent exits proves both writers exited.
  const control = new Socket({ fd: 3, readable: true, writable: true, allowHalfOpen: true });
  setTimeout(() => process.exit(0), expiryMs);
  control.on('data', () => process.exit(0));
  control.on('end', () => process.exit(0));
  control.on('error', () => process.exit(0));
  control.write(JSON.stringify({ nonce: process.argv[3], pid: process.pid }) + '\n');
}
