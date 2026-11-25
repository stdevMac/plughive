# plughive daemon image.
#
#   docker build -t plughive .
#   docker build -t plughive --build-arg WITH_CHROMIUM=1 .   # adds screenshot_url
#
# The daemon listens on 0.0.0.0:7777 inside the container and keeps all state
# in /data. It refuses to start on 0.0.0.0 without PLUGHIVE_ACCESS_KEY, or
# without PLUGHIVE_SECRETS_PASSPHRASE (saved provider keys are encrypted).
# Each of the three also reads from a file: PLUGHIVE_ACCESS_KEY_FILE, ...
# See docker-compose.yml for a complete setup.

# Pinned by digest so a rebuild gets the same base image; bump it on purpose
# (docker buildx imagetools inspect node:22-bookworm-slim).
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb

# ---------------------------------------------------------------------------
# build: compile the daemon and the dashboard
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---------------------------------------------------------------------------
# deps: production dependencies of the daemon only
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN pnpm install --frozen-lockfile --prod --filter plughive

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG WITH_CHROMIUM=0

# ffmpeg and ffprobe for the local media tools, pandoc for the pdf pack,
# tini to forward signals so the daemon shuts down cleanly.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg pandoc tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/dist ./dist

# Optional headless Chromium for screenshot_url (adds several hundred MB).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN if [ "$WITH_CHROMIUM" = "1" ]; then \
      node node_modules/playwright/cli.js install --with-deps chromium \
      && rm -rf /var/lib/apt/lists/*; \
    fi

RUN ln -s /app/dist/src/cli.js /usr/local/bin/plughive \
  && chmod +x /app/dist/src/cli.js \
  && mkdir -p /data \
  && chown node:node /data \
  && chmod 700 /data

ENV NODE_ENV=production \
    PLUGHIVE_HOME=/data \
    PLUGHIVE_BIND_HOST=0.0.0.0 \
    PLUGHIVE_PORT=7777 \
    PLUGHIVE_SECRETS=file \
    PLUGHIVE_NO_DOTENV=1

USER node
VOLUME ["/data"]
EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PLUGHIVE_PORT||7777)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/src/cli.js"]
CMD ["start"]
