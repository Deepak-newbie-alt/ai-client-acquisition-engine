# AI Client Acquisition Engine

Personal research platform: finds recurring operational problems in businesses,
ranks them with transparent scores, and drafts outreach emails that are only
ever sent after explicit, content-bound human approval.

Status: **MVP complete (Phase 7)**. Research, problem clustering, transparent
scoring, companies and contacts, approval-bound outreach (mock email by default,
Gmail optional), suppression, audit log, usage budgets and the React dashboard
all work. There is a production Docker setup with HTTPS, and n8n workflows.

More documentation:

- [docs/deployment.md](docs/deployment.md): production with Docker and Caddy (HTTPS)
- [docs/operations.md](docs/operations.md): backups and restore, secret rotation, monitoring, emergency stop
- [docs/security.md](docs/security.md): threat model, controls, roles, known limitations
- [n8n/README.md](n8n/README.md): scheduled research, reply checks, daily digest

## Local setup

Requirements: Node 22.12+, Docker Desktop.

```sh
cp .env.example .env          # then set POSTGRES_PASSWORD and the matching URLs
npm install                   # also runs `prisma generate`
npm run db:up                 # Postgres 17 on 127.0.0.1:5433 (creates ace_dev and ace_test)
npm run db:deploy             # apply migrations to ace_dev
```

Port 5433 is used so the container does not clash with a locally installed
PostgreSQL on 5432. Change `POSTGRES_PORT` and both URLs together if needed.

## Running the API and dashboard

```sh
npm run user:create -- --email you@example.com --name "You" --role ADMIN   # password via stdin
npm run token:create -- --name n8n --scopes research:read,research:write     # optional, for automation
npm run dev                                                                  # API on http://127.0.0.1:3000
npm run web:install                                                          # once
npm run web:dev                                                              # dashboard on http://localhost:5173
```

Open the dashboard at `http://localhost:5173` (not 127.0.0.1: the API checks
the browser's Origin against `APP_ORIGIN`).

With the defaults (`SEARCH_PROVIDER=mock`, `LLM_PROVIDER=mock`,
`PAGE_FETCHER=mock`), everything runs offline against built-in fixture pages on
IANA example domains. `PAGE_FETCHER=http` fetches real public pages (respecting
robots.txt, with SSRF protection) while search and LLM stay mocked.

Browser clients authenticate with the session cookie from `POST /api/auth/login`
and must send `X-ACE-CSRF: 1` on every non-GET request. Automation uses
`Authorization: Bearer <service token>`. Service tokens can only hold
`research:read`, `research:write` and `outreach:sync` (reply checks).
Creating, approving and sending outreach always requires a signed-in user.
List and revoke tokens with `npm run token:list` and
`npm run token:revoke -- --name <name>`.

| Method | Path | Access |
|---|---|---|
| GET | `/api/health` | public |
| POST | `/api/auth/login`, `/api/auth/logout` | public / session |
| GET | `/api/auth/me` | user |
| POST | `/api/research-runs` | user or `research:write` |
| GET | `/api/research-runs`, `/api/research-runs/:id`, `/api/research-runs/:id/evidence` | user or `research:read` |
| POST | `/api/research-runs/:id/cancel`, `/api/research-runs/:id/retry` | user or `research:write` |
| GET | `/api/sources/:id` | user or `research:read` |
| GET | `/api/usage` (this month's spend vs. budgets) | user or `research:read` |
| GET, PATCH | `/api/opportunities`, `/api/opportunities/:id`; POST `/:id/merge`, `/recompute`; GET `/scoring` | user |
| PATCH | `/api/evidence/:id` (reject/restore) | user |
| GET, POST, PATCH | `/api/companies`, `/api/companies/:id`, POST `/:id/contacts` | user |
| POST, DELETE | `/api/contacts/:id/verify`, `/api/contacts/:id` | user |
| GET, POST, DELETE | `/api/suppressions` (DELETE: admin only) | user |
| GET | `/api/audit-events` | user |
| GET, POST, PATCH | `/api/outreach/drafts`, `/api/outreach/drafts/:id` | user |
| POST | `/api/outreach/drafts/:id/` + `approve`, `send`, `reject`, `cancel`, `reconcile`, `revise`, `replied` | user |
| POST | `/api/outreach/check-replies` | user or `outreach:sync` |

Example (n8n or curl):

```sh
curl -X POST http://127.0.0.1:3000/api/research-runs \
  -H "Authorization: Bearer $ACE_TOKEN" -H "Content-Type: application/json" \
  -d '{"industry":"HVAC","country":"GB","keywords":["scheduling"],"resultLimit":10}'
```

Runs are queued and processed one at a time in the API process. On restart,
queued runs resume and interrupted runs are marked `FAILED` (`INTERRUPTED`).

## Opportunities and scoring

After every research run (and on demand) valid evidence is grouped into
problem clusters without any LLM call: evidence joins the cluster whose
closest member has the same workflow label or enough keyword overlap,
otherwise it starts a new one. Reviewers can merge clusters that describe the
same problem and reject evidence that does not support one.

Independence counts companies, or registrable domains when no company is
recorded, so several pages of one business count once; syndicated copies are
never analysed and identical quotes on several sites count once.

Each cluster gets six component scores (0-5) computed by the rules in
`src/modules/opportunities/scoring.ts`, each with a rationale and the
evidence it used. A component without supporting evidence stays **unknown**
rather than receiving a guess. The total is the weighted sum of known
components (weights in `config/scoring.json`); "coverage" is the share of
the weighting that could be scored. Scores rank leads for human review. They
are not probabilities of commercial success.

## Outreach: nothing is sent without approval

```
DRAFT --approve(hash)--> APPROVED --send(hash)--> SENDING --> SENT
  ^        |                 |                       |
  |        +-- edit ---------+ (approval invalidated)+--> FAILED   (provider definitely refused)
  |                                                  +--> SENDING  (outcome unknown: reconcile)
  +-- revise <-- FAILED / REJECTED / CANCELLED
```

- Creating or generating a draft never sends. The server appends the sender
  identity and an opt-out line to every body, and edits must keep it.
- Approval names the exact content hash (recipient, subject and body) the
  reviewer saw and expires after `APPROVAL_TTL_MINUTES`. Any edit invalidates it.
- Sending is a separate action. Under a row lock it re-checks status, the hash,
  the approval and its expiry, suppression, contact validity and the follow-up
  rules, then consumes the approval and records a pre-generated Message-ID
  before calling the provider once. Concurrent or repeated sends are refused.
- A definite provider refusal marks the draft FAILED. A timeout or 5xx leaves
  it SENDING with an unknown outcome. **Reconcile** looks up the Message-ID in
  sent mail: found means SENT; not found after `SEND_RECONCILE_GRACE_MINUTES`
  means FAILED. Nothing is resent automatically.
- Replies stop follow-ups. Opt-out replies ("unsubscribe", "remove me", "not
  interested", ...) add the address to the suppression list and cancel pending
  drafts. Reply text is never stored. `POST /api/outreach/check-replies` can
  run on a schedule from n8n with a token that has only `outreach:sync`.
- Service tokens and the LLM cannot draft, approve or send.

### Gmail (optional)

1. In Google Cloud, create a project, enable the Gmail API, configure the OAuth
   consent screen (add yourself as a test user) and create an OAuth client.
2. Obtain a refresh token for the scopes `https://www.googleapis.com/auth/gmail.send`
   and `https://www.googleapis.com/auth/gmail.readonly` (sending, and finding
   sent messages and replies), for example with the OAuth 2.0 Playground using
   your own client ID and secret.
3. Set `EMAIL_PROVIDER=gmail`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
   `GMAIL_REFRESH_TOKEN`, `GMAIL_SENDER_ADDRESS`, and outside production
   `EMAIL_RECIPIENT_ALLOWLIST` (e.g. your own addresses). Sends to anyone
   else are refused before reaching Gmail.

Cold email is regulated (CAN-SPAM, PECR/GDPR and others). Set
`OUTREACH_SENDER_NAME` and `OUTREACH_POSTAL_ADDRESS`, and confirm outreach is
lawful where your recipients are.

## Real providers (paid)

Both need your own API keys. A Claude Code subscription does not include API
credits, so `ANTHROPIC_API_KEY` must come from the Claude Console.

```sh
SEARCH_PROVIDER=tavily
TAVILY_API_KEY=tvly-...
TAVILY_SEARCH_DEPTH=basic        # 1 credit per search (advanced = 2)
TAVILY_USD_PER_CREDIT=0.008      # set to your plan's effective price
PAGE_FETCHER=http                # required with Tavily

LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-5-5  # default
ANTHROPIC_EFFORT=medium          # low lowers cost; quality may drop
```

Check them once before a real run. This spends about $0.01–$0.20 and writes
nothing to the database:

```sh
npm run providers:smoke -- --query "plumbing scheduling spreadsheet" --country GB         # shows worst-case cost
npm run providers:smoke -- --query "plumbing scheduling spreadsheet" --country GB --yes   # runs it
```

How spend is controlled:

- Before every paid call, its worst-case cost is reserved against the per-run
  and monthly budgets. For Claude that is the input estimate plus the full
  `max_tokens` (8,000 tokens, which covers adaptive thinking), about $0.19 per
  page on `claude-opus-5-5`. Afterwards the reservation is replaced by the
  cost from the reported tokens or credits. Typical pages cost far less than
  the reservation, but a run stops once the remaining run budget can't cover
  one more worst case, so raise `RESEARCH_RUN_BUDGET_USD` for long runs.
- Claude requests use structured JSON output, no tools, and the server-side
  refusal fallback (`fallbacks: "default"`). Fallback-served responses are
  priced at the higher of the two models' prices.
- The SDK retries 429, 5xx and connection errors (2 retries with backoff);
  Tavily calls retry the same way. Authentication, billing and invalid-request
  errors stop the run (`LLM_UNAVAILABLE` / `SEARCH_FAILED`) instead of failing
  page by page.
- Model prices live in `src/integrations/llm/pricing.ts` (list prices as of
  2026-10-06). Models not in that table need `ANTHROPIC_INPUT_USD_PER_MTOK` and
  `ANTHROPIC_OUTPUT_USD_PER_MTOK`.

## Checks

```sh
npm run typecheck
npm run web:typecheck
npm run lint
npm test          # unit tests, no database needed
npm run test:db   # database tests against ace_test (migrated automatically)
npm run test:all
```

DB tests refuse to run unless the database name ends in `_test`, and they
truncate all tables between cases.

## Schema changes

Edit `prisma/schema.prisma`, then run `npm run db:migrate -- --name <change>`
(interactive). The initial migration ends with raw SQL for CHECK constraints
and the append-only `AuditEvent` trigger. Keep any similar additions in
migration files. Partial unique indexes use Prisma's `partialIndexes` preview
feature.

## Production build

```sh
npm run build                                   # API → dist/, dashboard → web/dist/
NODE_ENV=production WEB_DIST_DIR=web/dist npm start
```

With `WEB_DIST_DIR` set, the API serves the dashboard on the same origin.
Production needs HTTPS in front. See [docs/deployment.md](docs/deployment.md)
for the Docker Compose stack with automatic certificates.

## Configuration

- `.env`: validated by `src/config/env.ts`. All providers default to `mock`,
  and real providers require explicit keys. Never commit `.env`.
- `config/scoring.json`: opportunity score weights, which must sum to 1. Bump
  `version` when you change them; stored scores record the version used.
