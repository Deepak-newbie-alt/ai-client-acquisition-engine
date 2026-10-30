# Deployment

The production setup is a single host running four containers from
`docker-compose.production.yml`:

| Service | Role | Exposed |
|---|---|---|
| `db` | PostgreSQL 17 | internal network only |
| `migrate` | runs `prisma migrate deploy`, then exits | no |
| `app` | API + built dashboard, one Node process | internal network only (port 3000) |
| `caddy` | HTTPS termination, automatic Let's Encrypt certificates | 80, 443 |

The API serves the dashboard itself (`WEB_DIST_DIR`), so the browser talks to
one origin. The session cookie, CSRF origin check and CSP all rely on that.

## First deploy

Requirements: a Linux host with Docker Engine and the Compose plugin, a DNS
`A`/`AAAA` record for your domain pointing at it, and ports 80 and 443 open.

```sh
git clone <your repo> ace && cd ace
cp .env.production.example .env.production
chmod 600 .env.production
# Edit .env.production: DOMAIN, APP_ORIGIN (https://<DOMAIN>), POSTGRES_PASSWORD
# and the same password inside DATABASE_URL.
docker compose -f docker-compose.production.yml --env-file .env.production up -d --build
```

Startup order: `db` becomes healthy, `migrate` applies migrations and exits 0,
then `app` starts and `caddy` obtains the certificate. Check with:

```sh
docker compose -f docker-compose.production.yml --env-file .env.production ps -a
curl -fsS https://<DOMAIN>/api/health
```

Create the first user. The scripts live in the `migrate` image, which carries
the dev tooling. The password is read from stdin:

```sh
docker compose -f docker-compose.production.yml --env-file .env.production \
  run --rm -T migrate npx tsx scripts/create-user.ts --email you@example.com --name "You" --role ADMIN
```

Service tokens for n8n work the same way (`scripts/create-service-token.ts`,
`scripts/service-tokens.ts`). See [n8n/README.md](../n8n/README.md).

## Updates

```sh
git pull
docker compose -f docker-compose.production.yml --env-file .env.production up -d --build
```

Take a backup first if the update contains migrations
([operations.md](operations.md#backups)). `app` waits for `migrate` to exit
successfully. If a migration fails, Compose reports the failed dependency and
`docker compose logs migrate` shows why. Restore from the backup if the
database was left half-migrated.

## What production mode changes

`NODE_ENV=production` (set by the image) enables:

- `APP_ORIGIN` must be `https://`. The config refuses to load otherwise.
- `Secure` session cookies, HSTS and the CSP `upgrade-insecure-requests` directive.
- The Gmail recipient allowlist becomes optional. Leave it set if you want a
  hard limit on who can ever be emailed.

The compose file also sets `TRUST_PROXY=1`, so rate limits use the client
address that Caddy reports. Caddy discards any `X-Forwarded-For` sent by clients.
Do not set `TRUST_PROXY` when nothing sits in front of the API: clients could
then fake their address and get around the login rate limit.

The `app` container runs as the unprivileged `node` user with a read-only root
filesystem and `no-new-privileges`.

## Without Docker

```sh
npm ci && npm --prefix web ci
npm run build                 # API → dist/, dashboard → web/dist/
npm run db:deploy             # needs DATABASE_URL
NODE_ENV=production WEB_DIST_DIR=web/dist npm start
```

Put any HTTPS reverse proxy in front (Caddy, nginx, a cloud load balancer) and
set `TRUST_PROXY` to the number of proxies. Bind the API to `127.0.0.1`
(the default `HOST`) so it is reachable only through the proxy.

## Managed Postgres

A managed database (with automated backups and point-in-time recovery) is a
good replacement for the `db` service. Point `DATABASE_URL` at it with
`?sslmode=require`, then remove `db` and the `depends_on` on it from the
compose file.

## Building behind a TLS-inspecting proxy or antivirus

If `npm ci` fails inside `docker build` with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
something on the network is re-signing HTTPS traffic. Pass its root certificate
(PEM) as a build secret. It is used only for the dependency downloads and is
not stored in the image:

```sh
docker build --secret id=extra_ca,src=proxy-root.pem -t ace .
```

Do not disable TLS verification (`strict-ssl=false`) instead.
