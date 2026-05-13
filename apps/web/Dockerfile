FROM node:22-slim AS base
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps apps
COPY packages packages
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @meli-ai-support/web build

EXPOSE 3000
CMD ["pnpm", "--filter", "@meli-ai-support/web", "start"]
