# lucy-agent

Cloudflare Worker backing **Lucy**, Scott Douglass's personal AI assistant for
[Synaptech Labs](https://synaptechlabs.ai). Lucy is embedded as a chat widget
on the static synaptechlabs.ai site and answers through the OpenAI Responses
API.

## Architecture

```
src/
  index.ts            Worker entry point: routing, rate limiting, Origin check
  routes/chat.ts       POST /chat: validation, Turnstile verification, OpenAI call
  services/openai.ts   OpenAI Responses API wrapper (model, timeout, output cap)
  prompts/lucy.ts      Lucy's system prompt
  utils/response.ts    CORS + shared JSON response helper
  utils/rate-limit.ts  Cloudflare native rate limiting
  utils/turnstile.ts   Server-side Cloudflare Turnstile verification
  types.ts             Request/response shapes
```

No database, no other backend — the Worker is the entire server side. The
frontend at synaptechlabs.ai is a static site with no backend of its own; it
calls this Worker directly.

## Live endpoint

```
https://lucy-agent.lucy-agent.workers.dev
```

No custom domain/route is configured in `wrangler.jsonc` — this is
Cloudflare's default `<worker-name>.<account-subdomain>.workers.dev` address.

## API

### `GET /`

Health check.

```json
{ "status": "ok", "assistant": "Lucy", "message": "Lucy is alive!" }
```

Any other method on `/` returns `405`.

### `OPTIONS /chat`

CORS preflight. Returns `204` with CORS headers if `Origin` is in the
allowlist (see below), otherwise `403 { "error": "Origin not allowed" }`.

### `POST /chat`

Request body (`application/json`):

| Field              | Type            | Required | Notes                                                                                     |
| ------------------ | --------------- | -------- | ------------------------------------------------------------------------------------------- |
| `message`          | `string`        | yes      | Trimmed; max 4,000 characters.                                                              |
| `turnstileToken`   | `string`        | yes      | Cloudflare Turnstile response token from the frontend widget. Single-use, ~5 min lifetime.  |
| `previousResponseId` | `string`      | no       | OpenAI response ID (`resp_...`) from the prior turn, to continue a conversation. Omit to start fresh. |
| `turnCount`        | `integer >= 0`  | no       | Client-tracked turn number for the current conversation. Optional soft cap — if omitted, no cap is enforced (see [Conversation length](#conversation-length) below). |

Example:

```bash
curl -X POST https://lucy-agent.lucy-agent.workers.dev/chat \
  -H "Content-Type: application/json" \
  -H "Origin: https://synaptechlabs.ai" \
  -d '{
    "message": "Who are you?",
    "turnstileToken": "<token from the widget>"
  }'
```

Success response (`200`):

```json
{
  "reply": "I'm Lucy, ...",
  "responseId": "resp_abc123",
  "requestId": "8f045c93-..."
}
```

Send `responseId` back as `previousResponseId` on the next turn to continue
the conversation.

#### Error responses

All `/chat` errors are JSON: `{ "error": "...", "requestId": "..." }`.
(`requestId` is only omitted on `/` and the `OPTIONS` preflight, which return
plain `{ "error": "..." }` — those checks run before a request ID is minted.)

| Status | Condition                                                               |
| ------ | ------------------------------------------------------------------------ |
| 405    | Method other than POST                                                   |
| 415    | Missing/wrong `Content-Type` (must include `application/json`)           |
| 400    | Malformed JSON body                                                      |
| 400    | `message` missing or empty                                               |
| 413    | `message` exceeds 4,000 characters                                       |
| 400    | `turnstileToken` missing or empty                                        |
| 403    | `turnstileToken` present but failed Cloudflare verification              |
| 400    | `previousResponseId` present but not a valid `resp_...` string           |
| 400    | `turnCount` present but not a non-negative integer                       |
| 400    | `turnCount` reached the conversation turn limit (see below)              |
| 403    | `Origin` header missing or not in the allowlist (checked in `index.ts` before the request reaches `handleChatRequest`) |
| 429    | Rate limit exceeded (20 requests / 60s per IP) — includes `Retry-After: 60` header |
| 502    | Upstream OpenAI API error                                                |
| 500    | Any other unexpected error                                               |

## Security

- **CORS allowlist**: `http://localhost:3000`, `http://localhost:5173`,
  `https://synaptechlabs.ai`, `https://www.synaptechlabs.ai`
  ([src/utils/response.ts](src/utils/response.ts)). Enforced twice — on the
  CORS preflight (blocks non-listed origins from ever getting a browser to
  send the real request) and again explicitly on the real `POST /chat`
  (blocks non-browser callers that skip the preflight, though `Origin` is
  trivially spoofable by a determined caller — this is defense in depth, not
  the real gate).
- **Rate limiting**: Cloudflare's native rate limiter, 20 requests per 60
  seconds per `CF-Connecting-IP` ([src/utils/rate-limit.ts](src/utils/rate-limit.ts),
  configured in `wrangler.jsonc`).
- **Turnstile**: the actual bot/abuse gate. Every `POST /chat` must include a
  valid Turnstile token, verified server-side against Cloudflare's
  `siteverify` API ([src/utils/turnstile.ts](src/utils/turnstile.ts)). This
  exists because the frontend is a static site with no backend of its own —
  nothing embedded in its JS can function as a real secret, so Turnstile
  (proof of a real browser, verified server-side with a secret that never
  reaches the browser) is the actual protection, not a shared API key.
  - Widget name: `lucy-chat`, mode: invisible
  - Site key (public): `0x4AAAAAAD70UAZ2zMrs-XUK`
  - Allowed domains: `synaptechlabs.ai`, `www.synaptechlabs.ai`, `localhost`
- **Output cap & timeout**: replies are capped at 4,096 output tokens and the
  OpenAI request times out after 30s (SDK default is 10 minutes — far too
  long for a synchronous chat request) — see
  [src/services/openai.ts](src/services/openai.ts).

### Conversation length

`turnCount` is an opt-in cap enforced at 40 turns
([src/routes/chat.ts](src/routes/chat.ts)). Lucy's Worker is stateless and
keeps no record of past conversations, so this only works if the frontend
tracks and sends an incrementing `turnCount` itself. If the frontend never
sends it, no cap is enforced. This is a soft, client-cooperative guard
against runaway usage (e.g. a frontend bug), not a security boundary — a
malicious client can simply omit or lie about the field.

## Secrets

Set via `wrangler secret put <NAME>` — never committed, never stored in
`wrangler.jsonc`. Local development reads the same names from `.dev.vars`
(gitignored).

| Secret                 | Used for                                              |
| ----------------------- | ------------------------------------------------------ |
| `OPENAI_API_KEY`        | Calling the OpenAI Responses API                       |
| `TURNSTILE_SECRET_KEY`  | Verifying Turnstile tokens against Cloudflare's siteverify API |

## Local development

```bash
npm install
npm run dev      # wrangler dev, reads .dev.vars for secrets
npm test          # vitest, runs against a local Workers runtime — never calls
                   # the real OpenAI or Turnstile APIs (both are injected/faked in tests)
```

`.dev.vars` (not committed) holds both secrets above for `wrangler dev`.
`npm test` doesn't need it — every test either short-circuits before the
secrets would be used, or injects a fake reply generator / Turnstile
verifier in place of the real API call, so the suite never makes a live
OpenAI or Turnstile request.

## Deployment

```bash
npm run deploy    # wrangler deploy
```

**Coordinate frontend changes before deploying.** The `/chat` request
contract (`turnstileToken` required, `Content-Type: application/json`,
allowed `Origin` values) is enforced the moment this Worker deploys — if the
live synaptechlabs.ai frontend doesn't already match it, the chat widget
breaks immediately.
