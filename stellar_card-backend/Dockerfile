# Multi-stage build for stellar_card-backend.
#
#   deps       — full install (toolchain + all deps) for native-module compilation
#   deps-prod  — production-only install (devDependencies excluded)
#   builder    — copies source into the pruned production dependency tree
#   runner     — minimal runtime image, non-root user, health-checked (<150 MB)
#   base       — alias of deps kept for the root docker-compose.yml (`target: base`)
#   dev        — hot-reload overlay for docker-compose.dev.yml
#   test       — runs unit + integration suites; targeted by docker-compose.test.yml
#
# The default (final) stage is `runner`, so a bare
# `docker build stellar_card-backend` produces the production artefact.

# ── Stage 1: deps ────────────────────────────────────────────────────────────
# Installs ALL dependencies so better-sqlite3 compiles against the
# build toolchain.  The toolchain and devDependencies never reach the
# final image.
FROM node:20-alpine AS deps

WORKDIR /app

RUN apk add --no-cache python3 make g++ sqlite-dev

COPY package*.json ./
RUN npm ci

# ── Stage 2: deps-prod ───────────────────────────────────────────────────────
# Re-installs with --omit=dev so the production image carries only the
# packages listed under "dependencies".  A clean install in its own stage
# (rather than `npm prune` on the full tree) produces a deterministic layer:
# source changes never invalidate it.
FROM node:20-alpine AS deps-prod

WORKDIR /app

RUN apk add --no-cache python3 make g++ sqlite-dev

COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 3: builder ─────────────────────────────────────────────────────────
# Combines the pruned production modules with the application source.
FROM deps-prod AS builder

COPY src ./src
COPY jsconfig.json ./

RUN mkdir -p /app/data

# ── Stage 4: runner ──────────────────────────────────────────────────────────
# Minimal production image: no compiler, no devDependencies, non-root user.
# Runs as uid 10001 so the process is unprivileged even if /etc/passwd is
# modified in the host namespace.
FROM node:20-alpine AS runner

ENV NODE_ENV=production \
    PORT=4000 \
    DB_PATH=/app/data/stellar_card.db

WORKDIR /app

# sqlite-libs: shared library required at runtime by better-sqlite3.
# tini: PID-1 signal forwarding and zombie reaping.
RUN apk add --no-cache sqlite-libs tini \
    && addgroup -g 10001 -S app \
    && adduser  -u 10001 -S app -G app \
    && mkdir -p /app/data \
    && chown -R app:app /app

COPY --from=builder --chown=app:app /app/package*.json ./
COPY --from=builder --chown=app:app /app/node_modules  ./node_modules
COPY --from=builder --chown=app:app /app/src            ./src
COPY --from=builder --chown=app:app /app/jsconfig.json ./

USER 10001

EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:4000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]

# ── Stage 5: base ────────────────────────────────────────────────────────────
# Retained so the root docker-compose.yml (`target: base`) and any
# out-of-tree consumers continue working without changes.
FROM deps AS base

COPY src ./src
COPY jsconfig.json ./

RUN mkdir -p /app/data

ENV NODE_ENV=production \
    PORT=4000 \
    DB_PATH=/app/data/stellar_card.db

EXPOSE 4000

CMD ["npm", "start"]

# ── Stage 6: dev ─────────────────────────────────────────────────────────────
# Hot-reload overlay for docker-compose.dev.yml.  Relies on a bind mount
# for src/ so an edit on the host restarts the server without a rebuild.
#
# Does not reuse the `dev` npm script because that script passes
# `--env-file=.env`; Node exits non-zero when that file is absent.
# Under Compose the environment is supplied via `environment:` / `env_file:`.
FROM base AS dev

ENV NODE_ENV=development

CMD ["node", "--watch", "src/index.js"]

# ── Stage 7: test ────────────────────────────────────────────────────────────
# Runs the full test suite (unit + integration) inside the container.
# Targeted by docker-compose.test.yml.  Uses the full dependency tree
# from the `deps` stage so devDependencies (test runners, fixtures, etc.)
# are available.
FROM deps AS test

COPY src    ./src
COPY test   ./test
COPY jsconfig.json ./

RUN mkdir -p /app/data

ENV NODE_ENV=test \
    DB_PATH=/tmp/stellar_card_test.db

CMD ["npm", "test"]
