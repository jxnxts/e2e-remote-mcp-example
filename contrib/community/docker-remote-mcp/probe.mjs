import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connect, invoke } from './client.mjs';

const url = process.env.MCP_URL ?? 'http://127.0.0.1:3100/mcp';
const tokens = JSON.parse(process.env.MCP_TOKENS ?? '{}');
const output = process.env.PROOF_OUTPUT ?? 'proof-output/compose';
await mkdir(output, { recursive: true });
const connections = [];
try {
  const [alice, bob] = await Promise.all([connect(url, tokens.alice), connect(url, tokens.bob)]);
  connections.push(alice, bob);
  await Promise.all([invoke(alice, 'open_session'), invoke(bob, 'open_session')]);
  const sessionId = alice.transport.sessionId;
  const version = alice.transport.protocolVersion;
  await alice.client.close();
  const resumed = await connect(url, tokens.alice, sessionId, version);
  connections.push(resumed);
  assert.match(await invoke(resumed, 'call', { tool: 'observe' }), /Synthetic citizen desk/);
  const refused = await fetch(url, { headers: { Authorization: 'Bearer ' + tokens.bob, 'Mcp-Session-Id': sessionId } });
  assert.equal(refused.status, 404);
  const result = await invoke(bob, 'run_tests');
  assert.match(result, /exit 0/);
  await writeFile(path.join(output, 'run-tests.txt'), result);
  const resources = (await bob.client.listResources()).resources;
  for (const resource of resources) {
    const content = (await bob.client.readResource({ uri: resource.uri })).contents[0];
    if (resource.name === 'report.json') await writeFile(path.join(output, 'report.json'), content.text);
    if (resource.mimeType === 'image/png') await writeFile(path.join(output, 'submitted.png'), Buffer.from(content.blob, 'base64'));
  }
  for (const connection of [resumed, bob]) {
    await invoke(connection, 'close_session');
    await connection.transport.terminateSession();
  }
  const summary = { twoClients: true, sameSessionReconnect: true, foreignSessionStatus: refused.status, runnerExit: 0, artifacts: resources.map((r) => r.name) };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  await Promise.all(connections.map((c) => c.client.close().catch(() => {})));
}
