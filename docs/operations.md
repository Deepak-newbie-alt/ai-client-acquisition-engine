# Operations

## Backups

Everything worth keeping is in PostgreSQL: research, evidence, scores, drafts,
approvals, the suppression list and the audit log. The suppression list matters
most. Losing it could mean emailing someone who opted out.

### Taking a backup

The custom format (`-Fc`) is compressed and restores selectively:

```sh
# Production compose stack
docker compose -f docker-compose.production.yml --env-file .env.production \
  exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backups/ace-$(date +%Y%m%d-%H%M).dump

# Local development database
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d ace_dev -Fc' > backups/ace-dev.dump
```

`backups/` is git-ignored. Suggested routine for a personal deployment:

- Run the command daily from cron on the host, e.g.
  `0 3 * * * cd /srv/ace && <command above>`.
- Keep 7 daily and 4 weekly copies. Delete older files with `find backups -mtime +35 -delete`.
- Copy each dump off the host, encrypted, e.g.
  `age -r <public key> backup.dump > backup.dump.age`, then upload to object storage.
  A backup on the same disk does not survive losing that disk.
- Back up before every deploy that includes migrations.

Dumps contain business contact emails and draft texts, so treat them like the
database: encrypted at rest, restricted access, and deleted on schedule.

### Restoring

Test a restore at least once, and after major upgrades. This restores into a
scratch database without touching the live one:

```sh
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" ace_restore_check'
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d ace_restore_check --no-owner --exit-on-error' < backups/ace-dev.dump
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d ace_restore_check -c "select count(*) from \"AuditEvent\""'
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" ace_restore_check'
```

To replace production data, stop `app` first so nothing writes during the restore:

```sh
DC="docker compose -f docker-compose.production.yml --env-file .env.production"
$DC stop app
$DC exec -T db sh -c 'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
$DC exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < backups/<file>.dump
$DC up -d
```

After restoring an older backup, check outreach before sending anything else:

- Drafts sent after the backup was taken show up as `APPROVED` or `SENDING`
  again. Look in Gmail's Sent folder and record them, or cancel them. Do not
  send them again.
- Opt-outs received after the backup are missing from the suppression list.
  Run the reply check (`POST /api/outreach/check-replies`) before any new send.

## Secrets and rotation

| Secret | Where | How to rotate |
|---|---|---|
| Dashboard passwords | `User.passwordHash` (scrypt) | Create a new user, then disable the old one (set `disabledAt`); disabling ends its sessions. |
| Sessions | `Session.tokenHash` | Sign out, or wait for `SESSION_TTL_HOURS`. |
| Service tokens | `ServiceToken.tokenHash` | `token:create` with a new name, update n8n, then `npm run token:revoke -- --name <old>`. `npm run token:list` shows when each token was last used. |
| `ANTHROPIC_API_KEY`, `TAVILY_API_KEY` | `.env` / `.env.production` | Create a new key in the provider console, update the file, restart `app`, then delete the old key. |
| Gmail OAuth client + refresh token | `.env.production` | Revoke at myaccount.google.com/permissions, create a new refresh token (README), restart. |
| `POSTGRES_PASSWORD` | `.env.production` | `ALTER USER ace PASSWORD '...'`, then update both the password variable and `DATABASE_URL`, and restart. |

The database stores only hashes of tokens and passwords. Provider keys exist
only in the env file and the process environment. They are never logged,
stored in the database, written to the audit log or sent to the dashboard.

## Monitoring

- Health: `GET /api/health` (also the container `HEALTHCHECK`).
- Logs: JSON lines on stdout (`docker compose logs app`). Look for
  `"level":50` (errors), `research run failed`, `send outcome unknown` and
  `reply check failed`.
- Spend: the Research page shows this month's spend against
  `MONTHLY_BUDGET_USD`, and so does `GET /api/usage` (`research:read`). The n8n
  daily digest includes it too. Also set spend limits in the Anthropic and
  Tavily consoles. They work independently of this app's budget.
- Outreach needing attention: drafts in `SENDING` with an unknown outcome
  (filter by status on the Outreach page). Reconcile them, never resend.

## Emergency stop for outreach

Nothing is sent without a person clicking Send on an approved draft, but if you
need to make sending impossible:

1. Set `EMAIL_PROVIDER=mock` and restart `app`. Sends go nowhere, and the
   dashboard banner says so.
2. Or add a domain-wide suppression (Suppression list → scope `DOMAIN`). It is
   re-checked right before every send.
3. Revoke the Gmail grant at myaccount.google.com/permissions to cut access
   outside the app as well.

## Data retention

- Contacts and drafts are business contact data. Delete contacts you will not
  use (Companies → contact → Delete). Contacts with outreach history are kept
  for the audit trail. Their suppression records stay in any case.
- Audit events are append-only by design. To trim old ones, a database owner
  must drop the trigger temporarily. Do this only deliberately and with a backup.
