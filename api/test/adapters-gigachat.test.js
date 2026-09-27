import test from 'node:test';
import assert from 'node:assert/strict';
import gigachat, { _resetGigaChatForTests } from '../coach/core/adapters/gigachat.js';
import { HTTP_PROVIDERS, HTTP_PROVIDER_IDS } from '../coach/core/providers.js';
import { SYSTEM_PROMPT } from '../coach/core/system-prompt.js';

const AUTH = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const API = 'https://api.giga.chat';
const ENV = { GIGACHAT_AUTH_KEY: 'auth-key-1', GIGACHAT_SCOPE: 'GIGACHAT_API_PERS' };
const ANSWER = '{"coach_contract":1,"nochange":true,"reading":"ok"}';

function answer(status, body) {
  return { status, body };
}
function fakeFetch(script) {
  const calls = [];
  let activeChats = 0, maxActiveChats = 0;
  const f = async (url, init = {}) => {
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const body = typeof init.body === 'string' && (init.headers?.['content-type'] || init.headers?.['Content-Type'])?.includes('json')
      ? JSON.parse(init.body) : init.body;
    const call = { url, method: init.method || 'GET', headers: init.headers || {}, body };
    calls.push(call);
    const isChat = url.endsWith('/v1/chat/completions');
    if (isChat) { activeChats++; maxActiveChats = Math.max(maxActiveChats, activeChats); }
    try {
      const a = typeof script === 'function' ? await script(calls.length, call, calls) : script[Math.min(calls.length - 1, script.length - 1)];
      if (a instanceof Error) throw a;
      if (a?.delay) await new Promise(r => setTimeout(r, a.delay));
      return {
        ok: a.status >= 200 && a.status < 300,
        status: a.status,
        text: async () => typeof a.body === 'string' ? a.body : JSON.stringify(a.body)
      };
    } finally {
      if (isChat) activeChats--;
    }
  };
  f.calls = calls;
  Object.defineProperty(f, 'maxActiveChats', { get: () => maxActiveChats });
  return f;
}
const oauth = (token = 'access-1', expiresAt = Date.now() + 30 * 60_000) => answer(200, { access_token: token, expires_at: expiresAt });
const chat = (text = ANSWER) => answer(200, { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });

function reset() {
  _resetGigaChatForTests();
  delete process.env.GIGACHAT_SCOPE;
}

test('GigaChat is a server-only HTTPS provider and stays out of mobile BYOK', () => {
  const p = HTTP_PROVIDERS.gigachat;
  assert.ok(p);
  assert.equal(p.http, true);
  assert.equal(p.serverOnly, true);
  assert.equal(p.apiKeyEnv, 'GIGACHAT_AUTH_KEY');
  assert.equal(p.defaultBase, API);
  assert.equal(p.defaultModel, 'GigaChat-3-Ultra');
  assert.equal(HTTP_PROVIDER_IDS.includes('gigachat'), false);
  assert.equal(gigachat.spawns, false);
  assert.equal(gigachat.needsRuntime, false);
});

test('OAuth Authorization Key -> Bearer token -> structured chat request', async () => {
  reset();
  const f = fakeFetch([oauth(), chat()]);
  const schema = { type: 'object', properties: { coach_contract: { type: 'integer' } }, required: ['coach_contract'] };
  const r = await gigachat.invoke({ cfg: {}, prompt: 'P', system: 'TASK', schema, env: ENV, model: 'GigaChat-3-Ultra', fetch: f });
  assert.equal(r.code, 0);
  assert.equal(r.text, ANSWER);
  assert.equal(f.calls.length, 2);

  const o = f.calls[0];
  assert.equal(o.url, AUTH);
  assert.equal(o.method, 'POST');
  assert.equal(o.headers.authorization, 'Basic auth-key-1');
  assert.match(o.headers.rquid, /^[0-9a-f-]{36}$/i);
  assert.equal(o.body, 'scope=GIGACHAT_API_PERS');

  const c = f.calls[1];
  assert.equal(c.url, API + '/v1/chat/completions');
  assert.equal(c.headers.authorization, 'Bearer access-1');
  assert.equal(c.body.model, 'GigaChat-3-Ultra');
  assert.equal(c.body.stream, false);
  assert.equal(c.body.max_tokens, 16000);
  assert.equal(c.body.messages[0].role, 'system');
  assert.equal(c.body.messages[0].content, SYSTEM_PROMPT + '\n\nTASK');
  assert.deepEqual(c.body.messages[1], { role: 'user', content: 'P' });
  assert.deepEqual(c.body.response_format, { type: 'json_schema', schema, strict: true });
});

test('Authorization Key may already include Basic prefix and access token stays memory-cached', async () => {
  reset();
  const env = { ...ENV, GIGACHAT_AUTH_KEY: 'Basic abc123' };
  const f = fakeFetch((n, call) => {
    if (call.url === AUTH) return oauth('cached-token');
    if (call.url.endsWith('/models')) return answer(200, { data: [{ id: 'GigaChat-3-Ultra' }] });
    return chat();
  });
  let r = await gigachat.invoke({ cfg: {}, prompt: 'one', env, fetch: f });
  assert.equal(r.code, 0);
  r = await gigachat.models({}, env, { fetch: f });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['GigaChat-3-Ultra']);
  const oauthCalls = f.calls.filter(c => c.url === AUTH);
  assert.equal(oauthCalls.length, 1);
  assert.equal(oauthCalls[0].headers.authorization, 'Basic abc123');
});

test('401 from API invalidates access token, refreshes OAuth once, and retries', async () => {
  reset();
  let oauthN = 0, chatN = 0;
  const f = fakeFetch((n, call) => {
    if (call.url === AUTH) return oauth('access-' + (++oauthN));
    if (call.url.endsWith('/chat/completions')) {
      chatN++;
      return chatN === 1 ? answer(401, { message: 'token expired' }) : chat();
    }
    throw new Error('unexpected URL ' + call.url);
  });
  const r = await gigachat.invoke({ cfg: {}, prompt: 'P', env: ENV, fetch: f });
  assert.equal(r.code, 0);
  assert.equal(oauthN, 2);
  assert.equal(chatN, 2);
  const chats = f.calls.filter(c => c.url.endsWith('/chat/completions'));
  assert.equal(chats[0].headers.authorization, 'Bearer access-1');
  assert.equal(chats[1].headers.authorization, 'Bearer access-2');
});

test('concurrent first use shares one OAuth refresh and chat generation is serialized', async () => {
  reset();
  let oauthN = 0;
  const f = fakeFetch(async (n, call) => {
    if (call.url === AUTH) { oauthN++; return { ...oauth('shared'), delay: 20 }; }
    if (call.url.endsWith('/chat/completions')) return { ...chat(), delay: 25 };
    throw new Error('unexpected');
  });
  const [a, b] = await Promise.all([
    gigachat.invoke({ cfg: {}, prompt: 'A', env: ENV, fetch: f }),
    gigachat.invoke({ cfg: {}, prompt: 'B', env: ENV, fetch: f })
  ]);
  assert.equal(a.code, 0); assert.equal(b.code, 0);
  assert.equal(oauthN, 1);
  assert.equal(f.maxActiveChats, 1, 'one personal-account generation stream at a time');
});

test('models filters non-chat models and sorts the current GigaChat list', async () => {
  reset();
  const f = fakeFetch([
    oauth(),
    answer(200, { data: [
      { id: 'EmbeddingsGigaR' },
      { id: 'GigaChat-3-Ultra' },
      { id: 'GigaChat-2-Max' },
      { id: 'GigaChat-2-Pro' }
    ] })
  ]);
  const r = await gigachat.models({}, ENV, { fetch: f });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['GigaChat-2-Max', 'GigaChat-2-Pro', 'GigaChat-3-Ultra']);
});

test('a rejected JSON schema gets one text-mode retry; validator remains downstream gate', async () => {
  reset();
  let chatN = 0;
  const f = fakeFetch((n, call) => {
    if (call.url === AUTH) return oauth();
    chatN++;
    return chatN === 1
      ? answer(400, { message: 'json_schema response_format schema is unsupported' })
      : chat();
  });
  const schema = { type: 'object', properties: { coach_contract: { type: 'integer' } }, required: ['coach_contract'] };
  const r = await gigachat.invoke({ cfg: {}, prompt: 'P', schema, env: ENV, fetch: f });
  assert.equal(r.code, 0);
  const chats = f.calls.filter(c => c.url.endsWith('/chat/completions'));
  assert.equal(chats.length, 2);
  assert.equal(chats[0].body.response_format.type, 'json_schema');
  assert.deepEqual(chats[1].body.response_format, { type: 'text' });
});

test('missing Authorization Key makes no network request', async () => {
  reset();
  const f = fakeFetch([]);
  const r = await gigachat.invoke({ cfg: {}, prompt: 'P', env: {}, fetch: f });
  assert.equal(r.spawnError, true);
  assert.match(r.stderr, /Authorization Key/);
  assert.equal(f.calls.length, 0);
  const m = await gigachat.models({}, {}, { fetch: f });
  assert.equal(m.ok, false);
  assert.equal(f.calls.length, 0);
});

test('OAuth failures never leak the Authorization Key into error text', async () => {
  reset();
  const secret = 'very-secret-auth-key';
  const f = fakeFetch([answer(401, { message: 'bad credentials' })]);
  const r = await gigachat.invoke({ cfg: {}, prompt: 'P', env: { GIGACHAT_AUTH_KEY: secret }, fetch: f });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /401 bad credentials/);
  assert.equal(r.stderr.includes(secret), false);
});
