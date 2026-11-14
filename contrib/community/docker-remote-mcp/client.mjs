import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/** Connects or resumes an execution with the same principal and negotiated protocol. */
export async function connect(url, token, sessionId, protocolVersion) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: 'Bearer ' + token } },
    ...(sessionId ? { sessionId, protocolVersion } : {}),
  });
  const client = new Client({ name: 'synthetic-proof', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

/** Returns the unmodified text of an upstream tool result, failing on MCP tool errors. */
export async function invoke(connection, name, args = {}, options = {}) {
  const result = await connection.client.callTool({ name, arguments: args }, { timeout: 40_000, ...options });
  const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  if (result.isError) throw new Error(text);
  return text;
}
