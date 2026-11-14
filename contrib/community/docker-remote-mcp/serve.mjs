import { startBridge } from './bridge.mjs';

const bridge = await startBridge({
  tokens: JSON.parse(process.env.MCP_TOKENS ?? '{}'),
  host: process.env.MCP_BIND ?? '127.0.0.1',
  port: Number(process.env.MCP_PORT ?? 3100),
  allowRemoteBind: process.env.MCP_ALLOW_REMOTE_BIND === '1',
  allowedHosts: (process.env.MCP_ALLOWED_HOSTS ?? 'localhost,127.0.0.1').split(','),
  allowedOrigins: (process.env.MCP_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
});
console.log(JSON.stringify({ event: 'listening', url: bridge.url }));
let stopping = false;
/** Ends every owned execution on an operator signal. */
async function stop() {
  if (stopping) return;
  stopping = true;
  await bridge.close();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
