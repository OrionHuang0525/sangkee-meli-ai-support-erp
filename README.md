# Meli AI Support

Mercado Libre 售前问答草稿、售后消息分析、SKU 知识库和人工审核发送系统。

当前版本定位不是一次性脚本，而是一个可继续长成多店铺客服 ERP 的基础骨架：

- OAuth 授权入口已预留。
- Webhook 入库、去重、异步队列已接好。
- SKU 知识库可在前端上传 CSV/JSON。
- 售前问题可生成草稿、人工批准、dry-run 发送。
- 售后线程可生成摘要、分类、风险等级、建议动作和回复草稿。
- OpenAI/API Key 只从后端环境变量读取，前端只显示是否已配置。
- 默认 `AI_PROVIDER=local`，不用外部模型也能跑通 MVP 流程；后续把 `packages/ai-core` 替换成真实模型调用即可。

## 服务

- Web: Next.js, http://127.0.0.1:3000
- API: Express, http://127.0.0.1:3001
- Worker: BullMQ
- DB: PostgreSQL + pgvector
- ORM: Prisma
- Queue: Redis

## 本地 Docker 启动

首次准备：

```powershell
copy .env.example .env
corepack pnpm install
corepack pnpm db:generate
docker compose up -d postgres redis
docker exec meli-ai-support-postgres-1 psql -U postgres -d meli_ai_support -c "create extension if not exists vector; create extension if not exists pgcrypto;"
$env:DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/meli_ai_support"
corepack pnpm --filter @meli-ai-support/db exec prisma db push --schema prisma/schema.prisma
```

完整容器运行：

```powershell
docker compose build api worker web
docker compose up -d
```

检查：

```powershell
Invoke-RestMethod http://127.0.0.1:3001/health
```

如果返回 `success: true`，后端已正常运行。

## Demo 流程

启动后打开：

```txt
http://127.0.0.1:3000
```

点击 `初始化 Demo 数据`，系统会创建：

- 1 个 Demo 店铺。
- SKU `E10146` 的知识库。
- 1 条售前问题。
- 1 条售后线程。

之后可以在前端验证：

- SKU 知识库上传。
- 售前生成草稿、人工批准、dry-run 发送。
- 售后分析分类、风险等级、建议动作。

## SKU 知识库 CSV 字段

推荐表头：

```csv
sku,itemId,title,brand,category,sellingPoints,faq,warrantyPolicy,invoicePolicy,shippingNotes,returnPolicy,forbiddenNotes
```

最少需要：

```csv
sku,title
```

## OAuth

Mercado Libre OAuth 入口：

```txt
GET /auth/meli/start
GET /auth/meli/callback
POST /auth/meli/refresh
```

`.env` 里配置：

```env
MELI_CLIENT_ID=
MELI_CLIENT_SECRET=
MELI_REDIRECT_URI=http://127.0.0.1:3001/auth/meli/callback
```

授权完成后，token 会加密保存在数据库里。

## AI Key 预留

后端环境变量：

```env
OPENAI_API_KEY=
OPENAI_REPLY_MODEL=
OPENAI_ANALYSIS_MODEL=
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
AI_PROVIDER=local
```

当前 `AI_PROVIDER=local` 使用规则引擎跑通全流程。接入真实模型时，只改后端和 `packages/ai-core`，不要把 API Key 暴露给前端。

## 安全边界

- 默认不自动发送真实 Mercado Libre 回复。
- 售前 `/send` 当前只做 dry-run，除非后续显式打开真实发送。
- 售后第一版只分析，不自动回复。
- Webhook 只入库和入队，耗时逻辑都在 Worker。
- 所有人工批准、发送模拟、知识库导入都会写操作日志。
