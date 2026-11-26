# plughive daemon image.
#
#   docker build -t plughive .
#   docker build -t plughive --build-arg WITH_CHROMIUM=1 .   # adds screenshot_url
#   docker build -t plughive --build-arg WITH_NPM=1 .        # keeps npm/npx, for
#                                                            # stdio mounts run with npx
#
# The daemon listens on 0.0.0.0:7777 inside the container and keeps all state
# in /data. It refuses to start on 0.0.0.0 without PLUGHIVE_ACCESS_KEY, or
# without PLUGHIVE_SECRETS_PASSPHRASE (saved provider keys are encrypted).
# Each of the three also reads from a file: PLUGHIVE_ACCESS_KEY_FILE, ...
# See docker-compose.yml for a complete setup.
#
# Hardening: Debian 13 slim base pinned by digest, Debian security updates
# applied at build time, no compilers or package managers (apt lists, npm,
# corepack, yarn) in the final image, no setuid/setgid binaries, application
# files owned by root and read-only to the daemon, runs as uid 1000.

# Pinned by digest so a rebuild gets the same base image; bump it on purpose
# (docker buildx imagetools inspect node:22-trixie-slim). Dependabot proposes
# updates.
ARG NODE_IMAGE=node:22-trixie-slim@sha256:f0960f8dc047f358e3fb428f36ccba21732194fa5f0cac849f401e63e62fb9e6

# ---------------------------------------------------------------------------
# build: compile the daemon and the dashboard
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
RUN apt-get -o Acquire::Retries=5 update \
  && apt-get -o Acquire::Retries=5 install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --config.fetch-retries=5 \
      --config.package-import-method=copy
COPY . .
RUN pnpm build \
  && find dist -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.tsbuildinfo' -o -name '*.test.js' \) -delete

# ---------------------------------------------------------------------------
# deps: production dependencies of the daemon only
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
RUN apt-get -o Acquire::Retries=5 update \
  && apt-get -o Acquire::Retries=5 install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --frozen-lockfile --prod --filter plughive --config.node-linker=hoisted \
      --store-dir /pnpm-store --config.fetch-retries=5 --config.package-import-method=copy \
  # Nothing at runtime reads these: docs, type declarations, source maps,
  # native-module build leftovers.
  && find node_modules -type f \( -name '*.md' -o -name '*.markdown' -o -name '*.d.ts' \
       -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' -o -name '*.ts.map' \
       -o -name 'CHANGELOG*' -o -name '*.o' -o -name '*.a' -o -name '*.lib' -o -name '*.obj' \) -delete \
  && find node_modules -depth -type d \( -name test -o -name tests -o -name __tests__ \
       -o -name example -o -name examples -o -name obj.target -o -name .deps \) \
       -path '*/node_modules/*' -exec rm -rf {} + \
  # better-sqlite3 keeps its SQLite sources next to the compiled addon.
  && rm -rf node_modules/better-sqlite3/deps node_modules/better-sqlite3/src node_modules/.cache \
  # The image is glibc: the musl builds of sharp/libvips and keyring never load.
  && find node_modules -maxdepth 2 -type d \( -name '*linuxmusl*' -o -name '*-musl' \) -exec rm -rf {} +

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG WITH_CHROMIUM=0
ARG WITH_NPM=0
ARG VERSION=dev

# The source label links the published ghcr.io package to the repository.
LABEL org.opencontainers.image.title="plughive" \
      org.opencontainers.image.description="A local MCP gateway: one endpoint for your agents, with your own provider keys." \
      org.opencontainers.image.source="https://github.com/stdevMac/plughive" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"

# Security updates on top of the pinned base; ffmpeg and ffprobe for the local
# media tools, pandoc for the pdf pack, tini to forward signals so the daemon
# shuts down cleanly. Then: drop the package managers Node ships with (unless
# WITH_NPM=1), and every setuid/setgid bit.
RUN apt-get -o Acquire::Retries=5 update \
  && apt-get -o Acquire::Retries=5 upgrade -y --no-install-recommends \
  && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ffmpeg pandoc tini ca-certificates \
  # ffmpeg pulls in the Mesa GPU drivers (with LLVM and z3, ~200 MB). libGL only
  # loads them on demand for on-screen or GPU output, which a headless server
  # never does, so drop them; the checks below fail the build if ffmpeg or
  # ffprobe would miss a library.
  && dpkg --purge --force-depends $(dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' \
       libgl1-mesa-dri libglx-mesa0 libegl-mesa0 mesa-libgallium mesa-vulkan-drivers \
       mesa-va-drivers mesa-vdpau-drivers 'libllvm*' libz3-4 2>/dev/null | awk '$1 == "ii" { print $2 }') \
  && ! ldd /usr/bin/ffmpeg /usr/bin/ffprobe | grep 'not found' \
  && ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=duration=1:size=320x240 \
       -c:v libx264 -f null - \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt/* /var/log/dpkg.log \
       /usr/share/doc/* /usr/share/man/* /usr/share/info/* /usr/share/lintian/* \
  && if [ "$WITH_NPM" != "1" ]; then \
       rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
              /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
              /usr/local/include/node /root/.npm; \
     fi \
  && { find / -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null || true; }

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
  && chmod 755 /app/dist/src/cli.js \
  && mkdir -p /data \
  && chown 1000:1000 /data \
  && chmod 700 /data

ENV NODE_ENV=production \
    PLUGHIVE_HOME=/data \
    PLUGHIVE_BIND_HOST=0.0.0.0 \
    PLUGHIVE_PORT=7777 \
    PLUGHIVE_SECRETS=file \
    PLUGHIVE_NO_DOTENV=1

# Numeric so Kubernetes runAsNonRoot can verify it (1000 is the node user).
USER 1000:1000
VOLUME ["/data"]
EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PLUGHIVE_PORT||7777)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/src/cli.js"]
CMD ["start"]
