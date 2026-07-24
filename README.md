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
  services/openai.ts   OpenAI Responses API wrapper + tool-calling loop
  services/tools.ts     Tool schemas and handlers Lucy can call mid-conversation
  prompts/lucy.ts      Lucy's system prompt
  utils/response.ts    CORS + shared JSON response helper
  utils/rate-limit.ts  Cloudflare native rate limiting
  utils/turnstile.ts   Server-side Cloudflare Turnstile verification
  utils/analytics.ts   Structured event logging to Workers Analytics Engine
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

**Success response is a stream, not a single JSON blob.** ⚠️ **Not yet
deployed as of this writing** — see the warning at the bottom of this
section before assuming the live Worker behaves this way.

Once validation passes (message, Turnstile, Origin, rate limit, turn count —
all checked synchronously, all still return the plain JSON errors below on
failure), the response is `200` with `Content-Type: text/event-stream` and a
body of newline-delimited [SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
events, each formatted as `data: <json>\n\n`:

```
data: {"type":"delta","text":"I'm ","requestId":"8f045c93-..."}

data: {"type":"delta","text":"Lucy, ...","requestId":"8f045c93-..."}

data: {"type":"done","responseId":"resp_abc123","requestId":"8f045c93-..."}

```

Three event shapes:

| `type`    | Fields                          | Meaning                                                                 |
| --------- | -------------------------------- | ------------------------------------------------------------------------ |
| `delta`   | `text`                          | An incremental chunk of the reply. Concatenate all `delta.text` in order to build the full reply. |
| `done`    | `responseId`                    | Always the last event on success. Send `responseId` back as `previousResponseId` on the next turn. |
| `error`   | `message`                       | Generation failed *after* the HTTP response already started (status is `200` regardless — see below). Stop reading, show `message` or a generic failure state. |

Tool calls (see [Tools](#tools)) happen transparently between rounds of the
underlying OpenAI call — the client only ever sees `delta` events for
user-facing text, never anything tool-related, though there is a longer
pause before the first `delta` on turns that trigger a tool.

**Why `error` is an in-stream event and not an HTTP status**: by the time an
OpenAI call fails, the response has already committed to `200` and
`text/event-stream` — there's no HTTP-level way to retroactively change that.
So generation-time failures (OpenAI API errors, unexpected exceptions) are
reported as a final `{"type":"error"}` event instead of a `502`/`500`. Every
*pre*-generation failure (bad input, failed auth, rate limit, etc.) still
returns its original non-`200` JSON error exactly as before — only failures
during the OpenAI call itself moved into the stream.

#### Error responses

Failures caught before generation starts are still plain JSON:
`{ "error": "...", "requestId": "..." }`. (`requestId` is only omitted on `/`
and the `OPTIONS` preflight, which return plain `{ "error": "..." }` — those
checks run before a request ID is minted.)

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
| 200 + in-stream `error` event | Upstream OpenAI API error, or any other unexpected error during generation — see above |

## Tools

Lucy can call three function tools mid-conversation, via the OpenAI Responses
API's tool-calling loop ([src/services/openai.ts](src/services/openai.ts),
[src/services/tools.ts](src/services/tools.ts)). This is entirely
server-side — the `/chat` request/response contract above doesn't change,
callers just see a (slightly slower) reply that used real data.

- **`get_github_activity`**: fetches Scott's `Synaptechlabs` GitHub account's most
  recently updated public repos (name, description, language, stars, last
  updated) from GitHub's public REST API, unauthenticated. Used when asked
  about Scott's current/recent projects, instead of relying on the static
  bio in the system prompt. Fails closed (returns a "not available right
  now" string the model can relay) on any HTTP error or network failure —
  never throws, never blocks the rest of the reply.
- **`get_site_content`**: fetches and strips-to-text either synaptechlabs.ai's
  `bio` page (career history, employers, education — much more detail than
  the static prompt bio) or `home` page (current flagship project and full
  project log with status tags). Same fail-closed behavior as the GitHub
  tool. Only fetches those two known pages — it's not a crawler and doesn't
  discover new pages on its own; if the site adds more pages worth exposing,
  add them to `SITE_PAGES` in [src/services/tools.ts](src/services/tools.ts).
- **`contact_scott`**: records a visitor's message and optional contact
  method when they want to get in touch. Currently **log-only** — it writes
  a structured `lead_captured` event visible via `wrangler tail` or the
  Cloudflare dashboard's Logs view. There is no active notification (email,
  etc.) wired up yet, so leads have to be checked manually; the prompt is
  written to avoid Lucy claiming otherwise.

Each tool round-trip costs an extra `responses.create` call; a single chat
turn is capped at `MAX_TOOL_ROUNDS` (4) round-trips
([src/services/openai.ts](src/services/openai.ts)) so a model stuck calling
tools repeatedly can't turn one request into unbounded latency/cost.

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

### Reasoning effort

Reasoning effort is scaled to the message rather than fixed
(`inferReasoningEffort` in [src/services/openai.ts](src/services/openai.ts)):
short messages (≤6 words, e.g. "hi") get `low`, long ones (≥40 words) get
`high`, everything else gets `medium`. Word count is a crude proxy for
complexity, not a real one, but it beats paying for `medium` reasoning on
every greeting. Effort is computed once from the user's message and reused
across every tool round-trip within that turn.

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

## Debugging: what happened to a specific request

`console.log`/`console.warn`/`console.error` calls throughout the codebase
are only visible via a **live** `wrangler tail lucy-agent` session — nothing
retroactive. For "a user hit an error yesterday, what happened", that's
useless after the fact. Two things fill that gap:

**1. Analytics Engine events** ([src/utils/analytics.ts](src/utils/analytics.ts)) — every `/chat`
request logs one structured event (outcome, requestId, country, colo) to the
`lucy_chat_events` dataset, retained for **3 months** and queryable via SQL
after the fact:

```bash
ACCOUNT_ID="<your Cloudflare account ID>"
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer <API token with Account Analytics Read>" \
  --data "SELECT timestamp, blob1 AS outcome, blob2 AS requestId, blob3 AS country, blob4 AS colo
          FROM lucy_chat_events
          WHERE timestamp > NOW() - INTERVAL '1' DAY
          ORDER BY timestamp DESC LIMIT 100"
```

Possible `outcome` values: `rate_limited`, `origin_rejected`,
`invalid_content_type`, `invalid_json`, `empty_message`, `message_too_long`,
`missing_turnstile_token`, `turnstile_failed`, `invalid_previous_response_id`,
`invalid_turn_count`, `turn_limit_reached`, `stream_started`,
`stream_completed`, `stream_error`. A `stream_started` with no matching
`stream_completed`/`stream_error` for the same `requestId` means the client
disconnected before the reply finished — not a Worker-side failure.

**This only covers requests that actually reached the Worker.** If a user
reports something like "unreachable" and there's no matching event at all
around that time, the request likely never reached Cloudflare's edge —
check DNS, ad blockers/privacy extensions (they can block the Turnstile
challenge script or generic `*.workers.dev` subdomains), VPNs, or
corporate/hotel network filtering before assuming it's a Lucy bug.

**2. Cloudflare's GraphQL Analytics API** — for aggregate request
volume/status over time (not per-request detail), query
`workersInvocationsAdaptive` at `https://api.cloudflare.com/client/v4/graphql`
with the same bearer token. Useful for "was the Worker even getting hit
around that time" as a first sanity check.

## Local development

```bash
npm install
npm run dev      # wrangler dev, reads .dev.vars for secrets
npm test          # vitest, runs against a local Workers runtime — never calls
                   # the real OpenAI or Turnstile APIs (both are injected/faked in tests)
```

`.dev.vars` (not committed) holds both secrets above for `wrangler dev`.
`npm test` doesn't need it — every test either short-circuits before the
secrets would be used, or injects a fake reply streamer / Turnstile
verifier / tool executor / fetch in place of the real call, so the suite
never makes a live OpenAI, Turnstile, or GitHub request.

## Deployment

```bash
npm run deploy    # wrangler deploy
```

**Coordinate frontend changes before deploying.** The `/chat` request
contract (`turnstileToken` required, `Content-Type: application/json`,
allowed `Origin` values) is enforced the moment this Worker deploys — if the
live synaptechlabs.ai frontend doesn't already match it, the chat widget
breaks immediately.

**⚠️ Streaming is an additional, bigger breaking change, not yet deployed.**
The streaming `/chat` response format described above (SSE instead of a
single JSON blob) is built and tested but has **not shipped** as of this
writing — the currently-deployed Worker still returns
`{ "reply", "responseId", "requestId" }` as one JSON object. Deploying the
streaming version requires the frontend to switch from `response.json()` to
reading `response.body` as an SSE stream and concatenating `delta` events —
same drill as the Turnstile rollout. Confirm the frontend is ready before
running `wrangler deploy` with this change included.
