# syntax=docker/dockerfile:1
# Production image: compiled API + built dashboard, served by one Node process.
# Build:   docker build -t ace .
# Targets: "runtime" (default, last stage) and "migrate" (runs prisma migrate deploy).
#
# Behind a TLS-inspecting proxy or antivirus, pass its root certificate for the
# dependency downloads only (it is not kept in the image):
#   docker build --secret id=extra_ca,src=proxy-root.pem -t ace .

FROM node:22.15.0-alpine AS build
WORKDIR /app
# Dependencies first so they are cached across source changes.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN --mount=type=secret,id=extra_ca,required=false     NODE_EXTRA_CA_CERTS=$([ -f /run/secrets/extra_ca ] && echo /run/secrets/extra_ca) npm ci --no-audit --no-fund
COPY web/package.json web/package-lock.json ./web/
RUN --mount=type=secret,id=extra_ca,required=false     NODE_EXTRA_CA_CERTS=$([ -f /run/secrets/extra_ca ] && echo /run/secrets/extra_ca) npm --prefix web ci --no-audit --no-fund
COPY . .
RUN npm run build

# Applies pending migrations, then exits. Needs the Prisma CLI (a dev dependency).
FROM build AS migrate
ENV NODE_ENV=production
CMD ["npx", "prisma", "migrate", "deploy"]

FROM build AS prod-deps
RUN npm prune --omit=dev

FROM node:22.15.0-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST_DIR=/app/web/dist
WORKDIR /app
COPY --from=prod-deps /app/package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
COPY --from=build /app/web/dist ./web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "--enable-source-maps", "dist/server.js"]
