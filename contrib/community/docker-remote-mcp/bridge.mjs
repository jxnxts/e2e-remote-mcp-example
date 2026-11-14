import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, cp, symlink, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { startApp } from './app.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const verbs = ['observe', 'tap', 'type', 'screenshot'];
const text = (message) => ({ content: [{ type: 'text', text: message }] });

/** Rejects missing, duplicate, or weak operator credentials before binding any socket. */
function credentials(tokens) {
  const entries = Object.entries(tokens ?? {});
  if (!entries.length || entries.some(([name, token]) => !name || typeof token !== 'string' || token.length < 32)) throw new Error('Provide distinct tokens of at least 32 characters');
  if (new Set(entries.map(([, token]) => token)).size !== entries.length) throw new Error('Tokens must identify distinct principals');
  return entries;
}

/** Starts the experimental SDK Streamable HTTP to public e2e stdio companion. */
export async function startBridge({ tokens, host = '127.0.0.1', port = 0, allowRemoteBind = false,
  allowedHosts = ['localhost', '127.0.0.1'], allowedOrigins = [],
  stateDir = path.join(root, 'state'), idleMs = 60_000, lifetimeMs = 300_000,
  callMs = 30_000, maxExecutions = 4, audit = () => {} } = {}) {
  const principals = credentials(tokens);
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !allowRemoteBind) throw new Error('Non-loopback bind requires explicit allowRemoteBind');
  if (![idleMs, lifetimeMs, callMs, maxExecutions].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('Limits must be positive integers');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const executions = new Map();
  const all = new Set();
  let stopping = false;

  /** Closes one execution once; a disconnected HTTP socket alone does not retire it. */
  function retire(execution, reason) {
    if (execution.closing) return execution.closing;
    execution.closed = true;
    executions.delete(execution.id);
    execution.closing = Promise.resolve().then(async () => {
      execution.abort.abort();
      await execution.ready.catch(() => {});
      await execution.client?.close();
      await execution.app?.close();
      await execution.server?.close();
      all.delete(execution);
      audit({ event: 'closed', id: execution.id, pid: execution.pid, reason });
    });
    return execution.closing;
  }

  /** Allocates a fixed project copy, synthetic app and one e2e process per HTTP execution. */
  function allocate(owner) {
    const execution = { owner, id: undefined, created: Date.now(), touched: Date.now(), busy: false, closed: false, abort: new AbortController() };
    all.add(execution);
    execution.ready = (async () => {
      const folder = path.join(stateDir, randomUUID());
      await cp(path.join(root, 'project'), folder, { recursive: true, errorOnExist: true });
      await symlink(path.join(root, 'node_modules'), path.join(folder, 'node_modules'), 'dir');
      execution.folder = folder;
      execution.app = await startApp();
      execution.client = new Client({ name: 'community-http-bridge', version: '0.0.0' });
      // Pass only a small synthetic environment; never inherit model keys or host credentials.
      const env = { PATH: path.dirname(process.execPath), HOME: folder, APP_URL: execution.app.url,
        E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1', CI: '1',
        ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}) };
      // Local proof can point to this checkout's freshly built CLI, an operator-only setting.
      const cli = process.env.E2E_COMPANION_CLI ?? path.join(root, 'node_modules/e2e/dist/cli/bin.js');
      const stdio = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--max-sessions', '1'], cwd: folder, env, stderr: 'pipe' });
      stdio.stderr?.on('data', () => {});
      await execution.client.connect(stdio);
      execution.pid = stdio.pid;
      const server = new McpServer({ name: 'experimental-e2e-http-companion', version: '0.0.0' }, { capabilities: { tools: {}, resources: {} } });
      execution.server = server;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => { execution.id = id; executions.set(id, execution); },
        onsessionclosed: () => { void retire(execution, 'delete'); },
        maxRequestBodySize: 65_536,
      });
      execution.transport = transport;

      /** Forwards public tools; cancellation or timeout retires the entire execution. */
      async function forward(name, args, context) {
        if (execution.closed) throw new Error('Execution closed');
        if (execution.busy) throw new Error('One tool call per execution at a time');
        execution.busy = true;
        execution.touched = Date.now();
        const deadline = AbortSignal.timeout(callMs);
        // SDK 2.4 does not propagate the Web Request abort into mcpReq.signal.
        const signal = AbortSignal.any([context.mcpReq.signal, deadline, execution.abort.signal,
          ...(context.http?.req ? [context.http.req.signal] : [])]);
        const cancel = () => { void retire(execution, 'cancel-or-timeout'); };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          if (signal.aborted) { cancel(); signal.throwIfAborted(); }
          return await execution.client.callTool({ name, arguments: args }, { signal, timeout: callMs });
        } finally {
          signal.removeEventListener('abort', cancel);
          execution.busy = false;
          execution.touched = Date.now();
        }
      }
      server.registerTool('open_session', { description: 'Open the fixed synthetic project, one browser per execution.', inputSchema: z.object({}).strict() }, (args, ctx) => forward('open_session', args, ctx));
      server.registerTool('close_session', { description: 'Close the browser; DELETE the HTTP session to release its process too.', inputSchema: z.object({ session: z.string().optional() }).strict() }, (args, ctx) => forward('close_session', args, ctx));
      server.registerTool('tools', { description: 'Describe an allowed browser tool.', inputSchema: z.object({ tool: z.enum(verbs).optional(), session: z.string().optional() }).strict() }, (args, ctx) => args.tool ? forward('tools', args, ctx) : text('Allowed call tools: ' + verbs.join(', ') + '. The upstream open result also describes tools this companion refuses.'));
      server.registerTool('call', { description: 'Call an allowed public e2e browser tool. No run_code, navigation or custom commands.', inputSchema: z.object({
        session: z.string().optional(), tool: z.enum(verbs),
        args: z.object({ target: z.string().max(100).optional(), value: z.string().max(200).optional() }).strict().default({}),
      }).strict() }, (args, ctx) => forward('call', args, ctx));
      server.registerTool('run_tests', { description: 'Forward the existing e2e run_tests tool, limited to committed synthetic files.', inputSchema: z.object({ files: z.array(z.enum(['tests/smoke.e2e.ts', 'tests/slow.e2e.ts'])).min(1).max(1).default(['tests/smoke.e2e.ts']) }).strict() }, (args, ctx) => forward('run_tests', args, ctx));

      /** Lists bounded artifacts from this execution, with symlinks excluded by realpath checks. */
      async function artifacts() {
        const base = path.join(folder, '.e2e');
        const result = [];
        for (const dir of ['report.json', 'results']) {
          const candidate = path.join(base, dir);
          let files;
          try { files = dir === 'results' ? (await readdir(candidate, { recursive: true })).map((f) => 'results/' + f) : [dir]; }
          catch (e) { if (e.code === 'ENOENT') continue; throw e; }
          for (const relative of files) {
            if (result.length >= 200) break;
            if (!/\.(json|md|png)$/.test(relative)) continue;
            const filename = path.join(base, relative);
            let resolved;
            let info;
            try { resolved = await realpath(filename); info = await stat(filename); }
            catch (e) { if (e.code === 'ENOENT') continue; throw e; }
            if (!resolved.startsWith(base + path.sep)) continue;
            if (info.isFile() && info.size <= 2_097_152) result.push({ uri: 'e2e-artifact:///' + relative, name: relative, mimeType: relative.endsWith('.png') ? 'image/png' : 'text/plain' });
          }
        }
        return result;
      }
      server.server.setRequestHandler('resources/list', async () => ({ resources: await artifacts() }));
      server.server.setRequestHandler('resources/read', async ({ params: { uri } }) => {
        const allowed = (await artifacts()).find((r) => r.uri === uri);
        if (!allowed) throw new Error('Artifact not available in this execution');
        const content = await readFile(path.join(folder, '.e2e', allowed.name));
        return { contents: [{ uri, mimeType: allowed.mimeType, ...(allowed.mimeType === 'image/png' ? { blob: content.toString('base64') } : { text: content.toString('utf8') }) }] };
      });
      await server.connect(transport);
      audit({ event: 'started', pid: execution.pid, folder, appUrl: execution.app.url });
    })();
    return execution;
  }

  const http = createServer(async (req, res) => {
    /** Sends bounded errors without reflecting any credentials or request body. */
    function fail(status, message) { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(message); }
    try {
      if (req.url !== '/mcp') return fail(404, 'Not found');
      const hostname = new URL('http://' + req.headers.host).hostname;
      if (!allowedHosts.includes(hostname)) return fail(403, 'Host refused');
      if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return fail(403, 'Origin refused');
      const received = Buffer.from(req.headers.authorization ?? '');
      const owner = principals.find(([, token]) => { const expected = Buffer.from('Bearer ' + token); return received.length === expected.length && timingSafeEqual(received, expected); })?.[0];
      if (!owner) return fail(401, 'Bearer token required');
      if (stopping) return fail(503, 'Shutting down');
      if (!['POST', 'GET', 'DELETE'].includes(req.method)) return fail(405, 'Use MCP methods');
      let execution;
      const id = req.headers['mcp-session-id'];
      if (id) {
        execution = executions.get(id);
        if (!execution || execution.owner !== owner || execution.closed) return fail(404, 'Unknown session');
      }
      let body;
      if (req.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 65_536) return fail(413, 'Request too large');
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks).toString('utf8');
      }
      if (!execution) {
        if (id || req.method !== 'POST') return fail(400, 'Initialize first');
        let parsed;
        try { parsed = JSON.parse(body); } catch { return fail(400, 'Invalid JSON'); }
        if (parsed?.method !== 'initialize' || parsed.jsonrpc !== '2.0' || parsed.id === undefined) return fail(400, 'Initialize first');
        if (all.size >= maxExecutions) return fail(429, 'Execution limit reached');
        execution = allocate(owner);
        try { await execution.ready; } catch (e) { await retire(execution, 'startup-error'); throw e; }
      }
      execution.touched = Date.now();
      const disconnected = new AbortController();
      let source;
      res.once('close', () => {
        if (!res.writableEnded) disconnected.abort();
        // Cancelling the Web stream also releases the SDK's standalone SSE reservation.
        source?.destroy();
      });
      if (res.destroyed) disconnected.abort();
      const request = new Request('http://' + req.headers.host + '/mcp', { method: req.method, headers: req.headers, signal: disconnected.signal, ...(body === undefined ? {} : { body }) });
      const response = await execution.transport.handleRequest(request);
      if (response.body) source = Readable.fromWeb(response.body).on('error', () => res.destroy());
      if (res.destroyed) source?.destroy();
      else {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.flushHeaders();
        if (source) source.pipe(res);
        else res.end();
      }
      if (!execution.id) await retire(execution, 'invalid-initialize');
    } catch { fail(500, 'Bridge request failed'); }
  });
  http.requestTimeout = 10_000;
  http.headersTimeout = 10_000;
  const reap = setInterval(() => {
    for (const execution of all) {
      if (Date.now() - execution.created > lifetimeMs || (!execution.busy && Date.now() - execution.touched > idleMs)) void retire(execution, 'expiry');
    }
  }, Math.min(500, idleMs));
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, host, resolve); });
  return {
    url: `http://127.0.0.1:${http.address().port}/mcp`,
    /** Gracefully retires all executions before closing the HTTP listener. */
    async close() {
      stopping = true;
      clearInterval(reap);
      await Promise.all([...all].map((e) => retire(e, 'shutdown')));
      http.closeAllConnections();
      await new Promise((resolve, reject) => http.close((e) => e ? reject(e) : resolve()));
    },
  };
}
