# Security model

A single-operator tool that reads untrusted web content, calls paid APIs and
can send email. The main risks, and where each is handled:

## Threats and controls

| Threat | Control | Code | Tests |
|---|---|---|---|
| An unapproved or altered email is sent | Approval is bound to the SHA-256 of recipient + subject + body, single-use and time-limited. Send is a separate action that re-checks the approval, content hash, suppression and contact under a row lock. Service tokens and the LLM cannot approve or send. | `modules/outreach/service.ts` | `tests/db/outreach.test.ts` |
| Duplicate sends | `SELECT … FOR UPDATE`, a pre-generated Message-ID, and uncertain outcomes are reconciled by Message-ID instead of resent | same | concurrent-send and uncertain-outcome tests |
| Emailing someone who opted out | Suppression checked on create, approve and send. Opt-out replies suppress automatically. Gmail allowlist outside production. | `modules/contacts/suppression.ts` | `outreach.test.ts`, `email.test.ts` |
| SSRF via search results or redirects | http/https on default ports only. No credentials or IP literals. Public suffix required. DNS answers pinned and checked against private, loopback, link-local and metadata ranges on every connection, redirects included. Size, time and content-type limits. | `lib/url.ts`, `lib/network.ts`, `lib/safe-fetch.ts` | `url`, `network`, `safe-fetch` unit tests |
| Prompt injection in fetched pages | Pages are data inside delimiters, with hidden elements and invisible characters stripped. Output must match a strict schema, every excerpt must appear verbatim in the page, and invented impact figures are reset to unknown. The model has no tools. | `modules/sources/extract.ts`, `modules/evidence/*` | `evidence`, `sources`, `pipeline` tests |
| HTML/script injection in the dashboard | React escapes all text. External links go through `safeHref` (http/https only) with `rel="noopener noreferrer"`. CSP `script-src 'self'`, `frame-ancestors 'none'`. | `web/src/api.ts`, `app.ts` | `security.test.ts` |
| Email header injection | Control characters rejected in headers; subjects are single-line | `integrations/email/mime.ts` | `email.test.ts`, `outreach.test.ts` |
| CSRF | SameSite=Strict cookie, a required `X-ACE-CSRF` header, and an Origin check | `middleware/csrf.ts` | `api.test.ts` |
| Stolen session or token | Only hashes stored. HttpOnly + Secure (production) cookie with TTL. Revocable service tokens with narrow scopes. | `modules/auth/*` | `api.test.ts` |
| Brute-force login | scrypt (N=2¹⁷), dummy verification for unknown users, 10 attempts / 15 min per client IP | `modules/auth/*`, `app.ts` | `api.test.ts`, `security.test.ts` |
| Runaway API spend | Worst-case cost reserved under an advisory lock before each paid call. Per-run and monthly budgets. Rate limits on run creation and drafting. | `modules/research/budget.ts` | `pipeline.test.ts` |
| Secrets leaking | Keys only server-side, validated config that never prints values, log redaction, error serializer that drops request configs, audit metadata sanitizer, generic 500 responses | `config/env.ts`, `lib/logger.ts`, `modules/audit/audit.ts` | `config`, `logger`, `security` tests |
| Tampering with history | `AuditEvent` is append-only (database trigger). CHECK constraints guard money, scores and send states. | `prisma/migrations/*_init` | `constraints.test.ts` |

## Roles

- `ADMIN`: everything, including removing suppressions.
- `REVIEWER`: everything else, including approving and sending. In this
  single-operator tool the reviewer is the sender. If you need two people
  (one approves, another sends), that is a small change in
  `requireUser(...)` on the send route.
- Service tokens: `research:read`, `research:write`, `outreach:sync` only.
  They never see companies, contacts, drafts, suppressions or the audit log.

## Known limitations

- Rate limits and the research queue are in-process. Run one API instance only.
- Opt-out detection reads Gmail's short reply snippet with a keyword match. It
  errs towards suppressing. Read replies yourself.
- The mock email provider keeps its sent log in memory. After a restart,
  reconcile cannot find mock sends and marks them failed after the grace period.
- DNS pinning protects the fetcher itself. Nothing beyond the fetcher (e.g. a
  corporate proxy) is in scope.
- There is no account management UI. Users and tokens are managed with the
  scripts in `scripts/`.
- Compliance (GDPR legitimate interest, CAN-SPAM / PECR, etc.) depends on
  where you and your recipients are. The app gives you an opt-out line, a
  postal address footer, suppression and an audit trail, but it cannot decide
  whether a given email is lawful.

## Reporting

This is a personal project. If you find a problem, fix it in a branch with a
test that fails before the fix.
