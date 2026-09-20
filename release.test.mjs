import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));

test('published tarball installs independently and exposes MCP plus CLI through the npm executable', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bondseat-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', dir], { cwd: root });
  const [pack] = JSON.parse(stdout);
  const files = pack.files.map(file => file.path);
  assert.deepEqual(files.sort(), ['LICENSE', 'README.md', 'cli.mjs', 'connector.mjs', 'package.json',
    'runtime.mjs', 'server.json', 'server.mjs', 'skills/bondseat/LICENSE', 'skills/bondseat/SKILL.md', 'tools.mjs'].sort());
  await writeFile(join(dir, 'package.json'), '{"private":true}');
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(dir, pack.filename)], { cwd: dir, timeout: 90000 });
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const registry = JSON.parse(await readFile(join(root, 'server.json'), 'utf8'));
  assert.equal(pkg.mcpName, registry.name);
  assert.equal(registry.packages[0].identifier, pkg.name);
  assert.equal(registry.packages[0].version, pkg.version);
  assert.equal(registry.version, pkg.version);
  const skill = await readFile(join(root, 'skills/bondseat/SKILL.md'), 'utf8');
  assert.ok(skill.includes(`${pkg.name}@${pkg.version}`));
  const env = { ...process.env, BONDSEAT_STATE_FILE: join(dir, 'private', 'state.json') };
  delete env.BONDSEAT_API_URL;
  const help = await exec('npx', ['--offline', '--no-install', pkg.name, '--help'], { cwd: dir, env });
  assert.match(help.stdout, /Usage: bondseat/);
  const schema = await exec(join(dir, 'node_modules', '.bin', 'bondseat'), ['schema', 'request'], { cwd: dir, env });
  assert.equal(JSON.parse(schema.stdout).name, 'bondseat_request');
  // No tool calls: handshake/discovery must work without credentials or live API traffic.
  const client = new Client({ name: 'release-test', version: '1' });
  const transport = new StdioClientTransport({ command: 'npx', args: ['--offline', '--no-install', pkg.name], cwd: dir, env, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, pkg.version);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['connect', 'request', 'requests',
    'restaurants', 'resume', 'status', 'stop'].map(name => `bondseat_${name}`).sort());
  // MCP-only clients receive these descriptions, not the bundled SKILL.md.
  const description = name => tools.tools.find(tool => tool.name === `bondseat_${name}`).description;
  assert.match(description('request'), /schedule status checks.*does not push updates/);
  assert.match(description('status'), /Schedule follow-up calls.*notify the diner/);
  assert.match(description('status'), /cannot schedule follow-ups, say so/);
  assert.match(description('stop'), /verify_provider.*check their reservations/);
});
