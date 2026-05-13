import crypto from "node:crypto";
import cors from "cors";
import express from "express";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { Prisma, prisma } from "@meli-ai-support/db";
import {
  AftersaleAnalysisSchema,
  KbChunkPlanSchema,
  PresaleReplySchema,
  aftersaleSystemPrompt,
  assertSafePresaleAnswer,
  generateLocalAftersaleAnalysis,
  generateLocalPresaleDraft,
  presaleSystemPrompt,
  type AftersaleAnalysis,
  type KnowledgeHit,
  type PresaleReply,
  type SkuKnowledgeContext
} from "@meli-ai-support/ai-core";
import { WebhookPayloadSchema, makeWebhookDedupeKey, toBigIntOrNull } from "@meli-ai-support/shared";

const PORT = Number(process.env.PORT || 3001);
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const MELI_AUTH_URL = process.env.MELI_AUTH_URL || "https://global-selling.mercadolibre.com/authorization";
const MELI_TOKEN_URL = "https://api.mercadolibre.com/oauth/token";
const DEMO_SELLER_ID = BigInt("900000000001");

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const webhookQueue = new Queue("meli-webhook-events", { connection: redis });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "8mb" }));

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function safeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, current) => {
    if (typeof current === "bigint") return current.toString();
    return current;
  })) as T;
}

function sendJson(res: express.Response, value: unknown, status = 200) {
  return res.status(status).json(safeJson(value));
}

function optionalEnv(name: string): string {
  return String(process.env[name] || "").trim();
}

function requireEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) throw new HttpError(400, `Missing environment variable ${name}`);
  return value;
}

function normalizeText(value: unknown): string {
  return String(value || "").replace(/^\uFEFF/, "").replace(/\s+/g, " ").trim();
}

function getClientIp(req: express.Request): string {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || req.socket.remoteAddress || "";
}

function getEncryptionKey(): Buffer {
  const raw = requireEnv("TOKEN_ENCRYPTION_KEY");
  const asBase64 = Buffer.from(raw, "base64");
  if (asBase64.length === 32) return asBase64;
  const asHex = Buffer.from(raw, "hex");
  if (asHex.length === 32) return asHex;
  const utf8 = Buffer.from(raw, "utf8");
  if (utf8.length === 32) return utf8;
  throw new HttpError(500, "TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
}

function encryptSecret(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptSecret(payload: string): string {
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

async function withRedisLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
  if (acquired !== "OK") throw new HttpError(409, `Lock not acquired: ${key}`);

  try {
    return await fn();
  } finally {
    const current = await redis.get(key);
    if (current === token) await redis.del(key);
  }
}

async function getActor(req: express.Request) {
  const email = normalizeText(req.headers["x-user-email"] || req.headers["x-actor-email"] || "local-admin@local");
  const name = normalizeText(req.headers["x-user-name"] || "Local Admin");
  const role = email === "local-admin@local" ? "admin" : "operator";

  return prisma.appUser.upsert({
    where: { email },
    create: { email, name, role },
    update: { name: name || undefined }
  });
}

async function ensureShopMember(shopId: string, userId: string, role = "operator") {
  return prisma.shopMember.upsert({
    where: { shopId_userId: { shopId, userId } },
    create: { shopId, userId, role },
    update: { active: true, role }
  });
}

async function getOrCreateDemoShop(actorId?: string) {
  const shop = await prisma.shop.upsert({
    where: { sellerId: DEMO_SELLER_ID },
    create: {
      sellerId: DEMO_SELLER_ID,
      siteId: "MLM",
      nickname: "DEMO-MELI-SHOP",
      status: "demo",
      authorizedAt: new Date()
    },
    update: {}
  });

  if (actorId) await ensureShopMember(shop.id, actorId, "admin");
  return shop;
}

async function resolveShopId(req: express.Request, input?: unknown): Promise<string> {
  const actor = await getActor(req);
  const requested = normalizeText(input || req.query.shopId || req.headers["x-shop-id"]);

  if (requested) {
    if (actor.role === "admin") return requested;

    const membership = await prisma.shopMember.findFirst({
      where: { shopId: requested, userId: actor.id, active: true }
    });
    if (!membership) throw new HttpError(403, "Current user has no access to this shop");
    return requested;
  }

  if (actor.role !== "admin") {
    const membership = await prisma.shopMember.findFirst({
      where: { userId: actor.id, active: true },
      orderBy: { createdAt: "asc" }
    });
    if (!membership) throw new HttpError(403, "Current user is not bound to any shop");
    return membership.shopId;
  }

  const shop = await prisma.shop.findFirst({ orderBy: { createdAt: "asc" } });
  return shop?.id || (await getOrCreateDemoShop(actor.id)).id;
}

async function createOperationLog(req: express.Request, input: {
  shopId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  detail?: unknown;
}) {
  const actor = await getActor(req);
  await prisma.operationLog.create({
    data: {
      shopId: input.shopId || null,
      actorId: actor.id,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId || null,
      detail: input.detail === undefined ? undefined : safeJson(input.detail) as Prisma.InputJsonValue
    }
  });
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === "\"" && quoted && next === "\"") {
      current += "\"";
      i += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if ((char === "," || char === "\t" || char === ";") && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current.trim());
  return cells;
}

function parseSkuCsv(csv: string): Array<Record<string, string>> {
  const lines = String(csv || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""]));
  });
}

function pickInput(input: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== null && String(input[key]).trim() !== "") return input[key];
  }
  return "";
}

function mapSkuInput(input: Record<string, unknown>) {
  return {
    sku: normalizeText(pickInput(input, ["sku", "SKU"])),
    itemId: normalizeText(pickInput(input, ["itemId", "item_id", "item", "\u5546\u54c1ID", "\u5546\u54c1\u7f16\u53f7", "Item"])),
    title: normalizeText(pickInput(input, ["title", "titulo", "name", "nombre", "\u6807\u9898", "\u5546\u54c1\u6807\u9898", "\u5546\u54c1\u540d\u79f0"])),
    brand: normalizeText(pickInput(input, ["brand", "marca", "\u54c1\u724c"])),
    category: normalizeText(pickInput(input, ["category", "categoria", "\u7c7b\u76ee", "\u5206\u7c7b"])),
    locale: normalizeText(input.locale) || "es-MX",
    sellingPoints: normalizeText(pickInput(input, ["sellingPoints", "selling_points", "description", "\u5356\u70b9", "\u4ea7\u54c1\u8bf4\u660e", "\u5546\u54c1\u8bf4\u660e"])),
    faq: normalizeText(pickInput(input, ["faq", "FAQ", "\u5e38\u89c1\u95ee\u9898"])),
    warrantyPolicy: normalizeText(pickInput(input, ["warrantyPolicy", "warranty_policy", "garantia", "garant\u00eda", "\u4fdd\u4fee", "\u4fdd\u4fee\u653f\u7b56"])),
    invoicePolicy: normalizeText(pickInput(input, ["invoicePolicy", "invoice_policy", "factura", "\u53d1\u7968", "\u53d1\u7968\u89c4\u5219"])),
    shippingNotes: normalizeText(pickInput(input, ["shippingNotes", "shipping_notes", "envio", "env\u00edo", "\u7269\u6d41", "\u7269\u6d41\u8bf4\u660e"])),
    returnPolicy: normalizeText(pickInput(input, ["returnPolicy", "return_policy", "devolucion", "devoluci\u00f3n", "\u9000\u6362\u8d27", "\u9000\u6362\u8d27\u89c4\u5219"])),
    forbiddenNotes: normalizeText(pickInput(input, ["forbiddenNotes", "forbidden_notes", "prohibido", "\u7981\u7528\u8bdd\u672f"]))
  };
}

function skuToKnowledge(input: {
  sku?: string | null;
  title?: string | null;
  sellingPoints?: string | null;
  faq?: string | null;
  warrantyPolicy?: string | null;
  invoicePolicy?: string | null;
  shippingNotes?: string | null;
  returnPolicy?: string | null;
  forbiddenNotes?: string | null;
} | null): SkuKnowledgeContext | null {
  if (!input) return null;
  return {
    sku: input.sku,
    title: input.title,
    sellingPoints: input.sellingPoints,
    faq: input.faq,
    warrantyPolicy: input.warrantyPolicy,
    invoicePolicy: input.invoicePolicy,
    shippingNotes: input.shippingNotes,
    returnPolicy: input.returnPolicy,
    forbiddenNotes: input.forbiddenNotes
  };
}

async function upsertSkuKnowledge(shopId: string, input: Record<string, unknown>) {
  const mapped = mapSkuInput(input);
  if (!mapped.sku || !mapped.title) throw new HttpError(400, "sku and title are required");

  return prisma.skuKnowledge.upsert({
    where: { shopId_sku: { shopId, sku: mapped.sku } },
    create: {
      shopId,
      ...mapped,
      attributes: input.attributes && typeof input.attributes === "object"
        ? safeJson(input.attributes) as Prisma.InputJsonValue
        : undefined
    },
    update: {
      ...mapped,
      attributes: input.attributes && typeof input.attributes === "object"
        ? safeJson(input.attributes) as Prisma.InputJsonValue
        : undefined,
      active: input.active === undefined ? true : Boolean(input.active)
    }
  });
}

function kimiConfigured() {
  return Boolean(optionalEnv("KIMI_API_KEY") || optionalEnv("MOONSHOT_API_KEY"));
}

async function callKimiJson<T>(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, fallback: T): Promise<T> {
  const apiKey = optionalEnv("KIMI_API_KEY") || optionalEnv("MOONSHOT_API_KEY");
  if (!apiKey) return fallback;

  const baseUrl = optionalEnv("KIMI_BASE_URL") || "https://api.moonshot.cn/v1";
  const model = optionalEnv("KIMI_MODEL") || "moonshot-v1-auto";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(optionalEnv("KIMI_TIMEOUT_MS") || 60_000));
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        ...messages,
        { role: "user", content: "Return only valid JSON. Do not wrap it in markdown." }
      ],
      temperature: model.startsWith("kimi-k") ? 1 : 0.2
    })
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    throw new HttpError(502, `Kimi API failed: HTTP ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content || "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new HttpError(502, "Kimi API did not return JSON");
  return JSON.parse(jsonMatch[0]) as T;
}

function fallbackChunkPlan(title: string, docType: string, content: string, sku?: string) {
  const paragraphs = content.split(/\n{2,}|(?<=\u3002)|(?<=\.)/).map((part) => part.trim()).filter(Boolean);
  const chunks: Array<{ title: string; doc_type: string; content: string; sku_tags: string[]; intent_tags: string[]; risk_tags: string[]; priority: number }> = [];
  let buffer = "";

  for (const paragraph of paragraphs) {
    if ((buffer + "\n" + paragraph).length > 900 && buffer) {
      chunks.push({ title, doc_type: docType, content: buffer.trim(), sku_tags: sku ? [sku] : [], intent_tags: [], risk_tags: [], priority: 0.5 });
      buffer = "";
    }
    buffer += `${buffer ? "\n" : ""}${paragraph}`;
  }
  if (buffer.trim()) chunks.push({ title, doc_type: docType, content: buffer.trim(), sku_tags: sku ? [sku] : [], intent_tags: [], risk_tags: [], priority: 0.5 });
  return { chunks: chunks.length ? chunks : [{ title, doc_type: docType, content, sku_tags: sku ? [sku] : [], intent_tags: [], risk_tags: [], priority: 0.5 }] };
}

async function agenticChunkDocument(input: { title: string; docType: string; content: string; sku?: string }) {
  const fallback = fallbackChunkPlan(input.title, input.docType, input.content, input.sku);
  if (!kimiConfigured() || input.content.length < 80) return fallback;

  try {
    const result = await callKimiJson([
      {
        role: "system",
        content: [
          "You are an agentic RAG ingestion planner for an ecommerce support ERP.",
          "Split uploaded knowledge into retrieval-ready chunks.",
          "Each chunk should be self-contained, 150-900 characters, with SKU tags, intent tags and risk tags.",
          "Do not invent policy. Preserve exact business rules."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify(input)
      }
    ], fallback);

    return KbChunkPlanSchema.parse(result);
  } catch (error) {
    console.warn("[rag] kimi chunking failed, using fallback chunker", error instanceof Error ? error.message : String(error));
    return fallback;
  }
}

function tokenize(text: string): string[] {
  return normalizeText(text).toLowerCase().split(/[^a-z0-9\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00fc]+/i).filter((part) => part.length >= 2);
}

function lexicalScore(query: string, text: string): number {
  const terms = [...new Set(tokenize(query))];
  const haystack = normalizeText(text).toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

async function retrieveKnowledge(shopId: string, query: string, options: { sku?: string; limit?: number } = {}): Promise<KnowledgeHit[]> {
  const sku = normalizeText(options.sku);
  const limit = options.limit || 6;
  const hits: KnowledgeHit[] = [];

  if (sku) {
    const skuKnowledge = await prisma.skuKnowledge.findFirst({ where: { shopId, sku, active: true } });
    if (skuKnowledge) {
      const content = [
        skuKnowledge.title,
        skuKnowledge.sellingPoints,
        skuKnowledge.faq,
        skuKnowledge.warrantyPolicy,
        skuKnowledge.invoicePolicy,
        skuKnowledge.shippingNotes,
        skuKnowledge.returnPolicy,
        skuKnowledge.forbiddenNotes
      ].filter(Boolean).join("\n");
      hits.push({ id: skuKnowledge.id, title: `SKU ${skuKnowledge.sku}`, docType: "product", content, source: "sku", score: 10 });
    }
  }

  const chunks = await prisma.kbChunk.findMany({
    where: { OR: [{ shopId }, { shopId: null }] },
    include: { document: true },
    orderBy: { createdAt: "desc" },
    take: 500
  });

  for (const chunk of chunks) {
    const meta = (chunk.metadata || {}) as Record<string, unknown>;
    const skuTags = Array.isArray(meta.sku_tags) ? meta.sku_tags.map((tag) => String(tag)) : [];
    if (sku && skuTags.length && !skuTags.includes(sku)) {
      continue;
    }
    const metaText = JSON.stringify(meta);
    const score = lexicalScore(query, `${chunk.content} ${metaText}`) + (sku && metaText.includes(sku) ? 5 : 0);
    if (score > 0) {
      hits.push({
        id: chunk.id,
        title: normalizeText(meta.title) || chunk.document.title,
        docType: normalizeText(meta.doc_type) || chunk.document.docType,
        content: chunk.content,
        source: "chunk",
        metadata: meta,
        score
      });
    }
  }

  return hits.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);
}

const DEFAULT_REPLY_TEMPLATES = [
  {
    name: "物流未收到",
    intentCode: "not_received",
    category: "shipping_not_received",
    keywords: ["no recibí", "no llego", "no ha llegado", "paquete"],
    content: "Hola, lamentamos lo ocurrido. Te recomendamos revisar el estado del envío desde Mercado Libre. Si el paquete sigue sin actualizarse, por favor continúa el seguimiento desde el flujo oficial de la plataforma.",
    variables: ["orderId", "trackingStatus"],
    requiresReview: true
  },
  {
    name: "物流延迟",
    intentCode: "shipping_delay",
    category: "shipping_delay",
    keywords: ["demora", "tarde", "retraso", "entrega"],
    content: "Hola, sentimos la demora. El envío es gestionado por Mercado Libre y puedes revisar la fecha estimada desde el detalle de tu compra. Seguiremos atentos por este medio.",
    variables: ["estimatedDeliveryDate"],
    requiresReview: true
  },
  {
    name: "发票问题",
    intentCode: "invoice_request",
    category: "invoice_request",
    keywords: ["factura", "facturar", "cfdi", "rfc"],
    content: "Hola, gracias por la información. Vamos a revisar los datos de facturación y, si falta algún dato adicional, te contactaremos por este medio.",
    variables: ["orderId"],
    requiresReview: true
  },
  {
    name: "商品损坏",
    intentCode: "damaged_item",
    category: "damaged_product",
    keywords: ["dañado", "roto", "quebrado", "defecto"],
    content: "Hola, lamentamos el inconveniente. Para poder revisar el caso, por favor comparte fotos o evidencia del estado del producto dentro del chat de Mercado Libre.",
    variables: ["itemTitle", "sku"],
    requiresReview: true
  },
  {
    name: "退货流程",
    intentCode: "return_request",
    category: "return_request",
    keywords: ["devolver", "devolución", "regresar", "cambio"],
    content: "Hola, para una devolución o cambio es necesario seguir el flujo oficial de Mercado Libre desde el detalle de la compra. Revisaremos la información disponible y te apoyaremos por este medio.",
    variables: ["orderId"],
    requiresReview: true
  },
  {
    name: "退款问题",
    intentCode: "refund_request",
    category: "refund_request",
    keywords: ["reembolso", "dinero", "refund", "pago"],
    content: "Hola, entendemos tu solicitud. Cualquier reembolso debe revisarse y procesarse mediante el flujo oficial de Mercado Libre según el estado del pedido.",
    variables: ["orderId"],
    requiresReview: true
  }
];

async function ensureDefaultReplyTemplates(shopId: string) {
  const created = [];
  for (const template of DEFAULT_REPLY_TEMPLATES) {
    const record = await prisma.replyTemplate.upsert({
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
        requiresReview: template.requiresReview
      },
      update: {}
    });
    created.push(record);
  }
  return created;
}

function fillReplyTemplate(content: string, values: Record<string, unknown>) {
  return content.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => normalizeText(values[key]) || "-");
}

async function findBestReplyTemplate(shopId: string, intentCode: string | null | undefined, text: string) {
  const templates = await prisma.replyTemplate.findMany({
    where: { shopId, active: true },
    orderBy: [{ intentCode: "asc" }, { updatedAt: "desc" }]
  });
  if (!templates.length) return null;

  const normalizedIntent = normalizeText(intentCode);
  const normalizedText = normalizeText(text).toLowerCase();
  const exact = templates.find((template) => template.intentCode === normalizedIntent);
  if (exact) return exact;

  return templates
    .map((template) => ({
      template,
      score: template.keywords.reduce((total, keyword) => total + (normalizedText.includes(keyword.toLowerCase()) ? 1 : 0), 0)
    }))
    .sort((a, b) => b.score - a.score)[0]?.template || null;
}

async function findSkuKnowledgeForQuestion(question: { shopId: string; itemId: string; rawItem?: Prisma.JsonValue | null }) {
  const rawItem = (question.rawItem || {}) as Record<string, unknown>;
  const sku = normalizeText(rawItem.sku || rawItem.SKU || rawItem.seller_sku || rawItem.sellerSku);
  return prisma.skuKnowledge.findFirst({
    where: { shopId: question.shopId, active: true, OR: [{ itemId: question.itemId }, ...(sku ? [{ sku }] : [])] },
    orderBy: { updatedAt: "desc" }
  });
}

async function findSkuKnowledgeForThread(thread: { shopId: string; rawContext?: Prisma.JsonValue | null }) {
  const rawContext = (thread.rawContext || {}) as Record<string, unknown>;
  const sku = normalizeText(rawContext.sku || rawContext.SKU);
  if (!sku) return null;
  return prisma.skuKnowledge.findFirst({ where: { shopId: thread.shopId, sku, active: true }, orderBy: { updatedAt: "desc" } });
}

async function generatePresaleWithAi(input: {
  questionText: string;
  itemTitle?: string | null;
  sku?: string | null;
  knowledge?: SkuKnowledgeContext | null;
  ragHits: KnowledgeHit[];
}): Promise<PresaleReply> {
  const fallback = generateLocalPresaleDraft(input);
  if ((optionalEnv("AI_PROVIDER") || "local") !== "kimi" || !kimiConfigured()) return fallback;

  try {
    const raw = await callKimiJson([
      { role: "system", content: presaleSystemPrompt },
      { role: "user", content: JSON.stringify(input) }
    ], fallback);
    const parsed = PresaleReplySchema.parse(raw);
    const safety = assertSafePresaleAnswer(parsed.answer_es_mx);
    return {
      ...parsed,
      risk_level: safety.safe ? parsed.risk_level : "high",
      needs_human_review: parsed.needs_human_review || !safety.safe,
      policy_flags: [...new Set([...parsed.policy_flags, ...safety.flags])]
    };
  } catch (error) {
    console.warn("[ai] kimi presale generation failed, using local fallback", error instanceof Error ? error.message : String(error));
    return fallback;
  }
}

async function generateAftersaleWithAi(input: {
  latestMessage: string;
  orderStatus?: string;
  shipmentStatus?: string;
  hasClaim?: boolean;
  hasReturn?: boolean;
  sku?: string | null;
  knowledge?: SkuKnowledgeContext | null;
  ragHits: KnowledgeHit[];
}): Promise<AftersaleAnalysis> {
  const fallback = generateLocalAftersaleAnalysis(input);
  if ((optionalEnv("AI_PROVIDER") || "local") !== "kimi" || !kimiConfigured()) return fallback;

  try {
    const raw = await callKimiJson([
      { role: "system", content: aftersaleSystemPrompt },
      { role: "user", content: JSON.stringify(input) }
    ], fallback);
    return AftersaleAnalysisSchema.parse(raw);
  } catch (error) {
    console.warn("[ai] kimi aftersale generation failed, using local fallback", error instanceof Error ? error.message : String(error));
    return fallback;
  }
}

function buildMeliAuthUrl(state: string) {
  const clientId = requireEnv("MELI_CLIENT_ID");
  const redirectUri = requireEnv("MELI_REDIRECT_URI");
  const url = new URL(MELI_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

function meliAuthConfigured() {
  return Boolean(optionalEnv("MELI_CLIENT_ID") && optionalEnv("MELI_CLIENT_SECRET") && optionalEnv("MELI_REDIRECT_URI"));
}

function sendMeliAuthSetupPage(res: express.Response) {
  const redirectUri = optionalEnv("MELI_REDIRECT_URI") || `http://127.0.0.1:${PORT}/auth/meli/callback`;
  res.status(200).type("html").send(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mercado Libre 店铺授权</title>
  <style>
    body { margin: 0; background: #eef2f6; color: #172033; font-family: Arial, "Microsoft YaHei", sans-serif; }
    main { max-width: 760px; margin: 56px auto; padding: 0 20px; }
    section { background: #fff; border: 1px solid #dbe4ef; border-radius: 10px; padding: 24px; }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { line-height: 1.7; color: #53657f; }
    code, pre { background: #f5f7fb; border: 1px solid #dbe4ef; border-radius: 6px; }
    code { padding: 2px 6px; }
    pre { padding: 14px; overflow: auto; color: #172033; }
    .warn { border-left: 4px solid #f59e0b; padding-left: 12px; color: #8a4b05; }
    .steps { display: grid; gap: 10px; margin-top: 18px; }
    .step { padding: 12px; background: #f8fafc; border-radius: 8px; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>还不能跳转 Mercado Libre 授权页</h1>
      <p class="warn">本机服务还没有配置 Mercado Libre 官方应用凭证。配置完成后，客服点击“授权 Mercado Libre”就会直接跳转，不需要看到这页。</p>
      <div class="steps">
        <div class="step">1. 在 Mercado Libre Developers 创建应用，复制 Client ID 和 Client Secret。</div>
        <div class="step">2. 在应用后台把 Redirect URI 设置为：</div>
      </div>
      <pre>${redirectUri}</pre>
      <p>然后在本项目 <code>.env</code> 中填写：</p>
      <pre>MELI_CLIENT_ID=你的ClientID
MELI_CLIENT_SECRET=你的ClientSecret
MELI_REDIRECT_URI=${redirectUri}</pre>
      <p>保存后重启服务，再打开 <code>/auth/meli/start</code> 就会跳转到 Mercado Libre 登录授权页面。</p>
    </section>
  </main>
</body>
</html>`);
}

async function exchangeCodeForToken(code: string) {
  const response = await fetch(MELI_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: requireEnv("MELI_CLIENT_ID"),
      client_secret: requireEnv("MELI_CLIENT_SECRET"),
      code,
      redirect_uri: requireEnv("MELI_REDIRECT_URI")
    })
  });
  if (!response.ok) throw new HttpError(502, `Token exchange failed: HTTP ${response.status} ${await response.text()}`);
  return response.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number; scope?: string; user_id?: number }>;
}

async function refreshMeliToken(refreshToken: string) {
  const response = await fetch(MELI_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: requireEnv("MELI_CLIENT_ID"),
      client_secret: requireEnv("MELI_CLIENT_SECRET"),
      refresh_token: refreshToken
    })
  });
  if (!response.ok) throw new HttpError(502, `Token refresh failed: HTTP ${response.status} ${await response.text()}`);
  return response.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number; scope?: string }>;
}

async function fetchMeliMe(accessToken: string) {
  const response = await fetch("https://api.mercadolibre.com/users/me", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }
  });
  if (!response.ok) throw new HttpError(502, `users/me failed: HTTP ${response.status} ${await response.text()}`);
  return response.json() as Promise<{ id: number; nickname?: string; site_id?: string }>;
}

app.get("/health", async (req, res) => {
  const shopId = await resolveShopId(req).catch(() => null);
  const [shopCount, pendingWebhookCount, skuCount, chunkCount, presalePending, aftersaleOpen] = await Promise.all([
    prisma.shop.count().catch(() => -1),
    prisma.webhookEvent.count({ where: { status: "pending" } }).catch(() => -1),
    shopId ? prisma.skuKnowledge.count({ where: { shopId } }).catch(() => -1) : Promise.resolve(0),
    shopId ? prisma.kbChunk.count({ where: { shopId } }).catch(() => -1) : Promise.resolve(0),
    shopId ? prisma.presaleQuestion.count({ where: { shopId, reviewStatus: "pending" } }).catch(() => -1) : Promise.resolve(0),
    shopId ? prisma.aftersaleThread.count({ where: { shopId, status: "open" } }).catch(() => -1) : Promise.resolve(0)
  ]);

  sendJson(res, {
    success: true,
    service: "meli-ai-support-api",
    time: new Date().toISOString(),
    shopCount,
    pendingWebhookCount,
    skuCount,
    chunkCount,
    presalePending,
    aftersaleOpen,
    ai: {
      provider: optionalEnv("AI_PROVIDER") || "local",
      kimiConfigured: kimiConfigured(),
      model: optionalEnv("KIMI_MODEL") || "moonshot-v1-auto",
      baseUrl: optionalEnv("KIMI_BASE_URL") || "https://api.moonshot.cn/v1"
    }
  });
});

app.get("/auth/meli/url", (req, res, next) => {
  try {
    const state = crypto.randomBytes(18).toString("base64url");
    return sendJson(res, {
      success: true,
      url: buildMeliAuthUrl(String(req.query.state || state)),
      method: "Open this URL in the browser. Mercado Libre will redirect to MELI_REDIRECT_URI with code and state."
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/auth/meli/start", (req, res, next) => {
  try {
    if (!meliAuthConfigured()) return sendMeliAuthSetupPage(res);
    const state = crypto.randomBytes(18).toString("base64url");
    return res.redirect(buildMeliAuthUrl(String(req.query.state || state)));
  } catch (error) {
    return next(error);
  }
});

app.get("/auth/meli/callback", async (req, res, next) => {
  try {
    const actor = await getActor(req);
    const code = normalizeText(req.query.code);
    if (!code) return sendJson(res, { success: false, message: "missing code" }, 400);

    const token = await exchangeCodeForToken(code);
    const me = await fetchMeliMe(token.access_token);
    const expiresAt = new Date(Date.now() + token.expires_in * 1000);
    const shop = await prisma.shop.upsert({
      where: { sellerId: BigInt(me.id) },
      create: {
        sellerId: BigInt(me.id),
        siteId: me.site_id || process.env.MELI_SITE_ID || "MLM",
        nickname: me.nickname,
        status: "active",
        authorizedAt: new Date()
      },
      update: {
        siteId: me.site_id || process.env.MELI_SITE_ID || "MLM",
        nickname: me.nickname,
        status: "active",
        authorizedAt: new Date()
      }
    });

    await prisma.meliToken.create({
      data: {
        shopId: shop.id,
        accessTokenEnc: encryptSecret(token.access_token),
        refreshTokenEnc: encryptSecret(token.refresh_token),
        scope: token.scope,
        expiresAt
      }
    });
    await ensureShopMember(shop.id, actor.id, "admin");
    await createOperationLog(req, { shopId: shop.id, action: "meli.oauth.callback", targetType: "shop", targetId: shop.id, detail: { sellerId: shop.sellerId.toString(), nickname: shop.nickname } });

    return sendJson(res, { success: true, shop: { id: shop.id, sellerId: shop.sellerId, nickname: shop.nickname } });
  } catch (error) {
    return next(error);
  }
});

app.post("/auth/meli/refresh", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const result = await withRedisLock(`meli:refresh-token:${shopId}`, 30_000, async () => {
      const currentToken = await prisma.meliToken.findFirst({ where: { shopId }, orderBy: { createdAt: "desc" } });
      if (!currentToken) throw new HttpError(404, "No Mercado Libre token found for this shop");
      const refreshed = await refreshMeliToken(decryptSecret(currentToken.refreshTokenEnc));
      const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
      const token = await prisma.meliToken.create({
        data: {
          shopId,
          accessTokenEnc: encryptSecret(refreshed.access_token),
          refreshTokenEnc: encryptSecret(refreshed.refresh_token),
          scope: refreshed.scope,
          expiresAt,
          lastRefreshAt: new Date()
        }
      });
      await createOperationLog(req, { shopId, action: "meli.token.refresh", targetType: "meli_token", targetId: token.id, detail: { expiresAt } });
      return { expiresAt };
    });
    return sendJson(res, { success: true, ...result });
  } catch (error) {
    return next(error);
  }
});

app.post("/webhooks/meli", async (req, res, next) => {
  try {
    const secret = optionalEnv("WEBHOOK_SHARED_SECRET");
    if (secret && req.headers["x-webhook-secret"] && req.headers["x-webhook-secret"] !== secret) {
      throw new HttpError(401, "Invalid webhook secret");
    }

    const payload = WebhookPayloadSchema.parse(req.body);
    const dedupeKey = makeWebhookDedupeKey(payload);
    const event = await prisma.webhookEvent.upsert({
      where: { dedupeKey },
      create: {
        topic: payload.topic,
        resource: payload.resource,
        userId: toBigIntOrNull(payload.user_id),
        applicationId: toBigIntOrNull(payload.application_id),
        attempts: payload.attempts ?? 0,
        rawPayload: payload as Prisma.InputJsonValue,
        dedupeKey
      },
      update: {}
    });

    await webhookQueue.add("process-meli-webhook", { dedupeKey }, {
      jobId: dedupeKey,
      attempts: 5,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: 1000,
      removeOnFail: false
    });

    return sendJson(res, { success: true, eventId: event.id });
  } catch (error) {
    return next(error);
  }
});

app.get("/shops", async (req, res, next) => {
  try {
    const actor = await getActor(req);
    const shops = actor.role === "admin"
      ? await prisma.shop.findMany({ orderBy: { createdAt: "desc" } })
      : (await prisma.shopMember.findMany({ where: { userId: actor.id, active: true }, include: { shop: true } })).map((member) => member.shop);
    return sendJson(res, { success: true, shops, actor });
  } catch (error) {
    return next(error);
  }
});

app.get("/dashboard", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [shop, presalePending, presaleReady, presaleNeedsHuman, aftersaleOpen, aftersaleHigh, knowledgeFailed, todayReplied, aiCount, acceptedCount, templateCount, tokenCount] = await Promise.all([
      prisma.shop.findUnique({ where: { id: shopId } }),
      prisma.presaleQuestion.count({ where: { shopId, reviewStatus: "pending" } }),
      prisma.presaleQuestion.count({ where: { shopId, reviewStatus: "draft_ready" } }),
      prisma.presaleQuestion.count({ where: { shopId, reviewStatus: "needs_human" } }),
      prisma.aftersaleThread.count({ where: { shopId, status: "open" } }),
      prisma.aftersaleThread.count({ where: { shopId, riskLevel: "high" } }),
      prisma.kbDocument.count({ where: { shopId, status: { in: ["failed", "partial_failed"] } } }),
      prisma.presaleQuestion.count({ where: { shopId, sentAt: { gte: today } } }),
      prisma.aiSuggestion.count({ where: { shopId } }),
      prisma.aiSuggestion.count({ where: { shopId, accepted: true } }),
      prisma.replyTemplate.count({ where: { shopId, active: true } }),
      prisma.meliToken.count({ where: { shopId } })
    ]);

    const pendingReviews = presaleReady + aftersaleOpen;
    const adoptionRate = aiCount ? Math.round((acceptedCount / aiCount) * 100) : 0;
    return sendJson(res, {
      success: true,
      shop,
      metrics: {
        pendingConsultations: presalePending + presaleNeedsHuman,
        pendingReviews,
        aftersaleFollowups: aftersaleOpen,
        knowledgeFailed,
        todayReplied,
        adoptionRate,
        templateCount,
        highRisk: aftersaleHigh
      },
      systemStatus: {
        platformConnected: tokenCount > 0 || shop?.status === "demo",
        messageSync: true,
        assistant: kimiConfigured(),
        knowledge: knowledgeFailed === 0
      }
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/demo/seed", async (req, res, next) => {
  try {
    const actor = await getActor(req);
    const shop = await getOrCreateDemoShop(actor.id);
    const sku = await upsertSkuKnowledge(shop.id, {
      sku: "E10146",
      itemId: "MLM-DEMO-E10146",
      title: "Terport teclado gamer mec\u00e1nico 90% RGB",
      brand: "Terport",
      category: "Teclados",
      sellingPoints: "Teclado gamer compacto con distribuci\u00f3n en espa\u00f1ol, conexi\u00f3n estable y retroiluminaci\u00f3n RGB.",
      faq: "Compatible con PC y laptops con USB. La publicaci\u00f3n permite comprar cuando hay stock disponible.",
      warrantyPolicy: "Cuenta con garant\u00eda por defectos de fabricaci\u00f3n conforme a la pol\u00edtica de la tienda.",
      invoicePolicy: "Despu\u00e9s de la compra podemos apoyar con factura si el comprador comparte sus datos fiscales por el chat de Mercado Libre.",
      shippingNotes: "El env\u00edo y la fecha estimada dependen de Mercado Libre.",
      returnPolicy: "Para devoluciones o productos da\u00f1ados, revisar evidencia y el flujo oficial de Mercado Libre."
    });

    const question = await prisma.presaleQuestion.upsert({
      where: { questionId: BigInt("990000000001") },
      create: {
        shopId: shop.id,
        questionId: BigInt("990000000001"),
        itemId: "MLM-DEMO-E10146",
        buyerId: BigInt("880000000001"),
        questionText: "Hola, \u00bffacturan y tiene garant\u00eda?",
        questionStatus: "UNANSWERED",
        rawQuestion: { id: "990000000001", text: "Hola, \u00bffacturan y tiene garant\u00eda?", status: "UNANSWERED" },
        rawItem: { id: "MLM-DEMO-E10146", sku: "E10146", title: sku.title }
      },
      update: { questionText: "Hola, \u00bffacturan y tiene garant\u00eda?", questionStatus: "UNANSWERED" }
    });

    const thread = await prisma.aftersaleThread.upsert({
      where: { shopId_packId: { shopId: shop.id, packId: BigInt("2000012785336293") } },
      create: {
        shopId: shop.id,
        packId: BigInt("2000012785336293"),
        orderId: BigInt("2000016245466356"),
        buyerId: BigInt("770000000001"),
        status: "open",
        category: "invoice_request",
        riskLevel: "medium",
        lastMessageAt: new Date(),
        rawContext: {
          sku: "E10146",
          orderStatus: "paid",
          shipmentStatus: "delivered",
          latestMessage: "Buenas tardes, \u00bfme podr\u00edan apoyar a facturar mi compra por favor? Uso de CFDI: gastos en general. M\u00e9todo de pago: tarjeta de d\u00e9bito."
        }
      },
      update: { status: "open", lastMessageAt: new Date() }
    });

    await prisma.message.upsert({
      where: { meliMessageId: "demo-message-2000012785336293-1" },
      create: {
        shopId: shop.id,
        threadId: thread.id,
        meliMessageId: "demo-message-2000012785336293-1",
        packId: BigInt("2000012785336293"),
        direction: "inbound",
        text: "Buenas tardes, \u00bfme podr\u00edan apoyar a facturar mi compra por favor? Uso de CFDI: gastos en general. M\u00e9todo de pago: tarjeta de d\u00e9bito.",
        messageDate: new Date()
      },
      update: {}
    });

    const templates = await ensureDefaultReplyTemplates(shop.id);
    await createOperationLog(req, { shopId: shop.id, action: "demo.seed", targetType: "shop", targetId: shop.id, detail: { questionId: question.id, threadId: thread.id, templates: templates.length } });
    return sendJson(res, { success: true, shop, sku, question, thread, templates });
  } catch (error) {
    return next(error);
  }
});

app.get("/settings/ai", (_req, res) => {
  sendJson(res, {
    success: true,
    provider: optionalEnv("AI_PROVIDER") || "local",
    kimiConfigured: kimiConfigured(),
    model: optionalEnv("KIMI_MODEL") || "moonshot-v1-auto",
    baseUrl: optionalEnv("KIMI_BASE_URL") || "https://api.moonshot.cn/v1",
    note: "Model API keys are read only from backend environment variables and are never exposed to the browser."
  });
});

app.post("/ai/test", async (_req, res, next) => {
  try {
    const result = await callKimiJson([
      { role: "system", content: "You are a JSON-only health checker." },
      { role: "user", content: "Return {\"ok\":true,\"message\":\"kimi connected\"}." }
    ], { ok: false, message: "kimi not configured" });
    return sendJson(res, { success: true, result });
  } catch (error) {
    return next(error);
  }
});

app.get("/reply-templates", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req);
    const shouldSeed = req.query.seed !== "false";
    if (shouldSeed) await ensureDefaultReplyTemplates(shopId);
    const templates = await prisma.replyTemplate.findMany({
      where: { shopId },
      orderBy: [{ active: "desc" }, { updatedAt: "desc" }],
      take: 200
    });
    return sendJson(res, { success: true, templates });
  } catch (error) {
    return next(error);
  }
});

app.post("/reply-templates", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const name = normalizeText(req.body?.name);
    const intentCode = normalizeText(req.body?.intentCode);
    const category = normalizeText(req.body?.category || intentCode);
    const content = String(req.body?.content || "").trim();
    if (!name || !intentCode || !content) throw new HttpError(400, "name, intentCode and content are required");

    const latest = await prisma.replyTemplate.findFirst({
      where: { shopId, name },
      orderBy: { version: "desc" }
    });
    const version = latest ? latest.version + 1 : 1;
    const template = await prisma.replyTemplate.create({
      data: {
        shopId,
        name,
        intentCode,
        category,
        language: normalizeText(req.body?.language) || "es-MX",
        scenario: normalizeText(req.body?.scenario) || "售后处理",
        keywords: Array.isArray(req.body?.keywords) ? req.body.keywords.map((item: unknown) => normalizeText(item)).filter(Boolean) : [],
        content,
        variables: Array.isArray(req.body?.variables) ? req.body.variables.map((item: unknown) => normalizeText(item)).filter(Boolean) : [],
        requiresReview: req.body?.requiresReview === undefined ? true : Boolean(req.body.requiresReview),
        version
      }
    });
    await prisma.replyTemplateVersion.create({ data: { templateId: template.id, version, content, note: "created from workspace" } });
    await createOperationLog(req, { shopId, action: "reply_template.create", targetType: "reply_template", targetId: template.id });
    return sendJson(res, { success: true, template });
  } catch (error) {
    return next(error);
  }
});

app.post("/reply-templates/:id/toggle", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const existing = await prisma.replyTemplate.findFirst({ where: { id: String(req.params.id), shopId } });
    if (!existing) throw new HttpError(404, "reply template not found");
    const template = await prisma.replyTemplate.update({
      where: { id: existing.id },
      data: { active: req.body?.active === undefined ? !existing.active : Boolean(req.body.active) }
    });
    await createOperationLog(req, { shopId, action: "reply_template.toggle", targetType: "reply_template", targetId: template.id, detail: { active: template.active } });
    return sendJson(res, { success: true, template });
  } catch (error) {
    return next(error);
  }
});

app.get("/kb/skus", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req);
    const search = normalizeText(req.query.search);
    const skus = await prisma.skuKnowledge.findMany({
      where: {
        shopId,
        ...(search ? { OR: [{ sku: { contains: search, mode: "insensitive" } }, { title: { contains: search, mode: "insensitive" } }, { itemId: { contains: search, mode: "insensitive" } }] } : {})
      },
      orderBy: { updatedAt: "desc" },
      take: 300
    });
    return sendJson(res, { success: true, skus });
  } catch (error) {
    return next(error);
  }
});

app.post("/kb/skus/import", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const rows = Array.isArray(req.body?.items) ? req.body.items : parseSkuCsv(String(req.body?.csv || ""));
    if (!rows.length) throw new HttpError(400, "No SKU rows found");

    const results = await prisma.$transaction(async () => {
      const imported = [];
      for (const row of rows) imported.push(await upsertSkuKnowledge(shopId, row as Record<string, unknown>));
      return imported;
    });

    await createOperationLog(req, { shopId, action: "kb.sku.import", targetType: "sku_knowledge", detail: { count: results.length, ip: getClientIp(req) } });
    return sendJson(res, { success: true, count: results.length, skus: results });
  } catch (error) {
    return next(error);
  }
});

app.post("/kb/documents/import", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const title = normalizeText(req.body?.title);
    const docType = normalizeText(req.body?.docType) || "faq";
    const content = String(req.body?.content || "").trim();
    const sku = normalizeText(req.body?.sku);
    const locale = normalizeText(req.body?.locale) || "es-MX";
    if (!title || !content) throw new HttpError(400, "title and content are required");

    const plan = await agenticChunkDocument({ title, docType, content, sku });
    const result = await prisma.$transaction(async (tx) => {
      const document = await tx.kbDocument.create({ data: { shopId, title, docType, content, locale, status: "indexed" } });
      await tx.kbChunk.createMany({
        data: plan.chunks.map((chunk) => ({
          documentId: document.id,
          shopId,
          content: chunk.content,
          metadata: safeJson({
            title: chunk.title,
            doc_type: chunk.doc_type,
            sku_tags: chunk.sku_tags,
            intent_tags: chunk.intent_tags,
            risk_tags: chunk.risk_tags,
            source_title: title
          }) as Prisma.InputJsonValue,
          scoreHint: chunk.priority
        }))
      });
      return { document, chunks: plan.chunks };
    });

    await createOperationLog(req, { shopId, action: "kb.document.import", targetType: "kb_document", targetId: result.document.id, detail: { chunks: result.chunks.length, kimi: kimiConfigured() } });
    return sendJson(res, { success: true, ...result });
  } catch (error) {
    return next(error);
  }
});

app.get("/kb/documents", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req);
    const documents = await prisma.kbDocument.findMany({ where: { OR: [{ shopId }, { shopId: null }] }, include: { chunks: true }, orderBy: { updatedAt: "desc" }, take: 200 });
    return sendJson(res, { success: true, documents });
  } catch (error) {
    return next(error);
  }
});

app.post("/kb/search", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const query = normalizeText(req.body?.query);
    if (!query) throw new HttpError(400, "query is required");
    const hits = await retrieveKnowledge(shopId, query, { sku: req.body?.sku, limit: Number(req.body?.limit || 8) });
    return sendJson(res, { success: true, hits });
  } catch (error) {
    return next(error);
  }
});

app.get("/presale/questions", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req);
    const questions = await prisma.presaleQuestion.findMany({ where: { shopId }, orderBy: { createdAt: "desc" }, take: 100 });
    return sendJson(res, { success: true, questions });
  } catch (error) {
    return next(error);
  }
});

app.post("/presale/questions/:id/generate", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const question = await prisma.presaleQuestion.findFirst({ where: { id: String(req.params.id), shopId } });
    if (!question) throw new HttpError(404, "question not found");
    const sku = await findSkuKnowledgeForQuestion(question);
    const rawItem = (question.rawItem || {}) as Record<string, unknown>;
    const query = `${question.questionText || ""} ${rawItem.title || ""} ${sku?.sku || ""}`;
    const ragHits = await retrieveKnowledge(shopId, query, { sku: sku?.sku || normalizeText(rawItem.sku), limit: 6 });
    const draft = await generatePresaleWithAi({
      questionText: question.questionText || "",
      itemTitle: normalizeText(rawItem.title),
      sku: sku?.sku,
      knowledge: skuToKnowledge(sku),
      ragHits
    });

    const updated = await prisma.presaleQuestion.update({
      where: { id: question.id },
      data: { aiDraft: draft.answer_es_mx, aiConfidence: draft.confidence, riskLevel: draft.risk_level, reviewStatus: draft.needs_human_review ? "needs_human" : "draft_ready" }
    });
    await prisma.aiSuggestion.create({
      data: {
        shopId,
        targetType: "presale_question",
        targetId: question.id,
        model: optionalEnv("AI_PROVIDER") || "local_rules",
        promptVersion: kimiConfigured() ? "presale-v2-kimi-rag" : "presale-v2-local-rag",
        inputSnapshot: safeJson({ question, sku, ragHits }) as unknown as Prisma.InputJsonValue,
        outputJson: safeJson(draft) as unknown as Prisma.InputJsonValue,
        outputText: draft.answer_es_mx,
        riskFlags: draft.policy_flags
      }
    });

    return sendJson(res, { success: true, question: updated, draft, ragHits });
  } catch (error) {
    return next(error);
  }
});

app.post("/presale/questions/:id/approve", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const question = await prisma.presaleQuestion.update({
      where: { id: String(req.params.id) },
      data: { finalAnswer: String(req.body?.answerText || req.body?.finalAnswer || "").trim(), reviewStatus: "approved" }
    });
    if (question.shopId !== shopId) throw new HttpError(403, "Cross-shop update blocked");
    await createOperationLog(req, { shopId, action: "presale.approve", targetType: "presale_question", targetId: question.id });
    return sendJson(res, { success: true, question });
  } catch (error) {
    return next(error);
  }
});

app.post("/presale/questions/:id/send", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const dryRun = req.body?.dryRun !== false || process.env.AUTO_SEND_PRESALE !== "true";
    const question = await prisma.presaleQuestion.findFirst({ where: { id: String(req.params.id), shopId } });
    if (!question) throw new HttpError(404, "question not found");

    if (dryRun) {
      const updated = await prisma.presaleQuestion.update({
        where: { id: question.id },
        data: { finalAnswer: String(req.body?.answerText || question.finalAnswer || question.aiDraft || "").trim(), reviewStatus: "dry_run_sent", sentAt: new Date() }
      });
      await createOperationLog(req, { shopId, action: "presale.send.dry_run", targetType: "presale_question", targetId: question.id });
      return sendJson(res, { success: true, dryRun: true, question: updated });
    }

    return sendJson(res, { success: false, message: "Real POST /answers is not enabled yet. OAuth, status recheck and audit are required." }, 501);
  } catch (error) {
    return next(error);
  }
});

app.get("/aftersale/threads", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req);
    const threads = await prisma.aftersaleThread.findMany({ where: { shopId }, include: { messages: { orderBy: { messageDate: "asc" }, take: 10 } }, orderBy: { updatedAt: "desc" }, take: 100 });
    return sendJson(res, { success: true, threads });
  } catch (error) {
    return next(error);
  }
});

app.post("/aftersale/threads/:id/analyze", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const thread = await prisma.aftersaleThread.findFirst({ where: { id: String(req.params.id), shopId }, include: { messages: { orderBy: { messageDate: "desc" }, take: 8 } } });
    if (!thread) throw new HttpError(404, "thread not found");

    const rawContext = (thread.rawContext || {}) as Record<string, unknown>;
    const sku = await findSkuKnowledgeForThread(thread);
    const latestMessage = normalizeText(req.body?.latestMessage) || thread.messages[0]?.text || normalizeText(rawContext.latestMessage);
    const ragHits = await retrieveKnowledge(shopId, `${latestMessage} ${thread.orderId || ""}`, { sku: sku?.sku || normalizeText(rawContext.sku), limit: 8 });
    const analysis = await generateAftersaleWithAi({
      latestMessage,
      orderStatus: normalizeText(rawContext.orderStatus),
      shipmentStatus: normalizeText(rawContext.shipmentStatus),
      hasClaim: Boolean(thread.claimId || rawContext.claimId),
      hasReturn: Boolean(thread.returnId || rawContext.returnId),
      sku: sku?.sku,
      knowledge: skuToKnowledge(sku),
      ragHits
    });
    await ensureDefaultReplyTemplates(shopId);
    const matchedTemplate = await findBestReplyTemplate(shopId, analysis.category, latestMessage);
    const suggestedReply = matchedTemplate
      ? fillReplyTemplate(matchedTemplate.content, {
        orderId: thread.orderId?.toString(),
        packId: thread.packId.toString(),
        sku: sku?.sku || rawContext.sku,
        itemTitle: sku?.title,
        trackingStatus: rawContext.shipmentStatus,
        estimatedDeliveryDate: rawContext.estimatedDeliveryDate
      })
      : analysis.suggested_reply_es_mx;

    const updated = await prisma.aftersaleThread.update({
      where: { id: thread.id },
      data: { category: analysis.category, riskLevel: analysis.risk_level, summary: analysis.summary_zh, suggestedAction: analysis.suggested_action_zh, suggestedReply }
    });
    await prisma.aiSuggestion.create({
      data: {
        shopId,
        targetType: "aftersale_thread",
        targetId: thread.id,
        model: optionalEnv("AI_PROVIDER") || "local_rules",
        promptVersion: kimiConfigured() ? "aftersale-v2-kimi-rag" : "aftersale-v2-local-rag",
        inputSnapshot: safeJson({ thread, latestMessage, sku, ragHits }) as unknown as Prisma.InputJsonValue,
        outputJson: safeJson({ ...analysis, matchedTemplate: matchedTemplate ? { id: matchedTemplate.id, name: matchedTemplate.name } : null }) as unknown as Prisma.InputJsonValue,
        outputText: suggestedReply,
        riskFlags: analysis.forbidden_commitments_detected
      }
    });

    return sendJson(res, { success: true, thread: updated, analysis, suggestedReply, matchedTemplate, ragHits });
  } catch (error) {
    return next(error);
  }
});

app.post("/aftersale/threads/:id/close", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const thread = await prisma.aftersaleThread.findFirst({ where: { id: String(req.params.id), shopId } });
    if (!thread) throw new HttpError(404, "thread not found");
    const updated = await prisma.aftersaleThread.update({ where: { id: thread.id }, data: { status: "closed" } });
    await createOperationLog(req, { shopId, action: "aftersale.close", targetType: "aftersale_thread", targetId: thread.id });
    return sendJson(res, { success: true, thread: updated });
  } catch (error) {
    return next(error);
  }
});

app.get("/reply-reviews", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req);
    const [questions, threads] = await Promise.all([
      prisma.presaleQuestion.findMany({
        where: { shopId, reviewStatus: { in: ["draft_ready", "needs_human", "approved", "dry_run_sent"] } },
        orderBy: { updatedAt: "desc" },
        take: 100
      }),
      prisma.aftersaleThread.findMany({
        where: { shopId, suggestedReply: { not: null } },
        include: { messages: { orderBy: { messageDate: "desc" }, take: 1 } },
        orderBy: { updatedAt: "desc" },
        take: 100
      })
    ]);

    const reviewItems = [
      ...questions.map((question) => {
        const rawItem = (question.rawItem || {}) as Record<string, unknown>;
        return {
          id: question.id,
          source: "买家咨询",
          status: question.reviewStatus,
          buyerQuestion: question.questionText,
          itemTitle: normalizeText(rawItem.title),
          riskLevel: question.riskLevel,
          recommendedReply: question.finalAnswer || question.aiDraft,
          references: [normalizeText(rawItem.sku), normalizeText(rawItem.title)].filter(Boolean),
          updatedAt: question.updatedAt
        };
      }),
      ...threads.map((thread) => ({
        id: thread.id,
        source: "售后处理",
        status: thread.status,
        buyerQuestion: thread.messages[0]?.text || normalizeText((thread.rawContext || {}) as Record<string, unknown>),
        itemTitle: `Order ${thread.orderId || thread.packId}`,
        riskLevel: thread.riskLevel,
        recommendedReply: thread.suggestedReply,
        references: [thread.category, thread.suggestedAction].filter(Boolean),
        updatedAt: thread.updatedAt
      }))
    ].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    return sendJson(res, { success: true, reviews: reviewItems });
  } catch (error) {
    return next(error);
  }
});

app.get("/operation-logs", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req);
    const logs = await prisma.operationLog.findMany({ where: { shopId }, include: { actor: true }, orderBy: { createdAt: "desc" }, take: 100 });
    return sendJson(res, { success: true, logs });
  } catch (error) {
    return next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  console.error("[meli-ai-support-api]", message);
  sendJson(res, { success: false, message }, status);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Meli AI Support API listening on http://0.0.0.0:${PORT}`);
});
