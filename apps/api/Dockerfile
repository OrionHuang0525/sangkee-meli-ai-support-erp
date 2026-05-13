FROM node:22-slim AS base
WORKDIR /app
RUN corepack enable
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps apps
COPY packages packages
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @meli-ai-support/db prisma:generate
RUN pnpm --filter @meli-ai-support/shared build
RUN pnpm --filter @meli-ai-support/db build
RUN pnpm --filter @meli-ai-support/ai-core build
RUN pnpm --filter @meli-ai-support/api build

EXPOSE 3001
CMD ["pnpm", "--filter", "@meli-ai-support/api", "start"]
