#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tools } from './tools.mjs';
import { createConnector, isMain } from './runtime.mjs';

export function createServer(connector) {
  const server = new McpServer({ name: 'bondseat', version: '0.1.2' });
  for (const [name, description, inputSchema, readOnlyHint] of tools) {
    server.registerTool(`bondseat_${name}`, { description, inputSchema,
      annotations: { readOnlyHint, destructiveHint: !readOnlyHint, idempotentHint: true, openWorldHint: true } }, async input => {
      try {
        const result = await connector.call(name, input);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.status === 'action_required' };
      } catch {
        return { content: [{ type: 'text', text: 'BondSeat credential storage is unavailable. Check the connector configuration.' }], isError: true };
      }
    });
  }
  return server;
}

if (isMain(import.meta.url)) {
  try {
    const connector = createConnector();
    await createServer(connector).connect(new StdioServerTransport());
  } catch { process.stderr.write('Configure BONDSEAT_API_URL and private connector storage before starting BondSeat.\n'); process.exitCode = 1; }
}
