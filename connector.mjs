import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, lstat, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';

const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requestFields = ['restaurantId', 'partySize', 'date', 'startTime', 'endTime', 'mode', 'executeAt', 'cancelFeeProtectionHours'];

/** A private, atomic store shared by connector processes, never by model tools. */
export class FileStore {
  constructor(path) { this.path = path; }
  async withState(fn) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = await open(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); await handle.close();
    if ((await lstat(this.path)).isSymbolicLink()) throw new Error('Credential storage must be a regular private file.');
    await chmod(this.path, 0o600);
    const release = await lockfile.lock(this.path, { retries: { retries: 30, minTimeout: 100, maxTimeout: 1000 } });
    try {
      const state = JSON.parse((await readFile(this.path, 'utf8')) || '{}');
      const save = async () => {
        const tmp = `${this.path}.${randomUUID()}.tmp`;
        const file = await open(tmp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
        await rename(tmp, this.path);
      };
      try { return await fn(state, save); } finally { await save(); }
    } finally { await release(); }
  }
}

class ApiError extends Error {
  constructor(status, body, retryAfter = 0) {
    super(body.message || 'BondSeat could not complete the operation.');
    this.status = status; this.code = body.error; this.nextAction = body.nextAction; this.retryAfter = retryAfter;
  }
}

/** Each instance/store represents one diner. Credentials never enter tool arguments/results. */
export class BondSeatConnector {
  constructor({ baseUrl, store, fetch: transport = globalThis.fetch, now = Date.now, name = 'Personal assistant' }) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('Configure a trusted HTTPS BondSeat API URL in the connector runtime.');
    this.base = baseUrl.replace(/\/$/, ''); this.store = store; this.fetch = transport; this.now = now; this.name = name;
  }

  async api(state, path, payload, authenticated = true) {
    if (state.retryAt > this.now()) throw new ApiError(429, { error: 'RATE_LIMITED', message: 'BondSeat asked the connector to wait.' }, Math.ceil((state.retryAt - this.now()) / 1000));
    // Retry a lost response once with identical identifiers. Never replace intent.
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await this.fetch(`${this.base}${path}`, {
          method: payload === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(path === '/restaurants/resolve' ? 28000 : 20000),
          headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(authenticated && state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
      } catch {
        if (!attempt) continue;
        throw new ApiError(503, { error: 'TEMPORARILY_UNAVAILABLE', message: 'Connection interrupted. Retry the same tool call; its identifiers are saved.' });
      }
      const body = await response.json();
      if (response.ok) return body;
      const retryAfter = Number(response.headers.get('retry-after')) || (response.status === 429 ? 60 : 0);
      if (retryAfter) state.retryAt = this.now() + retryAfter * 1000;
      if (response.status === 503 && !attempt && !retryAfter) continue;
      throw new ApiError(response.status, body, retryAfter);
    }
  }

  setupResult(pending) {
    return { status: 'setup_required', setupUrl: pending.setupUrl, pollAfterSeconds: Math.max(5, Math.ceil((pending.nextPollAt - this.now()) / 1000)),
      message: 'Open the setup link, then check status. BondSeat handles the booking; you do not need to copy any credentials.' };
  }

  async poll(state, save) {
    const pending = state.pending;
    if (!pending) return;
    if (pending.nextPollAt > this.now()) return this.setupResult(pending);
    pending.nextPollAt = this.now() + 5000;
    await save();
    try {
      const result = await this.api(state, '/connect/token', { deviceCode: pending.deviceCode }, false);
      if (state.accountId && result.accountId && state.accountId !== result.accountId) {
        const submitted = pending.intent && state.intents[pending.intent];
        state.intents = submitted ? { [pending.intent]: submitted } : {}; state.cache = {};
      }
      state.accountId = result.accountId;
      state.token = result.accessToken; state.tokenExpiresAt = this.now() + result.expiresIn * 1000;
      if (pending.intent && result.request) state.intents[pending.intent].request = result.request;
      delete state.pending;
      await save(); // Save credentials before returning any result to the model.
      return result.requestError ? { status: 'action_required', ...result.requestError } :
        result.request ? { request: result.request } : { status: 'connected', message: 'Access restored. Existing requests are unchanged.' };
    } catch (error) {
      if (['AUTHORIZATION_PENDING', 'SLOW_DOWN'].includes(error.code)) {
        pending.nextPollAt = this.now() + Math.max(5, error.retryAfter) * 1000;
        return this.setupResult(pending);
      }
      if (['EXPIRED_CODE', 'CODE_USED', 'ACCESS_DENIED'].includes(error.code)) delete state.pending;
      throw error;
    }
  }

  async connect(state, save) {
    if (state.pending) return (await this.poll(state, save)) || this.setupResult(state.pending);
    state.reconnectKey ||= secret(); await save();
    const result = await this.api(state, '/guest/connect', { clientName: this.name, connectionKey: state.reconnectKey }, false);
    state.pending = { deviceCode: result.deviceCode, setupUrl: result.setupUrl, nextPollAt: this.now() + 5000 };
    delete state.reconnectKey; await save();
    return this.setupResult(state.pending);
  }

  async call(tool, input = {}) {
    return this.store.withState(async (state, save) => {
      if (state.base && state.base !== this.base) return { status: 'action_required', message: 'Use a separate credential store for each BondSeat environment.' };
      state.base = this.base; state.intents ||= {}; state.cache ||= {};
      try {
        if (tool === 'restaurants') {
          const result = !input.cursor && (input.q || input.url) ? await this.api(state, '/restaurants/resolve', input, false) :
            await this.api(state, `/restaurants?${new URLSearchParams(input)}`, undefined, false);
          return result;
        }
        if (tool === 'connect') return await this.connect(state, save);
        if (state.pending) {
          const progress = await this.poll(state, save);
          if (state.pending || tool === 'status' && !input.id) return progress;
        }
        if (state.tokenExpiresAt <= this.now()) delete state.token;
        if (tool === 'request') {
          if (input.confirmed !== true) return { status: 'action_required', message: 'The diner must authorize automatic booking and the success fee. Their existing instruction can provide authorization.' };
          const choices = [input.restaurantId, input.restaurant, input.restaurantUrl].filter(Boolean);
          if (choices.length !== 1) return { status: 'action_required', message: 'Provide a restaurant name with city/neighborhood, a Resy URL, or a restaurantId.' };
          let restaurantId = input.restaurantId;
          if (!restaurantId) {
            const query = input.restaurantUrl ? { url: input.restaurantUrl } : { q: input.restaurant, ...(input.city ? { city: input.city } : {}) };
            const lookupKey = hash(query);
            state.venues ||= {};
            restaurantId = state.venues[lookupKey];
            if (!restaurantId) {
              const found = await this.api(state, '/restaurants/resolve', query, false);
              if (found.restaurants.length !== 1) return { status: 'action_required', reason: found.restaurants.length ? 'AMBIGUOUS_RESTAURANT' : 'RESTAURANT_NOT_FOUND',
                restaurants: found.restaurants, message: found.message };
              restaurantId = found.restaurants[0].id;
              state.venues[lookupKey] = restaurantId; await save();
            }
          }
          input = { ...input, restaurantId };
          const details = Object.fromEntries(requestFields.filter(k => input[k] !== undefined).map(k => [k, input[k]]));
          details.mode ||= 'monitor';
          const intentId = hash(details);
          const intent = state.intents[intentId] ||= { key: randomUUID(), connectionKey: secret() };
          await save();
          if (intent.request) return { request: intent.request, replayed: true, message: 'This dining request already exists. Use status to read its current state.' };
          let result;
          try { result = await this.api(state, '/requests', { ...details, idempotencyKey: intent.key, confirmed: true,
            ...(!state.token ? { connectionKey: intent.connectionKey, clientName: this.name } : {}) }); }
          catch (error) {
            if (error.status !== 402 || error.code !== 'PAYMENT_SETUP_REQUIRED') throw error;
            result = await this.api(state, '/requests', { ...details, idempotencyKey: intent.key, confirmed: true,
              connectionKey: intent.connectionKey, clientName: this.name }, false);
          }
          if (result.status === 'setup_required') {
            state.pending = { intent: intentId, deviceCode: result.deviceCode, setupUrl: result.setupUrl, nextPollAt: this.now() + 5000 };
            await save(); return this.setupResult(state.pending);
          }
          intent.request = result.request; await save(); return result;
        }
        if (!state.token) return await this.connect(state, save);
        if (tool === 'requests') return await this.api(state, `/requests?${new URLSearchParams(input)}`);
        if (tool === 'status' && !input.id) return { status: 'connected', message: 'Use requests to list bookings, or status with a request ID.' };
        if (!['monitor', 'scheduled'].includes(input.kind) || !/^[a-f0-9-]{36}$/.test(input.id || ''))
          return { status: 'action_required', message: 'Use the kind and ID returned by BondSeat.' };
        const path = `/requests/${input.kind}/${input.id}`;
        if (tool === 'status') {
          if (state.cache[path]?.until > this.now()) return state.cache[path].result;
          const result = await this.api(state, path);
          state.cache[path] = { result, until: this.now() + 60000 }; return result;
        }
        if (['stop', 'resume'].includes(tool)) {
          delete state.cache[path];
          return await this.api(state, `${path}/${tool === 'stop' ? 'cancel' : 'resume'}`, {});
        }
        return { status: 'action_required', message: 'Unknown BondSeat tool.' };
      } catch (error) {
        if (error.status === 401) { delete state.token; return await this.connect(state, save); }
        return { status: 'action_required', reason: error.code || 'CONNECTOR_ERROR',
          message: error instanceof ApiError ? error.message : 'The connector could not complete this operation. Retry the same tool call.',
          ...(error.nextAction ? { nextAction: error.nextAction } : {}), ...(error.retryAfter ? { pollAfterSeconds: error.retryAfter } : {}) };
      }
    });
  }
}
