# AI 客服 ERP 交接文档

更新时间：2026-05-13  
项目路径：`C:\Users\Orion\Documents\Codex\2026-05-06\txt-https-shengji-lingdongsz-com-uranus\meli-ai-support`

## 1. 产品原则

前端只表达客服要完成的任务。  
后端负责权限、店铺隔离、平台对接、状态机、知识检索、意图识别、建议生成、发送回写、审计和降级。

客服前端不要出现这些词：`RAG`、`Chunk`、`Embedding`、`Provider`、`Token`、`tenant`、`storeId`、`API Key`。  
客服前端只出现：买家咨询、售后处理、知识库、建议回复、预设回复、店铺资料、审核、发送。

目标产品不是技术 Demo，而是对标多客/Gobots 的轻量客服 ERP：队列 + 详情 + 回复辅助 + 审核追溯 + 平台回写。

## 2. 当前实现状态

### 已实现

- Docker Compose 可启动 `web / api / worker / postgres / redis`。
- Next.js 前端已改成客服工作台：
  - 今日工作
  - 买家咨询
  - 售后处理
  - 回复审核
  - 知识库
  - 预设回复
  - 处理统计
  - 店铺设置
- 前端客服视图已隐藏技术词。
- Kimi API 已接入后端，密钥只在 `.env`，前端不展示。
- SKU/商品资料 CSV/TXT 上传已可用，并处理 UTF-8 / GB18030 常见乱码。
- 知识库文本录入已可用。
- 售前建议回复可结合商品资料与知识库生成。
- 售后分析已支持：识别问题类型 -> 匹配预设回复模板 -> 生成待审核回复。
- 预设回复模型已加入：
  - `ReplyTemplate`
  - `ReplyTemplateVersion`
- 回复审核接口已加入：`GET /reply-reviews`。
- Mercado Libre OAuth 入口已加入：
  - `GET /auth/meli/start`
  - `GET /auth/meli/callback`
  - `GET /auth/meli/url`
- 若 OAuth 凭证未配置，`/auth/meli/start` 会显示中文配置页，不再裸露 JSON 报错。
- 店铺隔离基础模型已加入：
  - `AppUser`
  - `ShopMember`
  - `ShopIpPolicy`

### 最近验证命令

```powershell
corepack pnpm --filter @meli-ai-support/api typecheck
corepack pnpm --filter @meli-ai-support/web build
$env:DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/meli_ai_support'; corepack pnpm --filter @meli-ai-support/db exec prisma db push --schema prisma/schema.prisma --accept-data-loss
docker compose build api worker web
docker compose up -d api worker web
```

### 当前本地地址

```txt
前端：http://127.0.0.1:3000
后端：http://127.0.0.1:3001
授权入口：http://127.0.0.1:3001/auth/meli/start
```

## 3. OAuth 研究结论

结论：不能真正绕过开发者应用直接 OAuth。  
Mercado Libre OAuth 授权 URL 必须带 `client_id`，token 交换必须带 `client_id`、`client_secret`、`code`、`redirect_uri`，且 `redirect_uri` 必须与应用后台配置一致。

也就是说，“浏览器一键授权”可以做到，但前提是平台管理员先配置好官方应用：

```env
MELI_CLIENT_ID=
MELI_CLIENT_SECRET=
MELI_REDIRECT_URI=http://127.0.0.1:3001/auth/meli/callback
```

非技术人员最终体验可以做到：

```txt
打开工作台 -> 点击“授权 Mercado Libre 店铺” -> 登录店铺账号 -> 同意授权 -> 自动回到工作台
```

非技术人员不需要进开发者中心，不需要看到 Client ID / Secret / Redirect URI。

### 后续 Agent 注意

不要继续研究“完全无应用 OAuth”。官方路径不支持。应把它产品化为“管理员一次性配置应用，商家一键授权店铺”。

## 4. Mercado Libre 接口前置调研

### OAuth

官方能力：

- 授权 URL：`response_type=code&client_id=$APP_ID&redirect_uri=$YOUR_URL`
- Token Endpoint：`https://api.mercadolibre.com/oauth/token`
- Access token 有有效期，后续用 refresh token 刷新。

当前代码位置：

- `apps/api/src/server.ts`
- `buildMeliAuthUrl`
- `exchangeCodeForToken`
- `refreshMeliToken`
- `fetchMeliMe`

### 售前 Questions

官方 Global Selling 文档的核心接口：

```txt
GET  /marketplace/questions/search
GET  /marketplace/questions/{QUESTION_ID}
POST /marketplace/answers
DELETE /marketplace/questions/{QUESTION_ID}
```

官方文档也明确建议高问题量卖家做半自动回复：基于频繁关键词给客服建议答案，再由客服/系统发送。

产品设计：

```txt
Question webhook
-> 入库
-> 拉 question 详情
-> 拉 item / SKU / 店铺政策
-> 知识库检索
-> 生成建议回复
-> 敏感话术检查
-> 审核/自动审批策略
-> POST /marketplace/answers
-> 审计日志
```

注意：售前回答通常只有一次机会，必须做状态复查与幂等。

### 售后 Messages

官方能力：

```txt
GET  /marketplace/messages/unread
GET  /marketplace/messages/packs/{PACK_ID}
POST /marketplace/messages/packs/{PACK_ID}
```

注意：

- pending/unread endpoint 可作为 webhook 漏消息兜底。
- 读取消息时要注意是否会标记已读，必要时带 `mark_as_read=false`。
- 售后消息可以发送 `text`，部分场景支持 `text_translated`。

产品设计：

```txt
Message webhook
-> 入库
-> 拉 pack 消息
-> 拉订单/物流/claim/return 上下文
-> 意图识别
-> 匹配预设回复
-> 风险检查
-> 自动发送或进入审核
-> 发送回写
-> 审计日志
```

### 订单 / Pack / 物流

官方强调 pack 与 order 的差异：

- 如果通知里是 pack_id，应查询 pack。
- 一个 pack 可包含多个 order。
- 购买级别信息应围绕 pack，再迭代 order_id。

常用接口方向：

```txt
GET /marketplace/orders/pack/{PACK_ID}
GET /marketplace/orders/{ORDER_ID}
GET /marketplace/shipments/{SHIPMENT_ID}
GET /marketplace/shipments/{SHIPMENT_ID}/items
```

### Claims / Returns

官方新的退货路径：

```txt
GET /post-purchase/v1/claims/search
GET /post-purchase/v2/claims/{CLAIM_ID}/returns
```

Global Selling Claims 文档也存在新的 marketplace claims 路径，后续实际接入时要按账号站点与应用权限实测：

```txt
GET /marketplace/v2/claims/{CLAIM_ID}
```

Claims/Returns 一律先按高风险处理，不建议第一版自动发送。

### Notifications

官方通知要求配置公网可访问 Callback URL。可订阅主题包括：

```txt
marketplace questions
marketplace messages
marketplace orders
marketplace shipments
marketplace claims
```

本地开发如果要真实收 webhook，需要：

- ngrok / cloudflared 临时公网地址，或
- 直接部署到云服务器。

后端 webhook 原则：只验收、入库、入队，马上 200；不要在 webhook 请求里跑 AI 或拉大量 API。

## 5. 售前 RAG 方案

### 强制原则

售前建议回复必须优先引用知识库。  
如果知识库无命中或低相关，不允许模型编造商品规格、保修承诺、发票规则、物流承诺。

### 推荐后端策略

1. 批量入库
   - 商品资料、FAQ、发票规则、保修政策、物流说明、退换货规则、平台禁用话术统一走知识库处理任务。
   - 不要让每条资料零散即时切片、即时入库，容易导致索引不一致。

2. 自适应召回数量
   - 短问题：少量召回，避免冗余。
   - 长问题/多意图：增加召回。
   - SKU 明确时，SKU 资料强制置顶。

3. 动态相关度门槛
   - SKU 精确命中优先。
   - 高匹配：可直接用于回复依据。
   - 中匹配：给模型参考，但提示可能不完整。
   - 低匹配：不要作为事实依据，只能生成“需要人工确认/请补充信息”类安全回复。

4. 混合检索
   - 当前代码是词法检索 + SKU 强匹配。
   - 下一步应实现 TF-IDF/BM25 + 向量检索混合排序。
   - PostgreSQL 已使用 pgvector 镜像，但 embedding 字段尚未真正写入。

5. 结果约束
   - AI 输出必须包含引用资料 ID。
   - 没有引用资料的事实性句子应被拒绝或要求人工审核。

### 建议新增表/字段

当前已有：

- `KbDocument`
- `KbChunk`
- `SkuKnowledge`

建议补强：

```txt
knowledge_processing_jobs
knowledge_versions
retrieval_tests
retrieval_test_cases
retrieval_eval_runs
```

如果继续用现有表，也至少补：

- chunk token count
- source file name
- source row number
- normalized SKU tags
- last indexed at
- processing error
- citation id

### RAG 可用性测试集

先不依赖 Mercado API，自己造测试集跑闭环：

```txt
产品规格：这个键盘支持 Mac 吗？
发票规则：可以开票吗，需要什么资料？
保修政策：坏了能换吗？
物流说明：什么时候到？
退换货规则：不喜欢可以退吗？
禁用话术：能给 WhatsApp 吗？
价格优惠：能不能私下便宜点？
```

每条测试用例应标注：

```json
{
  "question": "...",
  "sku": "E10146",
  "expectedKnowledge": ["doc-or-sku-id"],
  "mustContain": ["factura"],
  "mustNotContain": ["WhatsApp", "refund promise"],
  "expectedRisk": "low|medium|high"
}
```

## 6. 售后路由方案

### 产品目标

用户发送售后消息后，系统自动识别意图、匹配预设回复，并尽量实时响应。

### 工程安全边界

推荐把“全自动”做成配置化，而不是全局无条件自动发：

```txt
autoReplyMode:
  off
  low_risk_templates_only
  all_templates
```

默认建议：

- 第一阶段：自动推荐，人工确认。
- 第二阶段：低风险模板自动发送。
- 第三阶段：成熟店铺可按模板开启免审。

高风险场景默认不自动发送：

- refund_request
- return_request
- damaged_item
- wrong_item
- claim_opened
- negative_feedback_risk
- not_received but delivered

如果业务强制要求全自动，应至少要求模板本身配置：

```txt
requiresReview=false
allowAutoSend=true
maxRisk=low
```

### 当前实现

当前已有：

- `ReplyTemplate`
- `ReplyTemplateVersion`
- `ensureDefaultReplyTemplates`
- `findBestReplyTemplate`
- `/reply-templates`
- `/reply-reviews`
- 售后 `/aftersale/threads/:id/analyze` 会匹配模板并写入 `suggestedReply`

下一步要做：

- `reply_intents` 独立表
- 模板变量填充更完整
- 模板命中置信度
- 售后发送状态机
- `POST /aftersale/threads/:id/send`
- 自动发送策略表

## 7. 店铺连接与状态真实化

当前前端已业务化展示：

```txt
平台连接
消息同步
客服助手
知识库
```

但当前状态仍有一部分是乐观值，需要后续改成真实状态。

建议后端返回：

```json
{
  "platformConnected": "connected|not_configured|expired|failed",
  "messageSync": "ok|delayed|failed|not_enabled",
  "assistant": "ok|disabled|failed",
  "knowledge": "ready|processing|partial_failed|failed"
}
```

真实判断来源：

- platformConnected：是否存在有效 token，是否能调用 `/users/me`
- messageSync：最近 webhook / polling 成功时间
- assistant：最近一次 Kimi/OpenAI 调用状态
- knowledge：最近一次知识库处理任务状态

## 8. 一键审批

卖家咨询应支持批量审批，但必须后端校验：

```txt
POST /presale/questions/bulk-approve
```

请求：

```json
{
  "ids": ["..."],
  "mode": "selected|all_filtered",
  "filter": {
    "riskLevel": "low",
    "reviewStatus": "draft_ready"
  }
}
```

后端规则：

- 只允许低风险。
- 必须已有建议回复。
- 不能包含禁用话术。
- Mercado question status 必须仍是 unanswered。
- 写审计日志。
- 真正发送仍由发送队列处理，避免一次请求里批量打平台 API。

## 9. 飞书 Webhook 推送

产品需求：

店铺或商家可在前端填写飞书群机器人 Webhook。新售前/售后消息进入系统后，自动推送告警。

注意：

- Webhook URL/Secret 是敏感配置，前端只允许录入和显示“已配置/未配置”，不要回显完整 URL。
- 推荐按店铺保存。
- 推送应进入 outbox 队列，失败可重试，不要阻塞主流程。

建议新增：

```txt
POST /settings/feishu-webhook
POST /settings/feishu-webhook/test
```

建议存储：

```txt
SettingsRule key = feishu_webhook
value = {
  webhookUrlEnc,
  secretEnc,
  enabled,
  notifyPresale,
  notifyAftersale
}
```

消息触发：

```txt
platform event -> ticket/message created -> outbox event -> webhook send -> operation log
```

## 10. 数据模型目标态

当前 Prisma 已有基础表，但离成熟 ERP 还缺统一工单模型。建议后续演进：

```txt
tenants
stores
users
store_members
roles
permissions

tickets
ticket_messages
ticket_status_logs

knowledge_documents
knowledge_items
knowledge_versions
knowledge_processing_jobs

reply_intents
reply_templates
reply_template_versions
reply_template_rules

ai_drafts
ai_intent_results
ai_generation_logs

platform_events
outbox_events
job_attempts
dead_letter_events

audit_logs
```

当前已有表名与目标态映射：

```txt
Shop -> stores
AppUser -> users
ShopMember -> store_members
PresaleQuestion -> tickets(type=presale)
AftersaleThread -> tickets(type=aftersale)
Message -> ticket_messages
KbDocument/KbChunk/SkuKnowledge -> knowledge_*
ReplyTemplate/ReplyTemplateVersion -> reply_templates
AiSuggestion -> ai_* logs
WebhookEvent -> platform_events
OperationLog -> audit_logs
```

## 11. 云部署 / K8s 预设计

建议拆为：

```txt
web Deployment
api Deployment
worker Deployment
postgres StatefulSet or managed Postgres
redis StatefulSet or managed Redis
object storage for uploaded files
ingress with HTTPS
secret manager
```

关键点：

- OAuth callback 必须是公网 HTTPS 域名。
- Mercado notifications callback 必须公网可访问。
- Worker 可水平扩展，但 token refresh 必须 Redis lock。
- 发送 Mercado API 必须 outbox 幂等。
- 每个店铺的 webhook/message/order 处理要带 shopId。
- 密钥只能进 Secret，不进入镜像和前端 bundle。

IP 隔离：

- Mercado API 通常以 OAuth token 权限隔离为核心，不以 IP 作为店铺隔离核心。
- 如果业务要求不同店铺走不同出口 IP，应在后端 HTTP client 层支持 per-shop egress proxy。
- 这属于平台对接层能力，不应该让前端感知。

## 12. 下一位 Agent 的 P0 任务

1. 完成 Mercado Libre OAuth 实测
   - 配好 `MELI_CLIENT_ID`
   - 配好 `MELI_CLIENT_SECRET`
   - 配好 `MELI_REDIRECT_URI`
   - 打开 `/auth/meli/start`
   - 完成回调，确认 shop/token 入库

2. 实现真实平台 client
   - questions search/detail/answer
   - messages unread/get/send
   - pack/order/shipment
   - claims/returns

3. 实现 webhook topic 路由
   - marketplace questions -> presale ticket
   - marketplace messages -> aftersale ticket
   - marketplace claims -> high-risk aftersale ticket
   - marketplace orders/shipments -> enrich context

4. 实现售前发送状态机
   - generate -> review -> approve -> send_pending -> sent/failed
   - 状态复查 unanswered
   - 禁用话术检查
   - 平台发送幂等

5. 实现售后自动路由/发送
   - intent confidence
   - template confidence
   - risk gate
   - autoReplyMode
   - outbox send

6. 实现知识库批量处理任务
   - 文件上传
   - PDF/DOCX/XLSX/TXT/CSV 解析
   - 批量切片
   - embedding
   - hybrid retrieval
   - 评测集

7. 实现飞书 Webhook 配置与测试
   - 配置不回显
   - 测试按钮
   - 新消息告警
   - 失败重试

## 13. 重要安全提醒

- 不要把 `.env` 里的 Kimi key、Mercado Client Secret、Webhook URL 打印到日志或前端。
- 不要把全自动售后回复默认打开。
- 不要跳过 Mercado question status 复查。
- 不要在 webhook HTTP 请求中直接跑 AI。
- 不要让前端判断用户能否访问某店铺；必须后端校验。
- 不要把开发者诊断信息重新塞回客服页面。

## 14. 官方资料

- OAuth / Token：`https://global-selling.mercadolibre.com/devsite/authentication-and-authorization-global-selling`
- Questions & Answers：`https://global-selling.mercadolibre.com/devsite/manage-questions-answers-global-selling/manage-questions-answers-global-selling`
- Notifications：`https://global-selling.mercadolibre.com/devsite/api-docs/receive-notifications`
- Pending Messages：`https://global-selling.mercadolibre.com/devsite/pending-messages-gs`
- Post-sale Messages：`https://global-selling.mercadolibre.com/devsite/api-docs/messaging-after-sale-global-selling`
- Packs / Orders：`https://global-selling.mercadolibre.com/devsite/en_us/packs`
- Shipments：`https://global-selling.mercadolibre.com/devsite/en_us/devsite/manage-shipments`
- Returns：`https://developers.mercadolibre.com.ar/en_us/product-identifiers/ml-returns`
- Claims：`https://global-selling.mercadolibre.com/devsite/api-docs/manage-claims`
