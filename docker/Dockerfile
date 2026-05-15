# syntax=docker/dockerfile:1.7

FROM node:22-slim AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm \
  PATH=/pnpm:$PATH \
  NEXT_TELEMETRY_DISABLED=1
RUN corepack enable \
  && apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/ai-core/package.json packages/ai-core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/meli-client/package.json packages/meli-client/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY apps apps
COPY packages packages
RUN pnpm --filter @meli-ai-support/db prisma:generate \
  && pnpm -r build

FROM build AS api-deploy
RUN pnpm --filter @meli-ai-support/api deploy --prod /prod/api \
  && for target in /prod/api/node_modules/.pnpm/@prisma+client@*/node_modules; do cp -R /app/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma "$target/"; done \
  && rm -rf /prod/api/src

FROM build AS worker-deploy
RUN pnpm --filter @meli-ai-support/worker deploy --prod /prod/worker \
  && for target in /prod/worker/node_modules/.pnpm/@prisma+client@*/node_modules; do cp -R /app/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma "$target/"; done \
  && rm -rf /prod/worker/src

FROM build AS web-deploy
RUN pnpm --filter @meli-ai-support/web deploy --prod /prod/web \
  && rm -rf /prod/web/.next/cache

FROM build AS migrate-deploy
RUN pnpm --filter @meli-ai-support/db deploy /prod/db

FROM base AS migrate
ENV NODE_ENV=production
COPY --from=migrate-deploy --chown=node:node /prod/db ./
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "prisma/schema.prisma"]

FROM base AS api
ENV NODE_ENV=production \
  PORT=3001
COPY --from=api-deploy --chown=node:node /prod/api ./
USER node
EXPOSE 3001
CMD ["node", "dist/apps/api/src/server.js"]

FROM base AS worker
ENV NODE_ENV=production
COPY --from=worker-deploy --chown=node:node /prod/worker ./
USER node
CMD ["node", "dist/apps/worker/src/worker.js"]

FROM base AS web
ENV NODE_ENV=production \
  PORT=3000
COPY --from=web-deploy --chown=node:node /prod/web ./
USER node
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
