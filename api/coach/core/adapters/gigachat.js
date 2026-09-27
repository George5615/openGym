/* GigaChat REST API adapter for the self-hosted Coach.
 *
 * GigaChat uses a long-lived Authorization Key only to mint a short-lived OAuth access token.
 * The Authorization Key is stored by openGym like any other encrypted instance API credential;
 * the access token is cached in memory only and is never written to disk or logs.
 */
import crypto from 'node:crypto';
import { HTTP_PROVIDERS, baseUrlFor } from '../providers.js';
import { SYSTEM_PROMPT } from '../system-prompt.js';

const ID = 'gigachat';
const META = HTTP_PROVIDERS[ID];
const AUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const DEFAULT_SCOPE = 'GIGACHAT_API_PERS';
const DEFAULT_TIMEOUT_MS = 5 * 60000;
const TOKEN_SKEW_MS = 60 * 1000;
const TOKEN_FALLBACK_MS = 29 * 60 * 1000;
const MAX_OUTPUT_TOKENS = 16000;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [2000, 5000];

const tokenCache = new Map();
const tokenInflight = new Map();
let chatLane = Promise.resolve();

const trim = (s, n = 300) => String(s == null ? '' : s).slice(0, n);
const hostOf = url => { try { return new URL(url).host; } catch { return url; } };
const sleep = (ms, signal) => new Promise(resolve => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
const scopeOf = env => String(env?.GIGACHAT_SCOPE || process.env.GIGACHAT_SCOPE || DEFAULT_SCOPE).trim() || DEFAULT_SCOPE;
const keyOf = env => String(env?.[META.apiKeyEnv] || '').trim();
const fingerprint = (key, scope) => crypto.createHash('sha256').update(scope).update('\0').update(key).digest('hex');
const basic = key => /^Basic\s+/i.test(key) ? key : `Basic ${key}`;
const expiryMs = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Date.now() + TOKEN_FALLBACK_MS;
  return n < 1e12 ? n * 1000 : n;
};

async function call(fetchImpl, url, init, timeoutMs, signal) {
  const ctl = new AbortController();
  const onOuter = () => ctl.abort();
  if (signal) signal.addEventListener('abort', onOuter, { once: true });
  if (signal?.aborted) ctl.abort();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await fetchImpl(url, { ...init, signal: ctl.signal }); }
  finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuter);
  }
}

async function readJson(res) {
  const text = await res.text();
  try { return { data: JSON.parse(text), text }; }
  catch { return { data: null, text }; }
}

const errorMessage = (data, fallback = '') =>
  data?.error?.message || data?.error || data?.message || data?.status || fallback;

function clearToken(key, scope) {
  tokenCache.delete(fingerprint(key, scope));
}

async function accessToken(env, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 20000, signal, force = false } = {}) {
  const key = keyOf(env);
  if (!key) throw Object.assign(new Error('no GigaChat Authorization Key configured'), { code: 'missing' });
  const scope = scopeOf(env);
  const fp = fingerprint(key, scope);
  const cached = tokenCache.get(fp);
  if (!force && cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.token;
  if (!force && tokenInflight.has(fp)) return tokenInflight.get(fp);

  const p = (async () => {
    let res;
    try {
      res = await call(fetchImpl, AUTH_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          authorization: basic(key),
          rquid: crypto.randomUUID()
        },
        body: new URLSearchParams({ scope }).toString()
      }, timeoutMs, signal);
    } catch (e) {
      if (e.name === 'AbortError') throw Object.assign(new Error('GigaChat OAuth timed out'), { code: 'timeout' });
      throw new Error(`could not reach ${hostOf(AUTH_URL)}: ${trim(e.message, 160)}`);
    }
    const { data, text } = await readJson(res);
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${trim(errorMessage(data, text), 220)}`), { status: res.status });
    const token = typeof data?.access_token === 'string' ? data.access_token.trim() : '';
    if (!token) throw new Error('GigaChat OAuth response had no access_token');
    tokenCache.set(fp, { token, expiresAt: expiryMs(data.expires_at) });
    return token;
  })();

  tokenInflight.set(fp, p);
  try { return await p; }
  finally { if (tokenInflight.get(fp) === p) tokenInflight.delete(fp); }
}

async function authorized(env, url, init, opts = {}) {
  const key = keyOf(env);
  const scope = scopeOf(env);
  if (!key) return { missing: true };
  let token;
  try { token = await accessToken(env, opts); }
  catch (e) { return { error: e }; }

  const run = async bearer => {
    try {
      return { res: await call(opts.fetch || globalThis.fetch, url, {
        ...init,
        headers: { ...(init.headers || {}), authorization: `Bearer ${bearer}` }
      }, opts.timeoutMs || DEFAULT_TIMEOUT_MS, opts.signal) };
    } catch (e) { return { error: e }; }
  };

  let out = await run(token);
  if (out.res?.status === 401 && !opts.signal?.aborted) {
    clearToken(key, scope);
    try { token = await accessToken(env, { ...opts, force: true }); }
    catch (e) { return { error: e }; }
    out = await run(token);
  }
  return out;
}

function withChatLane(env, fn) {
  if (scopeOf(env) !== 'GIGACHAT_API_PERS') return fn();
  const run = chatLane.then(fn, fn);
  chatLane = run.catch(() => {});
  return run;
}

const adapter = {
  id: ID,
  runtime: META.runtime,
  spawns: false,
  needsRuntime: false,
  baseUrl: cfg => baseUrlFor(ID, cfg),

  async check(cfg, env, opts = {}) {
    const base = adapter.baseUrl(cfg);
    if (!keyOf(env)) return { ok: true, version: `HTTPS · ${hostOf(base)}`, needsKey: true };
    const r = await adapter.models(cfg, env, opts);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, version: `HTTPS · ${hostOf(base)} · ${r.models.length} models`, models: r.models };
  },

  async models(cfg, env, opts = {}) {
    const base = adapter.baseUrl(cfg);
    if (!keyOf(env)) return { ok: false, error: 'no GigaChat Authorization Key configured', models: [] };
    const out = await authorized(env, `${base}/v1/models`, { method: 'GET', headers: { accept: 'application/json' } }, { ...opts, timeoutMs: opts.timeoutMs || 20000 });
    if (out.missing) return { ok: false, error: 'no GigaChat Authorization Key configured', models: [] };
    if (out.error) return { ok: false, error: out.error.code === 'timeout' || out.error.name === 'AbortError' ? 'timed out' : trim(out.error.message, 240), models: [] };
    const { data, text } = await readJson(out.res);
    if (!out.res.ok) return { ok: false, error: `${out.res.status} ${trim(errorMessage(data, text), 220)}`, models: [] };
    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
    const models = rows.map(m => typeof m === 'string' ? m : m?.id || m?.name).filter(m => typeof m === 'string' && /^GigaChat/i.test(m));
    return { ok: true, models: [...new Set(models)].sort() };
  },

  async invoke(opts = {}) {
    return withChatLane(opts.env || {}, async () => {
      const { cfg = {}, prompt = '', system = null, schema = null, env = {}, model, timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchImpl = globalThis.fetch, signal } = opts;
      if (signal?.aborted) return { code: -1, text: '', stderr: 'timed out', timedOut: true };
      if (!keyOf(env)) return { code: -1, text: '', stderr: 'no GigaChat Authorization Key configured', spawnError: true };
      const chosen = model || META.defaultModel;
      const base = adapter.baseUrl(cfg);
      let body = {
        model: chosen,
        messages: [
          { role: 'system', content: system ? `${SYSTEM_PROMPT}\n\n${system}` : SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        stream: false,
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: schema ? { type: 'json_schema', schema, strict: true } : { type: 'text' }
      };

      let transientRetries = 0;
      let retriedWithoutSchema = false;
      for (;;) {
        const out = await authorized(env, `${base}/v1/chat/completions`, {
          method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body)
        }, { fetch: fetchImpl, timeoutMs, signal });
        if (out.missing) return { code: -1, text: '', stderr: 'no GigaChat Authorization Key configured', spawnError: true };
        if (out.error) {
          if (out.error.code === 'timeout' || out.error.name === 'AbortError') return { code: -1, text: '', stderr: 'timed out', timedOut: true };
          return { code: 1, text: '', stderr: trim(out.error.message, 280) };
        }
        const { data, text } = await readJson(out.res);
        if (!out.res.ok) {
          const msg = errorMessage(data, text);
          if (out.res.status === 400 && schema && !retriedWithoutSchema && /response_format|json_schema|schema|structured/i.test(String(msg))) {
            body = { ...body, response_format: { type: 'text' } };
            retriedWithoutSchema = true;
            continue;
          }
          if (RETRY_STATUSES.has(out.res.status) && transientRetries < RETRY_DELAYS_MS.length && !signal?.aborted) {
            await sleep(opts.retryDelayMs != null ? opts.retryDelayMs : RETRY_DELAYS_MS[transientRetries], signal);
            transientRetries++;
            continue;
          }
          return { code: 1, text: '', stderr: `${out.res.status} ${trim(msg, 280)}` };
        }
        const choice = data?.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content !== 'string') return { code: 1, text: '', stderr: 'the answer had no text choice' };
        if (/^(length|max_tokens)$/i.test(String(choice.finish_reason || ''))) {
          return { code: 1, text: '', stderr: 'the answer was cut off at the output limit — try a smaller plan' };
        }
        return { code: 0, text: content.trim(), stderr: '' };
      }
    });
  }
};

export function _resetGigaChatForTests() {
  tokenCache.clear(); tokenInflight.clear(); chatLane = Promise.resolve();
}

export default adapter;
