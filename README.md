# Meli AI Support

面向 Mercado Libre 店铺的售前/售后 AI 客服系统。当前版本包含 Next.js 前端、Express API、BullMQ Worker、PostgreSQL + pgvector、Redis、Prisma、Mercado Libre OAuth/Webhook 和飞书提醒。

## 本地启动

```powershell
copy .env.example .env
corepack pnpm install
corepack pnpm db:generate
docker compose up -d postgres redis
corepack pnpm db:migrate
corepack pnpm dev
```

如果本地数据库之前已经用 `prisma db push` 建过表，首次切换到生产迁移时不要删库，先确认 schema 一致后执行一次：

```powershell
corepack pnpm db:migrate:baseline
corepack pnpm db:migrate:deploy
```

完整容器启动：

```powershell
docker compose build api worker web
docker compose --profile tools run --rm migrate
docker compose up -d
```

检查：

```powershell
Invoke-RestMethod http://127.0.0.1:3001/livez
Invoke-RestMethod http://127.0.0.1:3001/readyz
Invoke-RestMethod http://127.0.0.1:3001/health
```

## 关键接口

- `GET /livez`：轻量存活检查，不访问数据库。
- `GET /readyz`：生产就绪检查，验证 DB、Redis、核心环境变量和 token 加密密钥。
- `GET /health`：诊断状态和业务计数，不再创建 demo 店铺。
- `POST /webhooks/meli`：Mercado Libre webhook 入站，验签、去重、入库、入队。
- `POST /presale/questions/:id/send`：售前发送到 Mercado Libre answers。
- `POST /aftersale/threads/:id/send`：售后发送到 Mercado Libre pack messages。

## 火山引擎部署

首版生产部署采用 ECS + Docker Compose + 火山镜像仓库 CR。RDS PostgreSQL/Redis 托管优先；如果 PostgreSQL 扩展无法启用 `pgvector`，使用 `docker-compose.prod.yml` 里的 `self-hosted-data` profile 自托管数据服务。

服务器建议目录：

```bash
/opt/meli-ai-support
├── docker-compose.prod.yml
├── .env.deploy
├── .env.prod
└── scripts/deploy/volcengine
```

环境文件模板：

- `deploy/volcengine/deploy.env.example`：镜像仓库、端口、健康检查地址。
- `deploy/volcengine/env.prod.example`：运行时密钥、数据库、Redis、Mercado Libre、AI、飞书相关配置。

部署命令：

```bash
APP_DIR=/opt/meli-ai-support scripts/deploy/volcengine/deploy.sh main-latest
APP_DIR=/opt/meli-ai-support scripts/deploy/volcengine/status.sh
APP_DIR=/opt/meli-ai-support scripts/deploy/volcengine/logs.sh api
APP_DIR=/opt/meli-ai-support scripts/deploy/volcengine/rollback.sh <previous-image-tag>
```

如果使用 Nginx 反向代理，可参考 `deploy/volcengine/nginx.conf.example`，将前端域名转发到 `127.0.0.1:3000`，API/OAuth/Webhook 域名转发到 `127.0.0.1:3001`。

## CI/CD

仓库包含两个 GitHub Actions：

- `.github/workflows/ci.yml`：PR 和 main push 执行依赖安装、Prisma client 生成、类型检查、lint、构建。
- `.github/workflows/deploy-volcengine.yml`：main push 或手动触发后构建 `api`、`worker`、`web`、`migrate` 镜像，推送到火山 CR，并通过 SSH 部署到 ECS。

需要配置的 GitHub Secrets：

```txt
VOLCENGINE_CR_REGISTRY
VOLCENGINE_CR_NAMESPACE
VOLCENGINE_CR_USERNAME
VOLCENGINE_CR_PASSWORD
VOLCENGINE_ECS_HOST
VOLCENGINE_ECS_USER
VOLCENGINE_ECS_SSH_KEY
PROD_ENV_FILE
FEISHU_DEPLOY_WEBHOOK
SMOKE_API_URL
SMOKE_WEBHOOK_SECRET
```

## 生产注意事项

- `TOKEN_ENCRYPTION_KEY` 必须固定保存，不能随着部署重新生成，否则 Mercado Libre token 和飞书配置无法解密。
- 生产启用真实发送前，再将 `AUTO_SEND_PRESALE=true`、`AUTO_SEND_AFTERSALE=true`。
- 如果生产库不是空库，首次接入 Prisma migrations 前必须先人工核对 schema，然后执行一次 `pnpm db:migrate:baseline` 标记初始迁移已应用。
- Mercado Libre OAuth 回调必须使用公网 HTTPS：`https://api-support.yourdomain.com/auth/meli/callback`。
- Webhook 地址建议为：`https://api-support.yourdomain.com/webhooks/meli`，同时配置 `WEBHOOK_SHARED_SECRET`。
- 上线后运行 `node scripts/smoke/api-bridge.mjs` 验证 `/readyz`、webhook 入站、worker 消费和售后线程可见性。
