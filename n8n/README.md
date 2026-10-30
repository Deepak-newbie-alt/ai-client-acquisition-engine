# n8n workflows

n8n only schedules work and passes on notifications. Business logic, budgets,
approval checks and sending stay in the API. n8n authenticates with a service
token whose scopes cannot touch contacts, drafts or sending.

| File | Schedule | Calls | Token scope |
|---|---|---|---|
| `weekly-research.json` | Mondays 07:00 | `POST /api/research-runs` | `research:write` |
| `reply-check.json` | every 30 min | `POST /api/outreach/check-replies` | `outreach:sync` |
| `daily-digest.json` | daily 08:00 | `GET /api/research-runs`, `GET /api/usage` | `research:read` |

These workflows were imported and run in n8n 2.45.6 against a local API.
Each was started from a temporary manual trigger, since the n8n CLI cannot
start schedule triggers.

## Setup

1. Create one token per workflow, so each can be revoked on its own:

   ```sh
   npm run token:create -- --name n8n-research --scopes research:write
   npm run token:create -- --name n8n-replies  --scopes outreach:sync
   npm run token:create -- --name n8n-digest   --scopes research:read
   ```

2. In n8n, create a **Header Auth** credential for each token: name
   `Authorization`, value `Bearer ace_st_...`.
3. Import each JSON file (Workflows → Import from file).
4. In every HTTP Request node, replace `https://ace.example.com` with your API's
   address and select the matching credential.
5. Edit the research focus in **Create research run** (`industry`, `country` as
   an ISO code, `keywords`, `resultLimit` ≤ `RESEARCH_MAX_RESULTS_PER_RUN`).
6. Replace the placeholder notification nodes with a Slack, Telegram or email
   node addressed to yourself. These are notifications to you, not outreach.
   Outreach is sent only from the dashboard.
7. Activate the workflows.

If n8n runs in Docker on the same machine as a development API, use
`http://host.docker.internal:3000`.

## Behaviour to know

- **Create research run** has no retries. A request that times out may still
  have created the run, and a retry would create a second one (and spend
  twice). Runs over budget are refused with `429 BUDGET_EXCEEDED`.
- **Check replies** retries up to 3 times. Recording a reply twice has no
  further effect. The response is `{ checked, replied, optedOut, errors }`, and
  the workflow alerts you when `errors > 0`.
- Rotate tokens with `npm run token:revoke -- --name <name>` after creating a
  replacement under a new name. See `docs/operations.md`.
