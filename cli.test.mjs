import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.mjs';
import { BondSeatConnector, FileStore } from './connector.mjs';

async function invoke(args, input, connectorFactory) {
  let stdout = '', stderr = '';
  const code = await runCli(args, { stdin: Readable.from([input]),
    stdout: { write(s) { stdout += s; } }, stderr: { write(s) { stderr += s; } }, connectorFactory });
  return { code, stdout, stderr };
}

test('CLI rejects unknown commands and invalid booking inputs before opening storage or networking', async () => {
  const factory = () => { assert.fail('Must not initialize connector'); };
  for (const [args, input] of [
    [['remove'], '{}'], [['request'], '{"confirmed":false,"accessToken":"never-echo-this"}'],
    [['status'], '{bad-json-never-echo-this'], [['restaurants'], '{"q":"Test","accessToken":"never-echo-this"}'],
    [['restaurants', 'extra'], '{}'], [['restaurants'], 'x'.repeat(65537)],
  ]) {
    const result = await invoke(args, input, factory);
    assert.equal(result.code, 2); assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes('never-echo-this'));
  }
});

test('CLI can inspect request schema without connecting to the service', async () => {
  const result = await invoke(['schema', 'request'], '', () => { assert.fail('Must not initialize connector'); });
  assert.equal(result.code, 0);
  const schema = JSON.parse(result.stdout).inputSchema;
  assert.equal(schema.properties.confirmed.const, true);
  assert.ok(schema.required.includes('date'));
});

test('CLI preserves setup across separate invocations and never prints private exchange material', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bondseat-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  let now = 10000, submissions = 0;
  const task = { kind: 'monitor', id: '12345678-1234-1234-1234-123456789abc' };
  const factory = () => new BondSeatConnector({ baseUrl: 'https://bondseat.example/agent/v1',
    store: new FileStore(path), now: () => now, fetch: async url => {
      if (url.endsWith('/requests')) {
        submissions++;
        return Response.json({ status: 'setup_required', deviceCode: 'private-device', setupUrl: 'https://bondseat.example/setup' });
      }
      assert.ok(url.endsWith('/connect/token'));
      return Response.json({ accessToken: 'private-token', expiresIn: 3600, request: task });
    } });
  const details = JSON.stringify({ restaurantId: 'r', partySize: 2, date: '2090-01-01', startTime: '18:00', endTime: '19:00', confirmed: true });
  const setup = await invoke(['request'], details, factory);
  assert.equal(JSON.parse(setup.stdout).status, 'setup_required');
  now += 6000;
  const connected = await invoke(['status'], '{}', factory);
  assert.deepEqual(JSON.parse(connected.stdout).request, task);
  const repeated = await invoke(['request'], details, factory);
  assert.equal(JSON.parse(repeated.stdout).replayed, true);
  assert.equal(submissions, 1);
  const state = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(state.token, 'private-token');
  const visible = JSON.stringify([setup, connected, repeated]);
  for (const value of ['private-device', 'private-token', ...Object.values(state.intents).flatMap(i => [i.key, i.connectionKey])])
    assert.ok(!visible.includes(value));
});

test('CLI returns useful action_required JSON with failure exit status and hides thrown diagnostics', async () => {
  const action = { status: 'action_required', reason: 'RATE_LIMITED', pollAfterSeconds: 60 };
  const result = await invoke(['status'], '{}', () => ({ call: async () => action }));
  assert.equal(result.code, 1); assert.deepEqual(JSON.parse(result.stdout), action);
  const failed = await invoke(['status'], '{}', () => { throw new Error('private-token'); });
  assert.equal(failed.code, 1); assert.ok(!failed.stderr.includes('private-token'));
});
