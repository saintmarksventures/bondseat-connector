import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BondSeatConnector, FileStore } from './connector.mjs';
import { createServer } from './server.mjs';

const baseUrl = 'https://bondseat.example/agent/v1';
const details = { restaurantId: 'il-buco', partySize: 2, date: '2090-05-20', startTime: '19:00', endTime: '20:00', confirmed: true };
const task = { id: '12345678-1234-1234-1234-123456789abc', kind: 'monitor', status: 'ACTIVE' };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

async function fixture(t, fetch) {
  const dir = await mkdtemp(join(tmpdir(), 'bondseat-connector-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(join(dir, 'state.json'));
  let time = 1_000_000;
  return { store, advance: ms => { time += ms; }, make: () => new BondSeatConnector({ baseUrl, store, fetch, now: () => time }) };
}

test('setup survives restarts and lost responses without exposing credentials or making replacement work', async t => {
  const submissions = [], exchanges = [];
  const token = `bsa_${'t'.repeat(43)}`, deviceCode = 'd'.repeat(43);
  let reads = 0;
  const f = await fixture(t, async (url, options) => {
    if (url.endsWith('/requests')) {
      submissions.push(JSON.parse(options.body));
      if (submissions.length === 1) throw new Error('Response lost after server commit');
      return json({ status: 'setup_required', deviceCode, setupUrl: 'https://bondseat.example/agents/link?code=public', pollAfterSeconds: 5 }, 202);
    }
    if (url.endsWith('/connect/token')) {
      exchanges.push(JSON.parse(options.body));
      if (exchanges.length === 1) throw new Error('Response lost after token issuance');
      return json({ accessToken: token, expiresIn: 3600, request: task });
    }
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    reads++; return json({ request: task });
  });
  const outputs = [await f.make().call('request', details)];
  assert.equal(outputs[0].status, 'setup_required');
  assert.deepEqual(submissions[0], submissions[1]);
  f.advance(6000);
  outputs.push(await f.make().call('status'));
  outputs.push(await f.make().call('request', details));
  outputs.push(await f.make().call('status', task));
  outputs.push(await f.make().call('status', task));
  assert.equal(submissions.length, 2); assert.equal(reads, 1);
  assert.deepEqual(exchanges[0], exchanges[1]);
  const visible = JSON.stringify(outputs);
  for (const privateValue of [token, deviceCode, submissions[0].connectionKey, submissions[0].idempotencyKey]) assert.ok(!visible.includes(privateValue));
  assert.equal((await stat(f.store.path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(f.store.path, 'utf8')).token, token);
});

test('concurrent connector instances preserve one intent and serialize state updates', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return json({ request: task }); });
  await f.store.withState(state => { state.token = 'test-token'; state.tokenExpiresAt = 2_000_000; });
  await Promise.all([f.make().call('request', details), f.make().call('request', details)]);
  assert.equal(calls, 1);
});

test('expired access reconnects without creating a replacement request', async t => {
  const paths = [];
  const f = await fixture(t, async url => {
    paths.push(new URL(url).pathname);
    return json({ deviceCode: 'private', setupUrl: 'https://bondseat.example/reconnect' }, 202);
  });
  await f.store.withState(state => { state.token = 'expired'; state.tokenExpiresAt = 1; });
  const result = await f.make().call('status', task);
  assert.equal(result.status, 'setup_required');
  assert.deepEqual(paths, ['/agent/v1/guest/connect']);
});

test('payment setup preserves intent and success with payment_required never repeats booking', async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return json({ error: 'PAYMENT_SETUP_REQUIRED', message: 'Authorize the fee.' }, 402);
    if (url.endsWith('/requests')) return json({ deviceCode: 'private', setupUrl: 'https://bondseat.example/setup', status: 'setup_required' }, 202);
    return json({ accessToken: 'private-token', expiresIn: 3600, request: { ...task, status: 'PAUSED', outcome: 'FIRED', paymentStatus: 'payment_required' } });
  });
  await f.store.withState(state => { state.token = 'existing'; state.tokenExpiresAt = 2_000_000; });
  await f.make().call('request', details);
  assert.equal(JSON.parse(calls[0].options.body).idempotencyKey, JSON.parse(calls[1].options.body).idempotencyKey);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  f.advance(6000); await f.make().call('status');
  const booked = await f.make().call('request', details);
  assert.equal(booked.request.paymentStatus, 'payment_required'); assert.equal(calls.length, 3);
});

test('honors server Retry-After across restarts', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return json({ error: 'RATE_LIMITED', message: 'Wait.' }, 429, { 'Retry-After': '60' }); });
  const first = await f.make().call('restaurants', { q: 'Il Buco' });
  const second = await f.make().call('restaurants', { q: 'Il Buco' });
  assert.equal(first.pollAfterSeconds, 60); assert.equal(second.pollAfterSeconds, 60); assert.equal(calls, 1);
});

test('MCP client discovers usable tools, validates inputs and receives no credential fields', async t => {
  const f = await fixture(t, async () => json({ restaurants: [{ id: 'r', name: 'Il Buco' }] }));
  const server = createServer(f.make()), client = new Client({ name: 'integration-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const listing = await client.listTools();
  assert.equal(listing.tools.length, 7);
  assert.ok(!JSON.stringify(listing).includes('accessToken')); assert.ok(!JSON.stringify(listing).includes('connectionKey'));
  const result = await client.callTool({ name: 'bondseat_restaurants', arguments: { q: 'Il Buco' } });
  assert.equal(JSON.parse(result.content[0].text).restaurants[0].name, 'Il Buco');
  const invalid = await client.callTool({ name: 'bondseat_request', arguments: { ...details, confirmed: false } });
  assert.equal(invalid.isError, true);
});

test('switching diners during reconnect removes the previous account cache', async t => {
  const f = await fixture(t, async () => json({ accountId: 'new-account', accessToken: 'new-token', expiresIn: 3600 }));
  await f.store.withState(state => {
    state.accountId = 'old-account'; state.intents = { old: { request: task } }; state.cache = { old: { result: task } };
    state.pending = { deviceCode: 'private', nextPollAt: 0 };
  });
  assert.equal((await f.make().call('status')).status, 'connected');
  await f.store.withState(state => { assert.deepEqual(state.intents, {}); assert.deepEqual(state.cache, {}); });
});

test('a named venue uses BondSeat lookup and survives retries as the same booking intent', async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    calls.push({ path: new URL(url).pathname, body: options.body && JSON.parse(options.body), authorization: options.headers.Authorization });
    if (url.endsWith('/restaurants/resolve')) return json({ restaurants: [{ id: 'resy-28927', name: 'La Vara', city: 'Brooklyn' }] });
    if (calls.filter(call => call.path.endsWith('/requests')).length === 1) throw new Error('Lost response');
    return json({ request: task });
  });
  const { restaurantId, ...dining } = details;
  const named = { ...dining, restaurant: 'La Vara', city: 'Cobble Hill' };
  assert.deepEqual((await f.make().call('request', named)).request, task);
  assert.equal((await f.make().call('request', named)).replayed, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].body, { q: 'La Vara', city: 'Cobble Hill' });
  assert.equal(calls[0].authorization, undefined);
  assert.equal(calls[1].body.restaurantId, 'resy-28927');
  assert.deepEqual(calls[1].body, calls[2].body);
});

test('ambiguous venues return choices without creating setup or a booking', async t => {
  const f = await fixture(t, async url => {
    assert.ok(url.endsWith('/restaurants/resolve'));
    return json({ restaurants: [{ id: 'r1', name: 'Vara' }, { id: 'r2', name: 'Vara' }], message: 'Choose the location.' });
  });
  const { restaurantId, ...dining } = details;
  const result = await f.make().call('request', { ...dining, restaurant: 'Vara' });
  assert.equal(result.reason, 'AMBIGUOUS_RESTAURANT');
  assert.equal(result.restaurants.length, 2);
  await f.store.withState(state => { assert.deepEqual(state.intents, {}); assert.equal(state.pending, undefined); });
});

test('URL discovery works before setup and directory pagination remains available', async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    calls.push({ path: new URL(url).pathname, body: options.body && JSON.parse(options.body) });
    return json({ restaurants: [] });
  });
  await f.make().call('restaurants', { url: 'https://resy.com/cities/new-york-ny/venues/la-vara' });
  assert.equal(calls[0].path, '/agent/v1/restaurants/resolve');
  await f.make().call('restaurants', { cursor: 'next' });
  assert.equal(calls[1].path, '/agent/v1/restaurants');
});
