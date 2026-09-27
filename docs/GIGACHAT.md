# GigaChat provider (yardev fork)

This fork adds GigaChat as a **server-side AI Coach provider** while keeping the upstream
Coach payload allowlist, consent flow, JSON validation, repair round, caps and job logging.

## Provider flow

1. The admin selects **GigaChat** in `Settings -> Admin -> AI Coach`.
2. The admin pastes the GigaChat **Authorization Key**. openGym stores it encrypted in
   `./data/coach.json` using the existing credential store.
3. The adapter exchanges that key for a short-lived access token at:
   `https://ngw.devices.sberbank.ru:9443/api/v2/oauth`.
4. The access token is cached **in process memory only** and refreshed before expiry or after
   an API `401`. It is never persisted or logged.
5. Coach requests go to `https://api.giga.chat/v1/chat/completions`.

The default model is `GigaChat-3-Ultra`. The admin UI can refresh the model list from
`GET https://api.giga.chat/v1/models` and choose another available GigaChat model.

## Scope

The default OAuth scope is for personal API access:

```env
GIGACHAT_SCOPE=GIGACHAT_API_PERS
```

For another GigaChat project type, set the matching official scope before starting the API
container (`GIGACHAT_API_B2B` or `GIGACHAT_API_CORP`). The scope is not a secret.

Personal API access is serialized to one generation request at a time because GigaChat's
published limit for individuals is one concurrent stream. Business scopes are not serialized
by the adapter.

## TLS certificates

Do **not** disable TLS verification. GigaChat requires the Russian Trusted Root/Sub CA
certificates. Install them into the API container's trust store or mount a CA bundle and point
Node at it, for example:

```env
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/russian_trusted_ca.pem
```

Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Privacy properties

- GigaChat is marked `serverOnly`, so it is not offered by the native mobile BYOK picker.
- The long-lived Authorization Key stays encrypted in openGym's existing credential store.
- OAuth access tokens live only in memory.
- Provider errors are truncated and never include the Authorization Key.
- Structured output uses GigaChat `json_schema` with `strict: true`; if a model/API variant
  rejects the schema, the adapter makes one text-mode JSON attempt and openGym's existing
  parser + validator remain the gate before any proposal can be applied.

## Files changed

- `api/coach/core/providers.js`
- `api/coach/core/adapters/gigachat.js` (new)
- `api/coach/adapters/index.js`
- `api/test/adapters-gigachat.test.js` (new)
- `docs/GIGACHAT.md` (new)
