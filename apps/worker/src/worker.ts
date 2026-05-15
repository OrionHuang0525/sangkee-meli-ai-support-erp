import { Queue, Worker } from "bullmq";
import crypto from "node:crypto";
import { Redis } from "ioredis";
import { Prisma, prisma } from "@meli-ai-support/db";
import { generateLocalAftersaleAnalysis, generateLocalPresaleDraft } from "@meli-ai-support/ai-core";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const DEMO_SELLER_ID = BigInt("900000000001");
const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

const presaleQueue = new Queue("meli-presale-question", { connection });
const aftersaleQueue = new Queue("meli-aftersale-message", { connection });
const claimQueue = new Queue("meli-claim-analysis", { connection });

function safeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, current) => {
    if (typeof current === "bigint") return current.toString();
    return current;
  })) as T;
}

function queueJobId(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function firstNumber(value: unknown, fallback: bigint): bigint {
  const match = String(value || "").match(/\d{6,}/);
  return match ? BigInt(match[0]) : fallback;
}

function text(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

type HandoffReason = "buyer_requested_human" | "invoice_required" | "unmatched_other" | "ai_escalation";

type HandoffDecision = {
  required: boolean;
  reason?: HandoffReason;
  label?: string;
};

function decideAftersaleHandoff(input: { category?: string | null; shouldEscalate?: boolean | null; status?: string | null }): HandoffDecision {
  const category = text(input.category);
  if (category === "human_request") return { required: true, reason: "buyer_requested_human", label: "买家要求人工" };
  if (category === "invoice_request") return { required: true, reason: "invoice_required", label: "开票待人工" };
  if (category === "other") return { required: true, reason: "unmatched_other", label: "未识别问题转人工" };
  if (input.status === "human_pending") return { required: true, reason: "ai_escalation", label: "人工待处理" };
  return { required: false };
}

function pickInvoiceValue(value: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const matched = text(match?.[1])
      .replace(/\s+(RFC|raz[oó]n social|nombre fiscal|r[eé]gimen fiscal|regimen|uso de cfdi|cfdi|forma de pago|m[eé]todo de pago|metodo de pago|c[oó]digo postal fiscal|codigo postal fiscal|cp fiscal|c\.?p\.?)\b.*$/i, "")
      .replace(/[。.;；,，]+$/, "");
    if (matched) return matched.slice(0, 80);
  }
  return "";
}

function buildInvoiceFieldSummary(conversationText: string) {
  const compact = conversationText.replace(/\s+/g, " ").trim();
  const fields = [
    {
      label: "RFC",
      value: pickInvoiceValue(compact, [
        /\bRFC\s*[:：]?\s*([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/i,
        /\b([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/i
      ])
    },
    {
      label: "Razón social",
      value: pickInvoiceValue(compact, [
        /raz[oó]n social\s*[:：]?\s*([^,;，；\n]+)/i,
        /nombre fiscal\s*[:：]?\s*([^,;，；\n]+)/i
      ])
    },
    {
      label: "Régimen fiscal",
      value: pickInvoiceValue(compact, [
        /r[eé]gimen fiscal\s*[:：]?\s*([^,;，；\n]+)/i,
        /regimen\s*[:：]?\s*([^,;，；\n]+)/i
      ])
    },
    {
      label: "Uso de CFDI",
      value: pickInvoiceValue(compact, [
        /uso de cfdi\s*[:：]?\s*([^,;，；\n]+)/i,
        /cfdi\s*[:：]?\s*([^,;，；\n]+)/i
      ])
    },
    {
      label: "Forma de pago",
      value: pickInvoiceValue(compact, [
        /forma de pago\s*[:：]?\s*([^,;，；\n]+)/i,
        /m[eé]todo de pago\s*[:：]?\s*([^,;，；\n]+)/i,
        /metodo de pago\s*[:：]?\s*([^,;，；\n]+)/i
      ])
    },
    {
      label: "Código postal fiscal",
      value: pickInvoiceValue(compact, [
        /c[oó]digo postal fiscal\s*[:：]?\s*(\d{5})/i,
        /codigo postal fiscal\s*[:：]?\s*(\d{5})/i,
        /\bcp fiscal\s*[:：]?\s*(\d{5})/i,
        /\bc\.?p\.?\s*[:：]?\s*(\d{5})/i
      ])
    }
  ];

  return fields.map((field) => `- ${field.label}: ${field.value ? `已收到 ${field.value}` : "待买家补充"}`).join("\n");
}

function buildAftersaleHandoffNotice(input: {
  shopName?: string | null;
  handoff: HandoffDecision;
  packId: string;
  orderId?: string | null;
  buyerMessage: string;
  conversationText?: string | null;
  suggestedAction?: string | null;
  suggestedReply?: string | null;
}) {
  const title = input.handoff.reason === "invoice_required"
    ? "[Mercado Libre] 开票待处理"
    : input.handoff.reason === "unmatched_other"
      ? "[Mercado Libre] 未识别售后问题转人工"
      : "[Mercado Libre] 售后转人工提醒";
  const lines = [
    title,
    `Shop: ${input.shopName || "-"}`,
    `Pack: ${input.packId}`,
    `Order: ${input.orderId || "-"}`,
    `Reason: ${input.handoff.label || "-"}`,
    `Buyer message: ${input.buyerMessage}`,
    `Suggested action: ${input.suggestedAction || "-"}`
  ];
  if (input.handoff.reason === "invoice_required") {
    lines.push(
      "",
      "开票资料核对：",
      buildInvoiceFieldSummary(input.conversationText || input.buyerMessage),
      "",
      "客服动作：请优先检查待补充项，确认资料齐全后再人工开票；不要引导买家到 Mercado Libre 站外提交资料。"
    );
  }
  if (input.suggestedReply) lines.push(`Auto reply: ${input.suggestedReply}`);
  return lines.join("\n");
}

const DEFAULT_AFTERSALE_TEMPLATES = [
  {
    name: "转人工安抚",
    intentCode: "human_request",
    category: "human_request",
    keywords: ["humano", "persona", "asesor", "agente", "ejecutivo", "representante", "atención humana", "atencion humana", "supervisor"],
    content: "Hola, claro. Ya notificamos a nuestro equipo de atención y una persona revisará tu caso lo antes posible por este mismo chat de Mercado Libre.",
    variables: ["packId", "orderId"]
  },
  {
    name: "物流未收到",
    intentCode: "not_received",
    category: "shipping_not_received",
    keywords: ["no recibí", "no llego", "no ha llegado", "paquete"],
    content: "Hola, lamentamos lo ocurrido. Te recomendamos revisar el estado del envío desde Mercado Libre. Si el paquete sigue sin actualizarse, por favor continúa el seguimiento desde el flujo oficial de la plataforma.",
    variables: ["orderId", "trackingStatus"]
  },
  {
    name: "发票问题",
    intentCode: "invoice_request",
    category: "invoice_request",
    keywords: ["factura", "facturar", "cfdi", "rfc"],
    content: "Hola, con gusto te apoyamos con la factura. Por favor compártenos por este chat de Mercado Libre tu RFC, razón social, régimen fiscal, uso de CFDI, forma de pago y código postal fiscal para que nuestro equipo pueda revisarlo.",
    variables: ["orderId"],
    requiresReview: true
  },
  {
    name: "商品损坏",
    intentCode: "damaged_item",
    category: "damaged_product",
    keywords: ["dañado", "roto", "quebrado", "defecto", "no funciona"],
    content: "Hola, lamentamos el inconveniente. Para poder revisar el caso, por favor comparte fotos o evidencia del estado del producto dentro del chat de Mercado Libre.",
    variables: ["itemTitle", "sku"]
  },
  {
    name: "退款兜底",
    intentCode: "refund_request",
    category: "refund_request",
    keywords: ["reembolso", "dinero", "refund", "pago"],
    content: "Hola, entendemos tu solicitud. Cualquier reembolso debe revisarse y procesarse mediante el flujo oficial de Mercado Libre según el estado del pedido.",
    variables: ["orderId"]
  },
  {
    name: "未识别问题转人工",
    intentCode: "other",
    category: "other",
    keywords: [],
    content: "Hola, gracias por escribirnos. Vamos a revisar tu caso con nuestro equipo de atención y te responderemos por este mismo chat de Mercado Libre.",
    variables: ["packId", "orderId"],
    requiresReview: true
  }
];

async function ensureDefaultAftersaleTemplates(shopId: string) {
  for (const template of DEFAULT_AFTERSALE_TEMPLATES) {
    await prisma.replyTemplate.upsert({
      where: { shopId_name_version: { shopId, name: template.name, version: 1 } },
      create: {
        shopId,
        name: template.name,
        intentCode: template.intentCode,
        category: template.category,
        language: "es-MX",
        scenario: "售后处理",
        keywords: template.keywords,
        content: template.content,
        variables: template.variables,
        requiresReview: "requiresReview" in template && Boolean(template.requiresReview)
      },
      update: { category: template.category, keywords: template.keywords, content: template.content, variables: template.variables, requiresReview: "requiresReview" in template && Boolean(template.requiresReview) }
    });
  }
}

function fillReplyTemplate(content: string, values: Record<string, unknown>) {
  return content.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => text(values[key]) || "-");
}

function replyTemplateKeywordScore(template: { keywords: string[] }, normalizedText: string) {
  return template.keywords.reduce((total, keyword) => {
    const normalizedKeyword = text(keyword).toLowerCase();
    return total + (normalizedKeyword && normalizedText.includes(normalizedKeyword) ? 1 : 0);
  }, 0);
}

async function findBestReplyTemplate(shopId: string, intentCode: string | null | undefined, latestMessage: string) {
  const templates = await prisma.replyTemplate.findMany({ where: { shopId, active: true }, orderBy: [{ intentCode: "asc" }, { updatedAt: "desc" }] });
  if (!templates.length) return null;
  const normalizedIntent = text(intentCode);
  const normalizedText = latestMessage.toLowerCase();
  const exactMatches = templates.filter((template) => template.intentCode === normalizedIntent);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    const scoredMatches = exactMatches
      .map((template) => ({ template, score: replyTemplateKeywordScore(template, normalizedText) }))
      .sort((a, b) => b.score - a.score || b.template.updatedAt.getTime() - a.template.updatedAt.getTime());
    if (scoredMatches[0]?.score > 0 && scoredMatches[0].score > (scoredMatches[1]?.score ?? -1)) return scoredMatches[0].template;
    return null;
  }
  const scored = templates
    .map((template) => ({ template, score: replyTemplateKeywordScore(template, normalizedText) }))
    .sort((a, b) => b.score - a.score || b.template.updatedAt.getTime() - a.template.updatedAt.getTime());
  if (scored[0]?.score > 0 && scored[0].score > (scored[1]?.score ?? -1)) return scored[0].template;
  return templates.find((template) => template.intentCode === "other") || null;
}

function getEncryptionKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY || "";
  const asBase64 = Buffer.from(raw, "base64");
  if (asBase64.length === 32) return asBase64;
  const asHex = Buffer.from(raw, "hex");
  if (asHex.length === 32) return asHex;
  const utf8 = Buffer.from(raw, "utf8");
  if (utf8.length === 32) return utf8;
  return null;
}

function decryptSecret(payload: string): string {
  const key = getEncryptionKey();
  if (!key) return "";
  try {
    const raw = Buffer.from(payload, "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function buildFeishuPayload(content: string, secret?: string) {
  const payload: Record<string, unknown> = { msg_type: "text", content: { text: content } };
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    payload.timestamp = timestamp;
    payload.sign = crypto.createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
  }
  return payload;
}

async function notifyFeishuForHumanRequest(shopId: string, content: string) {
  const setting = await prisma.settingsRule.findUnique({ where: { shopId_key: { shopId, key: "feishu_webhook" } } });
  const config = setting?.active ? setting.value as { webhookUrlEnc?: string; secretEnc?: string; enabled?: boolean; notifyAftersale?: boolean } : null;
  if (!config?.enabled || config.notifyAftersale === false || !config.webhookUrlEnc) return;
  const webhookUrl = decryptSecret(config.webhookUrlEnc);
  if (!webhookUrl) return;
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify(buildFeishuPayload(content, config.secretEnc ? decryptSecret(config.secretEnc) : ""))
  });
  if (!response.ok) console.warn("[feishu] human request notify failed", response.status, await response.text());
}

async function getShopForEvent(userId?: bigint | null) {
  if (userId) {
    const shop = await prisma.shop.findUnique({ where: { sellerId: userId } });
    if (shop) return shop;
  }

  return prisma.shop.upsert({
    where: { sellerId: userId || DEMO_SELLER_ID },
    create: {
      sellerId: userId || DEMO_SELLER_ID,
      siteId: process.env.MELI_SITE_ID || "MLM",
      nickname: userId ? `SELLER-${userId}` : "DEMO-MELI-SHOP",
      status: userId ? "pending_oauth" : "demo"
    },
    update: {}
  });
}

async function findSku(shopId: string, itemId?: string, sku?: string) {
  const conditions = [
    ...(itemId ? [{ itemId }] : []),
    ...(sku ? [{ sku }] : [])
  ];
  if (!conditions.length) return null;
  return prisma.skuKnowledge.findFirst({ where: { shopId, active: true, OR: conditions } });
}

async function createSuggestion(input: {
  shopId: string;
  targetType: string;
  targetId: string;
  promptVersion: string;
  inputSnapshot: unknown;
  outputJson: unknown;
  outputText: string;
  riskFlags?: string[];
}) {
  await prisma.aiSuggestion.create({
    data: {
      shopId: input.shopId,
      targetType: input.targetType,
      targetId: input.targetId,
      model: process.env.AI_PROVIDER || "local_rules",
      promptVersion: input.promptVersion,
      inputSnapshot: safeJson(input.inputSnapshot) as Prisma.InputJsonValue,
      outputJson: safeJson(input.outputJson) as Prisma.InputJsonValue,
      outputText: input.outputText,
      riskFlags: input.riskFlags || []
    }
  });
}

async function routeWebhookEvent(dedupeKey: string) {
  const event = await prisma.webhookEvent.findUnique({ where: { dedupeKey } });
  if (!event) throw new Error(`webhook event not found: ${dedupeKey}`);
  if (event.status === "processed") return;

  await prisma.webhookEvent.update({ where: { id: event.id }, data: { attempts: { increment: 1 }, status: "processing" } });

  if (event.topic === "questions") {
    await presaleQueue.add("process-presale-question", { eventId: event.id }, { jobId: queueJobId(event.dedupeKey || event.id) });
  } else if (event.topic === "messages") {
    await aftersaleQueue.add("process-aftersale-message", { eventId: event.id }, { jobId: queueJobId(event.dedupeKey || event.id) });
  } else if (event.topic === "claims") {
    await claimQueue.add("process-claim", { eventId: event.id }, { jobId: queueJobId(event.dedupeKey || event.id) });
  }

  await prisma.webhookEvent.update({ where: { id: event.id }, data: { status: "processed", processedAt: new Date() } });
}

async function processPresaleQuestion(eventId: string) {
  const event = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
  if (!event) throw new Error(`event not found: ${eventId}`);

  const payload = (event.rawPayload || {}) as Record<string, unknown>;
  const shop = await getShopForEvent(event.userId);
  const questionId = firstNumber(payload.question_id || payload.id || event.resource, BigInt(Date.now()));
  const itemId = text(payload.item_id || payload.itemId || payload.item || "MLM-DEMO-ITEM");
  const sku = text(payload.sku || payload.SKU || payload.seller_sku);
  const questionText = text(payload.text || payload.question || payload.message || "¿Facturan y tiene garantía?");

  const question = await prisma.presaleQuestion.upsert({
    where: { questionId },
    create: {
      shopId: shop.id,
      questionId,
      itemId,
      buyerId: firstNumber(payload.buyer_id, BigInt(0)) || null,
      questionText,
      questionStatus: text(payload.status) || "UNANSWERED",
      rawQuestion: safeJson(payload) as Prisma.InputJsonValue,
      rawItem: safeJson({ id: itemId, sku, title: payload.item_title || payload.title }) as Prisma.InputJsonValue
    },
    update: {
      questionText,
      questionStatus: text(payload.status) || "UNANSWERED",
      rawQuestion: safeJson(payload) as Prisma.InputJsonValue
    }
  });

  const knowledge = await findSku(shop.id, itemId, sku);
  const draft = generateLocalPresaleDraft({
    questionText,
    itemTitle: text(payload.item_title || payload.title),
    sku: knowledge?.sku || sku,
    knowledge
  });

  const updated = await prisma.presaleQuestion.update({
    where: { id: question.id },
    data: {
      aiDraft: draft.answer_es_mx,
      aiConfidence: draft.confidence,
      riskLevel: draft.risk_level,
      reviewStatus: draft.needs_human_review ? "needs_human" : "draft_ready"
    }
  });

  await createSuggestion({
    shopId: shop.id,
    targetType: "presale_question",
    targetId: updated.id,
    promptVersion: "presale-v1-local",
    inputSnapshot: { event, knowledge },
    outputJson: draft,
    outputText: draft.answer_es_mx,
    riskFlags: draft.policy_flags
  });
}

async function processAftersaleMessage(eventId: string) {
  const event = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
  if (!event) throw new Error(`event not found: ${eventId}`);

  const payload = (event.rawPayload || {}) as Record<string, unknown>;
  const shop = await getShopForEvent(event.userId);
  const packId = firstNumber(payload.pack_id || payload.packId || event.resource, BigInt(Date.now()));
  const orderId = firstNumber(payload.order_id || payload.orderId, BigInt(0)) || null;
  const sku = text(payload.sku || payload.SKU);
  const latestMessage = text(payload.text || payload.message || payload.latestMessage || "Buenas tardes, necesito apoyo con mi compra.");

  const thread = await prisma.aftersaleThread.upsert({
    where: { shopId_packId: { shopId: shop.id, packId } },
    create: {
      shopId: shop.id,
      packId,
      orderId,
      status: "open",
      lastMessageAt: new Date(),
      rawContext: safeJson({ ...payload, sku, latestMessage }) as Prisma.InputJsonValue
    },
    update: {
      status: "open",
      lastMessageAt: new Date(),
      rawContext: safeJson({ ...payload, sku, latestMessage }) as Prisma.InputJsonValue
    }
  });

  await prisma.message.create({
    data: {
      shopId: shop.id,
      threadId: thread.id,
      meliMessageId: text(payload.message_id || payload.id) || `event-${event.id}`,
      packId,
      direction: "inbound",
      text: latestMessage,
      rawMessage: safeJson(payload) as Prisma.InputJsonValue,
      messageDate: new Date()
    }
  }).catch(() => undefined);

  const recentMessages = await prisma.message.findMany({
    where: { threadId: thread.id, shopId: shop.id },
    orderBy: { messageDate: "desc" },
    take: 20
  });
  const conversationHistory = recentMessages.slice().reverse().map((message) => text(message.text)).filter(Boolean);
  const analysis = generateLocalAftersaleAnalysis({
    latestMessage,
    conversationHistory,
    orderStatus: text(payload.orderStatus || payload.order_status),
    shipmentStatus: text(payload.shipmentStatus || payload.shipment_status),
    hasClaim: Boolean(payload.claim_id || payload.claimId),
    hasReturn: Boolean(payload.return_id || payload.returnId),
    sku
  });
  await ensureDefaultAftersaleTemplates(shop.id);
  const matchedTemplate = await findBestReplyTemplate(shop.id, analysis.category, latestMessage);
  const suggestedReply = matchedTemplate
    ? fillReplyTemplate(matchedTemplate.content, {
      orderId: text(payload.order_id || payload.orderId),
      packId: packId.toString(),
      sku,
      itemTitle: text(payload.title || payload.itemTitle),
      trackingStatus: text(payload.shipmentStatus || payload.shipment_status)
    })
    : analysis.suggested_reply_es_mx;
  const handoff = decideAftersaleHandoff({ category: analysis.category, shouldEscalate: analysis.should_escalate_to_human });

  const updated = await prisma.aftersaleThread.update({
    where: { id: thread.id },
    data: {
      status: handoff.required ? "human_pending" : "open",
      category: analysis.category,
      riskLevel: analysis.risk_level,
      summary: analysis.summary_zh,
      suggestedAction: analysis.suggested_action_zh,
      suggestedReply
    }
  });

  if (handoff.required) {
    await notifyFeishuForHumanRequest(shop.id, buildAftersaleHandoffNotice({
      shopName: shop.nickname,
      handoff,
      packId: packId.toString(),
      orderId: text(payload.order_id || payload.orderId) || undefined,
      buyerMessage: latestMessage,
      conversationText: conversationHistory.join("\n"),
      suggestedAction: analysis.suggested_action_zh,
      suggestedReply
    }));
  }

  await createSuggestion({
    shopId: shop.id,
    targetType: "aftersale_thread",
    targetId: updated.id,
    promptVersion: "aftersale-v1-local",
    inputSnapshot: { event, conversationHistory, knowledgeScope: "aftersale_templates_only" },
    outputJson: { ...analysis, handoff, matchedTemplate: matchedTemplate ? { id: matchedTemplate.id, name: matchedTemplate.name } : null },
    outputText: suggestedReply,
    riskFlags: analysis.forbidden_commitments_detected
  });
}

async function processClaim(eventId: string) {
  const event = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
  if (!event) throw new Error(`event not found: ${eventId}`);

  const payload = (event.rawPayload || {}) as Record<string, unknown>;
  const shop = await getShopForEvent(event.userId);
  const packId = firstNumber(payload.pack_id || payload.packId || event.resource, BigInt(Date.now()));
  const claimId = firstNumber(payload.claim_id || payload.claimId || event.resource, BigInt(0));
  const summary = "Claim abierto, se enviará una respuesta automática segura y se mantendrá seguimiento operativo.";
  const suggestedAction = "Responder con contención, revisar motivo/evidencia/vencimiento y continuar dentro del flujo oficial de Mercado Libre.";
  const suggestedReply = "Hola, estamos revisando tu caso dentro de Mercado Libre. Te responderemos por este medio con la información correspondiente.";

  await prisma.aftersaleThread.upsert({
    where: { shopId_packId: { shopId: shop.id, packId } },
    create: {
      shopId: shop.id,
      packId,
      status: "open",
      category: "claim_opened",
      riskLevel: "high",
      claimId,
      summary,
      suggestedAction,
      suggestedReply,
      rawContext: safeJson(payload) as Prisma.InputJsonValue
    },
    update: {
      category: "claim_opened",
      riskLevel: "high",
      claimId,
      summary,
      suggestedAction,
      rawContext: safeJson(payload) as Prisma.InputJsonValue
    }
  });
}

new Worker("meli-webhook-events", async (job) => {
  await routeWebhookEvent(String(job.data.dedupeKey));
}, { connection });

new Worker("meli-presale-question", async (job) => {
  await processPresaleQuestion(String(job.data.eventId));
}, { connection });

new Worker("meli-aftersale-message", async (job) => {
  await processAftersaleMessage(String(job.data.eventId));
}, { connection });

new Worker("meli-claim-analysis", async (job) => {
  await processClaim(String(job.data.eventId));
}, { connection });

console.log("Meli AI Support worker started");
