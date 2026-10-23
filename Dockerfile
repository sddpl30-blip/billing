# The backend image.
#
# NOT VERIFIED BY A BUILD. The machine this was written on has a docker binary
# and no reachable daemon, so this file has never been built or run. It is
# written from the project's actual layout — which is checked — rather than
# from a template, but treat the first build as a build that may need fixing
# rather than as a proven one.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json* ./
# The backend itself has no runtime dependencies: it is built on node's own
# modules. TypeScript is needed to compile it, and npm ci needs a lockfile, so
# this falls back to install when there is none.
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY tsconfig.server.json ./
COPY server ./server
COPY src/accounting ./src/accounting
COPY scripts/server.mjs scripts/load-env.mjs ./scripts/
RUN node scripts/server.mjs build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# postgresql-client is here for one reason: server/migrate.mjs applies the
# migrations through psql. Without it the image can serve but cannot migrate.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/.server-build ./.server-build
COPY server/migrations ./server/migrations
COPY server/migrate.mjs ./server/migrate.mjs
# migrate.mjs reads .env through this; without it the migrate service crashes.
COPY scripts/load-env.mjs ./scripts/load-env.mjs
COPY package.json ./

# Not root. A process that only needs to read its own code and talk to a
# database has no business being able to write its own image.
USER node

EXPOSE 4000

# The health endpoint reports degraded with a 503 when the database is
# unreachable, so this check means what it says.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

CMD ["node", ".server-build/server/src/app.js"]
