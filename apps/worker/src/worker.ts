import { Queue, Worker } from "bullmq";
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

function firstNumber(value: unknown, fallback: bigint): bigint {
  const match = String(value || "").match(/\d{6,}/);
  return match ? BigInt(match[0]) : fallback;
}

function text(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
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
    await presaleQueue.add("process-presale-question", { eventId: event.id }, { jobId: event.dedupeKey || event.id });
  } else if (event.topic === "messages") {
    await aftersaleQueue.add("process-aftersale-message", { eventId: event.id }, { jobId: event.dedupeKey || event.id });
  } else if (event.topic === "claims") {
    await claimQueue.add("process-claim", { eventId: event.id }, { jobId: event.dedupeKey || event.id });
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

  const knowledge = await findSku(shop.id, undefined, sku);
  const analysis = generateLocalAftersaleAnalysis({
    latestMessage,
    orderStatus: text(payload.orderStatus || payload.order_status),
    shipmentStatus: text(payload.shipmentStatus || payload.shipment_status),
    hasClaim: Boolean(payload.claim_id || payload.claimId),
    hasReturn: Boolean(payload.return_id || payload.returnId),
    sku,
    knowledge
  });

  const updated = await prisma.aftersaleThread.update({
    where: { id: thread.id },
    data: {
      category: analysis.category,
      riskLevel: analysis.risk_level,
      summary: analysis.summary_zh,
      suggestedAction: analysis.suggested_action_zh,
      suggestedReply: analysis.suggested_reply_es_mx
    }
  });

  await createSuggestion({
    shopId: shop.id,
    targetType: "aftersale_thread",
    targetId: updated.id,
    promptVersion: "aftersale-v1-local",
    inputSnapshot: { event, knowledge },
    outputJson: analysis,
    outputText: analysis.suggested_reply_es_mx,
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
  const summary = "Claim abierto, requiere revisión humana prioritaria.";
  const suggestedAction = "Entrar al claim de Mercado Libre y revisar motivo, evidencia, vencimiento y acciones disponibles.";
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
