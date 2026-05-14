# syntax=docker/dockerfile:1.7

FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable \
  && apt-get update -y \
  && apt-get install -y openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/ai-core/package.json packages/ai-core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/meli-client/package.json packages/meli-client/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile=false

FROM deps AS source
COPY apps apps
COPY packages packages

FROM source AS api
RUN pnpm --filter @meli-ai-support/db prisma:generate \
  && pnpm --filter @meli-ai-support/shared build \
  && pnpm --filter @meli-ai-support/db build \
  && pnpm --filter @meli-ai-support/ai-core build \
  && pnpm --filter @meli-ai-support/api build
EXPOSE 3001
CMD ["pnpm", "--filter", "@meli-ai-support/api", "start"]

FROM source AS worker
RUN pnpm --filter @meli-ai-support/db prisma:generate \
  && pnpm --filter @meli-ai-support/shared build \
  && pnpm --filter @meli-ai-support/db build \
  && pnpm --filter @meli-ai-support/ai-core build \
  && pnpm --filter @meli-ai-support/worker build
CMD ["pnpm", "--filter", "@meli-ai-support/worker", "start"]

FROM source AS web
RUN pnpm --filter @meli-ai-support/web build
EXPOSE 3000
CMD ["pnpm", "--filter", "@meli-ai-support/web", "start"]
