#!/usr/bin/env node
import { z } from 'zod';
import { tools } from './tools.mjs';
import { createConnector, isMain } from './runtime.mjs';

export async function runCli(args, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  connectorFactory = createConnector } = {}) {
  if (args.length === 0) {
    const { createServer } = await import('./server.mjs');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    try { await createServer(connectorFactory()).connect(new StdioServerTransport()); return 0; }
    catch { stderr.write('BondSeat is unavailable. Check the API URL and private connector storage.\n'); return 1; }
  }
  if (args[0] === '--help') {
    stdout.write('Usage: bondseat <command> < input.json\nCommands: restaurants, request, status, requests, stop, resume, connect\nUse bondseat schema <command> for JSON input fields. Inputs default to {} when stdin is a terminal.\nRequires Node.js 22+. BONDSEAT_API_URL and BONDSEAT_STATE_FILE are optional runtime settings.\n');
    return 0;
  }
  const schemaMode = args[0] === 'schema';
  const command = args[schemaMode ? 1 : 0];
  const definition = tools.find(([name]) => name === command);
  if (!definition || args.length !== (schemaMode ? 2 : 1)) {
    stderr.write('Unknown command or extra arguments. Use bondseat --help. Pass JSON through stdin.\n');
    return 2;
  }
  const schema = z.object(definition[2]).strict();
  if (schemaMode) {
    // The SDK exposes this same Zod schema through MCP tools/list.
    const { createServer } = await import('./server.mjs');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const server = createServer({ call() { throw new Error('Schema inspection cannot invoke tools.'); } });
    const client = new Client({ name: 'bondseat-schema', version: '0.1.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const listing = await client.listTools();
      stdout.write(`${JSON.stringify(listing.tools.find(tool => tool.name === `bondseat_${command}`), null, 2)}\n`);
    } finally { await client.close(); await server.close(); }
    return 0;
  }
  let input;
  try {
    let source = '';
    if (!stdin.isTTY) {
      for await (const chunk of stdin) {
        source += chunk;
        if (Buffer.byteLength(source) > 65536) throw new Error('Input too large');
      }
    }
    input = schema.parse(JSON.parse(source.trim() || '{}'));
  } catch {
    // Validation errors can echo supplied values. Never print the raw input.
    stderr.write('Invalid JSON input. Use bondseat schema <command> for accepted fields.\n');
    return 2;
  }
  try {
    const result = await connectorFactory().call(command, input);
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'action_required' ? 1 : 0;
  } catch {
    stderr.write('BondSeat is unavailable. Check the API URL and private connector storage.\n');
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));
