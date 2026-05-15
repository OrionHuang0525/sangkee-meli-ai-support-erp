import crypto from "node:crypto";
import cors from "cors";
import express from "express";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import * as XLSX from "xlsx";
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
const KB_MAX_FILE_BYTES = 15 * 1024 * 1024;
const STARTED_AT = new Date();
const READINESS_CORE_ENV = ["DATABASE_URL", "REDIS_URL", "TOKEN_ENCRYPTION_KEY"] as const;
const READINESS_EXTERNAL_ENV = ["MELI_CLIENT_ID", "MELI_CLIENT_SECRET", "MELI_REDIRECT_URI", "WEBHOOK_SHARED_SECRET"] as const;
const READINESS_STRICT_EXTERNAL = process.env.READINESS_STRICT_EXTERNAL === "true";

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const webhookQueue = new Queue("meli-webhook-events", { connection: redis });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "25mb" }));

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

function queueJobId(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function optionalEnv(name: string): string {
  return String(process.env[name] || "").trim();
}

function requireEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) throw new HttpError(400, `Missing environment variable ${name}`);
  return value;
}

async function checkWithTimeout(name: string, check: () => Promise<unknown>, timeoutMs = 1500) {
  const startedAt = Date.now();
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${name} check timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function checkEnvironment() {
  const missingCore = READINESS_CORE_ENV.filter((name) => !optionalEnv(name));
  const missingExternal = READINESS_EXTERNAL_ENV.filter((name) => !optionalEnv(name));
  let tokenEncryptionReady = false;
  let tokenEncryptionMessage = "";
  try {
    tokenEncryptionReady = Boolean(getEncryptionKey());
  } catch (error) {
    tokenEncryptionMessage = error instanceof Error ? error.message : String(error);
  }

  return {
    strictExternal: READINESS_STRICT_EXTERNAL,
    missingCore,
    missingExternal,
    tokenEncryptionReady,
    tokenEncryptionMessage: tokenEncryptionReady ? "" : tokenEncryptionMessage
  };
}

async function buildReadiness() {
  const [database, redisCheck] = await Promise.all([
    checkWithTimeout("database", () => prisma.$queryRaw`SELECT 1`),
    checkWithTimeout("redis", () => redis.ping())
  ]);
  const env = checkEnvironment();
  const envReady = env.missingCore.length === 0
    && env.tokenEncryptionReady
    && (!env.strictExternal || env.missingExternal.length === 0);
  const ready = database.ok && redisCheck.ok && envReady;

  return {
    ready,
    service: "meli-ai-support-api",
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks: { database, redis: redisCheck, env: { ok: envReady, ...env } }
  };
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

function tryDecryptSecret(payload?: string): string {
  if (!payload) return "";
  try {
    return decryptSecret(payload);
  } catch {
    return "";
  }
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

async function getSetting<T = Record<string, unknown>>(shopId: string, key: string): Promise<T | null> {
  const setting = await prisma.settingsRule.findUnique({ where: { shopId_key: { shopId, key } } });
  return setting?.active ? setting.value as T : null;
}

async function upsertSetting(shopId: string, key: string, value: Prisma.InputJsonValue) {
  return prisma.settingsRule.upsert({
    where: { shopId_key: { shopId, key } },
    create: { shopId, key, value, active: true },
    update: { value, active: true }
  });
}

function maskUrl(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const last = parts.pop() || "";
    const maskedLast = last.length > 8 ? `${last.slice(0, 4)}****${last.slice(-4)}` : "****";
    url.pathname = `/${[...parts, maskedLast].join("/")}`;
    return url.toString();
  } catch {
    return value.length > 12 ? `${value.slice(0, 6)}****${value.slice(-4)}` : "****";
  }
}

type FeishuWebhookConfig = {
  webhookUrlEnc?: string;
  secretEnc?: string;
  enabled?: boolean;
  notifyPresale?: boolean;
  notifyAftersale?: boolean;
};

type AutomationPolicy = {
  autoReplyMode?: "off" | "low_risk_templates_only" | "all_templates";
  bulkApproveLowRisk?: boolean;
  requireHumanForHighRisk?: boolean;
};

type HandoffReason = "buyer_requested_human" | "invoice_required" | "unmatched_other" | "ai_escalation";

type HandoffDecision = {
  required: boolean;
  reason?: HandoffReason;
  label?: string;
};

async function getFeishuWebhookConfig(shopId: string) {
  const config = await getSetting<FeishuWebhookConfig>(shopId, "feishu_webhook");
  if (!config?.webhookUrlEnc) return null;
  const webhookUrl = tryDecryptSecret(config.webhookUrlEnc);
  if (!webhookUrl) return null;
  return {
    webhookUrl,
    secret: tryDecryptSecret(config.secretEnc),
    enabled: config.enabled !== false,
    notifyPresale: config.notifyPresale !== false,
    notifyAftersale: config.notifyAftersale !== false
  };
}

function buildFeishuPayload(text: string, secret?: string) {
  const payload: Record<string, unknown> = {
    msg_type: "text",
    content: { text }
  };
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sign = crypto.createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
    payload.timestamp = timestamp;
    payload.sign = sign;
  }
  return payload;
}

async function sendFeishuWebhook(shopId: string, text: string) {
  const config = await getFeishuWebhookConfig(shopId);
  if (!config?.enabled || !config.webhookUrl) return { skipped: true, reason: "not_configured" };

  const response = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify(buildFeishuPayload(text, config.secret))
  });
  const body = await response.text();
  if (!response.ok) throw new HttpError(502, `Feishu webhook failed: HTTP ${response.status} ${body.slice(0, 300)}`);
  return { skipped: false, status: response.status };
}

async function notifyFeishuSafely(shopId: string, text: string) {
  try {
    return await sendFeishuWebhook(shopId, text);
  } catch (error) {
    console.warn("[feishu] notify failed", error instanceof Error ? error.message : String(error));
    return { skipped: true, reason: "send_failed" };
  }
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

function isWorkbookBytes(bytes: Buffer) {
  return bytes.length >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

function parseSkuWorkbook(bytes: Buffer): Array<Record<string, string>> {
  const workbook = XLSX.read(bytes, { type: "buffer", cellDates: false, raw: false });
  const rows: Array<Record<string, string>> = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
      raw: false,
      blankrows: false
    });

    for (const row of sheetRows) {
      const normalized = Object.fromEntries(
        Object.entries(row)
          .map(([key, value]) => [normalizeText(key), normalizeText(value)])
          .filter(([key, value]) => key || value)
      ) as Record<string, string>;
      if (Object.values(normalized).some(Boolean)) rows.push({ ...normalized, sheetName });
    }
  }

  return rows;
}

function decodedTextScore(text: string) {
  const badPatterns = ["\uFFFD", "锟", "閿", "鍙", "鏂", "涓", "涔", "鑱", "绋", "铆", "贸", "帽", "煤", "Ã", "Â"];
  let score = 0;
  for (const pattern of badPatterns) score += (text.match(new RegExp(pattern, "g")) || []).length * 10;
  score += (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length * 6;
  if (/sku/i.test(text)) score -= 6;
  if (/title|商品|标题|名称|factura|garant/i.test(text)) score -= 3;
  if (text.includes(",") || text.includes("\t") || text.includes(";")) score -= 2;
  return score;
}

function decodeCsvPayload(body: unknown) {
  const input = (body || {}) as Record<string, unknown>;
  const directCsv = String(input.csv || "");
  if (directCsv) return directCsv;

  const base64 = normalizeText(input.fileBase64 || input.csvBase64);
  if (!base64) return "";

  const bytes = Buffer.from(base64, "base64");
  const requested = normalizeText(input.encoding).toLowerCase();
  const encodings = requested && requested !== "auto"
    ? [requested]
    : ["utf-8", "gb18030", "utf-16le", "big5"];
  const decoded = encodings.flatMap((encoding) => {
    try {
      const text = new TextDecoder(encoding, { fatal: encoding === "utf-8" }).decode(bytes).replace(/^\uFEFF/, "");
      return [{ text, score: decodedTextScore(text) }];
    } catch {
      return [];
    }
  });
  return decoded.sort((a, b) => a.score - b.score)[0]?.text || bytes.toString("utf8");
}

function parseSkuImportRows(body: unknown) {
  const input = (body || {}) as Record<string, unknown>;
  if (Array.isArray(input.items)) return input.items as Array<Record<string, unknown>>;

  const base64 = normalizeText(input.fileBase64 || input.csvBase64);
  if (base64) {
    const bytes = Buffer.from(base64, "base64");
    assertKbFileAllowed({
      bytes,
      fileName: normalizeText(input.fileName),
      mimeType: normalizeText(input.mimeType),
      allowed: new Set(["csv", "txt", "xlsx", "xls"]),
      target: "商品资料"
    });
    if (isWorkbookBytes(bytes)) return parseSkuWorkbook(bytes);
  }

  return parseSkuCsv(decodeCsvPayload(body));
}

type ParsedKnowledgeFile = {
  fileName: string;
  type: "txt" | "pdf" | "docx";
  title: string;
  content: string;
  characters: number;
};

function stripDataUrlBase64(value: string) {
  const [, payload] = value.split(",", 2);
  return value.startsWith("data:") && payload ? payload : value;
}

function extensionOf(fileName: string) {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "";
}

function inferKbFileType(input: { fileName?: string; mimeType?: string; bytes: Buffer }) {
  const extension = extensionOf(input.fileName || "");
  const mimeType = normalizeText(input.mimeType).toLowerCase();
  if (extension === "pdf" || mimeType.includes("pdf") || input.bytes.subarray(0, 4).toString("utf8") === "%PDF") return "pdf";
  if (extension === "docx" || mimeType.includes("wordprocessingml")) return "docx";
  if (extension === "xlsx" || extension === "xls" || mimeType.includes("spreadsheet") || isWorkbookBytes(input.bytes)) return "xlsx";
  if (extension === "csv" || mimeType.includes("csv")) return "csv";
  if (extension === "txt" || mimeType.startsWith("text/")) return "txt";
  return extension || "unknown";
}

function assertKbFileAllowed(input: {
  bytes: Buffer;
  fileName?: string;
  mimeType?: string;
  allowed: Set<string>;
  target: string;
}) {
  if (!input.bytes.length) throw new HttpError(400, "文件内容为空，请重新选择文件");
  if (input.bytes.length > KB_MAX_FILE_BYTES) throw new HttpError(400, "文件过大，单个知识库文件不能超过 15MB");
  const type = inferKbFileType(input);
  if (!input.allowed.has(type)) {
    throw new HttpError(400, `${input.target}暂不支持 ${type === "unknown" ? "该文件类型" : `.${type} 文件`}，请上传 ${[...input.allowed].map((item) => `.${item}`).join("、")}`);
  }
  return type;
}

function decodeTextBytes(bytes: Buffer, requested = "auto") {
  const encodings = requested && requested !== "auto"
    ? [requested]
    : ["utf-8", "gb18030", "utf-16le", "big5"];
  const decoded = encodings.flatMap((encoding) => {
    try {
      const text = new TextDecoder(encoding, { fatal: encoding === "utf-8" }).decode(bytes).replace(/^\uFEFF/, "");
      return [{ text, score: decodedTextScore(text) }];
    } catch {
      return [];
    }
  });
  return (decoded.sort((a, b) => a.score - b.score)[0]?.text || bytes.toString("utf8")).trim();
}

function titleFromFileName(fileName: string) {
  const base = (fileName || "售前资料").replace(/\.[^.]+$/, "").trim();
  return base || "售前资料";
}

async function parseKnowledgeDocumentFile(body: unknown): Promise<ParsedKnowledgeFile | null> {
  const input = (body || {}) as Record<string, unknown>;
  const base64 = normalizeText(input.fileBase64);
  if (!base64) return null;

  const fileName = normalizeText(input.fileName) || "售前资料.txt";
  const mimeType = normalizeText(input.mimeType);
  const bytes = Buffer.from(stripDataUrlBase64(base64), "base64");
  const type = assertKbFileAllowed({
    bytes,
    fileName,
    mimeType,
    allowed: new Set(["txt", "pdf", "docx"]),
    target: "文本资料"
  }) as ParsedKnowledgeFile["type"];

  let content = "";
  if (type === "txt") {
    content = decodeTextBytes(bytes, normalizeText(input.encoding).toLowerCase());
  } else if (type === "docx") {
    const result = await mammoth.extractRawText({ buffer: bytes });
    content = String(result.value || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  } else if (type === "pdf") {
    const parser = new PDFParse({ data: bytes });
    try {
      const result = await parser.getText();
      content = String(result.text || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    } finally {
      await parser.destroy();
    }
  }

  content = content.trim();
  if (!content) throw new HttpError(400, "没有从文件中解析到可用文字，请检查文件内容后重试");

  return {
    fileName,
    type,
    title: titleFromFileName(fileName),
    content,
    characters: content.length
  };
}

function pickInput(input: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== null && String(input[key]).trim() !== "") return input[key];
  }
  return "";
}

function mapSkuInput(input: Record<string, unknown>) {
  const sku = normalizeText(pickInput(input, ["sku", "SKU"]));
  const title = normalizeText(pickInput(input, [
    "title",
    "TITLE",
    "titulo",
    "TITULO",
    "name",
    "nombre",
    "\u6807\u9898",
    "\u5546\u54c1\u6807\u9898",
    "\u5546\u54c1\u540d\u79f0"
  ])) || sku;
  return {
    sku,
    itemId: normalizeText(pickInput(input, ["itemId", "item_id", "item", "\u5546\u54c1ID", "\u5546\u54c1\u7f16\u53f7", "Item"])),
    title,
    brand: normalizeText(pickInput(input, ["brand", "marca", "\u54c1\u724c"])),
    category: normalizeText(pickInput(input, ["category", "categoria", "\u7c7b\u76ee", "\u5206\u7c7b", "sheetName"])),
    locale: normalizeText(input.locale) || "es-MX",
    sellingPoints: normalizeText(pickInput(input, ["sellingPoints", "selling_points", "description", "DESCRIPTION", "Descripcion", "DESCRIPCION", "descripción", "descripcion", "\u5356\u70b9", "\u4ea7\u54c1\u8bf4\u660e", "\u5546\u54c1\u8bf4\u660e"])),
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

async function upsertSkuKnowledge(shopId: string, input: Record<string, unknown>, client: Prisma.TransactionClient | typeof prisma = prisma) {
  const mapped = mapSkuInput(input);
  if (!mapped.sku || !mapped.title) throw new HttpError(400, "sku and title are required");

  return client.skuKnowledge.upsert({
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

function skuKnowledgeContent(input: {
  sku?: string | null;
  title?: string | null;
  brand?: string | null;
  category?: string | null;
  sellingPoints?: string | null;
  faq?: string | null;
  warrantyPolicy?: string | null;
  invoicePolicy?: string | null;
  shippingNotes?: string | null;
  returnPolicy?: string | null;
  forbiddenNotes?: string | null;
}) {
  return [
    `SKU: ${input.sku || "-"}`,
    `Nombre: ${input.title || "-"}`,
    input.brand ? `Marca: ${input.brand}` : "",
    input.category ? `Tienda/Grupo: ${input.category}` : "",
    input.sellingPoints ? `Descripción:\n${input.sellingPoints}` : "",
    input.faq ? `Preguntas frecuentes:\n${input.faq}` : "",
    input.invoicePolicy ? `Facturación:\n${input.invoicePolicy}` : "",
    input.warrantyPolicy ? `Garantía:\n${input.warrantyPolicy}` : "",
    input.shippingNotes ? `Envío:\n${input.shippingNotes}` : "",
    input.returnPolicy ? `Devoluciones:\n${input.returnPolicy}` : "",
    input.forbiddenNotes ? `Notas prohibidas:\n${input.forbiddenNotes}` : ""
  ].filter(Boolean).join("\n\n");
}

async function reindexSkuKnowledge(tx: Prisma.TransactionClient, shopId: string, skuKnowledge: Awaited<ReturnType<typeof upsertSkuKnowledge>>) {
  const title = `SKU ${skuKnowledge.sku}`;
  const content = skuKnowledgeContent(skuKnowledge);
  const sku = skuKnowledge.sku;
  const plan = fallbackChunkPlan(title, "product", content, sku);

  const existing = await tx.kbDocument.findMany({ where: { shopId, docType: "product", title } });
  if (existing.length) await tx.kbDocument.deleteMany({ where: { id: { in: existing.map((document) => document.id) } } });

  const document = await tx.kbDocument.create({
    data: {
      shopId,
      title,
      docType: "product",
      content,
      locale: skuKnowledge.locale || "es-MX",
      status: "indexed"
    }
  });

  await createChunksWithEmbeddings(tx, plan.chunks.map((chunk) => ({
    documentId: document.id,
    shopId,
    content: chunk.content,
    metadata: safeJson({
      title: chunk.title,
      doc_type: chunk.doc_type,
      sku_tags: [sku],
      intent_tags: ["presale", "product"],
      risk_tags: chunk.risk_tags,
      source_title: title,
      source: "sku_import",
      skuKnowledgeId: skuKnowledge.id,
      category: skuKnowledge.category
    }) as Prisma.InputJsonValue,
    scoreHint: chunk.priority
  })));

  return document;
}

type AiRuntimeConfig = {
  provider: string;
  configured: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  stream: boolean;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  topP: number;
  chatTemplateKwargs?: Record<string, unknown>;
};

function selectedAiProvider() {
  return (optionalEnv("AI_PROVIDER") || "local").toLowerCase();
}

function boolEnv(name: string, fallback: boolean) {
  const raw = optionalEnv(name).toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function numberEnv(names: string[], fallback: number) {
  for (const name of names) {
    const raw = optionalEnv(name);
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function getAiRuntimeConfig(): AiRuntimeConfig {
  const provider = selectedAiProvider();
  if (provider === "nvidia") {
    const model = optionalEnv("NVIDIA_MODEL") || optionalEnv("KIMI_MODEL") || "moonshotai/kimi-k2.6";
    return {
      provider,
      configured: Boolean(optionalEnv("NVIDIA_API_KEY") || optionalEnv("NVAPI_KEY")),
      apiKey: optionalEnv("NVIDIA_API_KEY") || optionalEnv("NVAPI_KEY"),
      baseUrl: optionalEnv("NVIDIA_BASE_URL") || "https://integrate.api.nvidia.com/v1",
      model,
      stream: boolEnv("NVIDIA_STREAM", false),
      timeoutMs: numberEnv(["NVIDIA_TIMEOUT_MS", "AI_TIMEOUT_MS"], 60_000),
      maxTokens: numberEnv(["NVIDIA_MAX_TOKENS", "AI_MAX_TOKENS"], 16_384),
      temperature: numberEnv(["NVIDIA_TEMPERATURE", "AI_TEMPERATURE"], 1),
      topP: numberEnv(["NVIDIA_TOP_P", "AI_TOP_P"], 1),
      chatTemplateKwargs: { thinking: boolEnv("NVIDIA_THINKING", true) }
    };
  }

  const model = optionalEnv("KIMI_MODEL") || "moonshot-v1-auto";
  return {
    provider,
    configured: Boolean(optionalEnv("KIMI_API_KEY") || optionalEnv("MOONSHOT_API_KEY")),
    apiKey: optionalEnv("KIMI_API_KEY") || optionalEnv("MOONSHOT_API_KEY"),
    baseUrl: optionalEnv("KIMI_BASE_URL") || "https://api.moonshot.cn/v1",
    model,
    stream: boolEnv("KIMI_STREAM", false),
    timeoutMs: numberEnv(["KIMI_TIMEOUT_MS", "AI_TIMEOUT_MS"], 60_000),
    maxTokens: numberEnv(["KIMI_MAX_TOKENS", "AI_MAX_TOKENS"], 4096),
    temperature: numberEnv(["KIMI_TEMPERATURE", "AI_TEMPERATURE"], model.startsWith("kimi-k") ? 1 : 0.2),
    topP: numberEnv(["KIMI_TOP_P", "AI_TOP_P"], 1)
  };
}

function aiConfigured() {
  const config = getAiRuntimeConfig();
  return config.provider !== "local" && config.configured;
}

function kimiConfigured() {
  return aiConfigured();
}

function aiGenerationEnabled() {
  return ["kimi", "moonshot", "nvidia"].includes(selectedAiProvider()) && aiConfigured();
}

function aiPromptVersion(flow: "presale" | "aftersale") {
  if (!aiGenerationEnabled()) return flow === "presale" ? "presale-v2-local-rag" : "aftersale-v2-local-template";
  return flow === "presale" ? `presale-v2-${selectedAiProvider()}-rag` : `aftersale-v2-${selectedAiProvider()}-template`;
}

async function readStreamingChatContent(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: string };
            message?: { content?: string };
          }>;
        };
        content += parsed.choices?.map((choice) => choice.delta?.content || choice.message?.content || "").join("") || "";
      } catch {
        content += data;
      }
    }
  }

  return content;
}

async function callAiJson<T>(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, fallback: T): Promise<T> {
  const config = getAiRuntimeConfig();
  if (!config.configured || config.provider === "local") return fallback;

  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: config.stream ? "text/event-stream" : "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        ...messages,
        { role: "user", content: "Return only valid JSON. Do not wrap it in markdown." }
      ],
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      top_p: config.topP,
      stream: config.stream,
      ...(config.chatTemplateKwargs ? { chat_template_kwargs: config.chatTemplateKwargs } : {})
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new HttpError(502, `${config.provider} API failed: HTTP ${response.status} ${body}`);
  }

  const content = config.stream
    ? await readStreamingChatContent(response)
    : ((await response.json()) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content || "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new HttpError(502, `${config.provider} API did not return JSON`);
  return JSON.parse(jsonMatch[0]) as T;
}

async function streamAiText(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  onChunk: (chunk: string) => void
) {
  const config = getAiRuntimeConfig();
  if (!config.configured || config.provider === "local") return "";

  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: Math.min(config.maxTokens, 1200),
      temperature: config.temperature,
      top_p: config.topP,
      stream: true,
      ...(config.chatTemplateKwargs ? { chat_template_kwargs: config.chatTemplateKwargs } : {})
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new HttpError(502, `${config.provider} API failed: HTTP ${response.status} ${body}`);
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: string };
            message?: { content?: string };
          }>;
        };
        const chunk = parsed.choices?.map((choice) => choice.delta?.content || choice.message?.content || "").join("") || "";
        if (chunk) {
          content += chunk;
          onChunk(chunk);
        }
      } catch {
        content += data;
        onChunk(data);
      }
    }
  }

  return content.trim();
}

function streamPresaleSystemPrompt() {
  return [
    "Eres un asistente de atención preventa para Mercado Libre México.",
    "Responde en español mexicano natural, breve y útil.",
    "Usa únicamente la información del producto, SKU, políticas y base de conocimiento proporcionadas.",
    "No compartas WhatsApp, teléfono, correo, direcciones, enlaces externos ni invites a pagar fuera de Mercado Libre.",
    "No prometas fechas exactas, descuentos, reembolsos ni garantías no documentadas.",
    "Devuelve solamente el texto final que verá el comprador. No devuelvas JSON, markdown ni explicación interna."
  ].join("\n");
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
    const result = await callAiJson([
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

function dynamicTopK(query: string, requested?: number) {
  if (requested && Number.isFinite(requested)) return Math.max(1, Math.min(requested, 30));
  const termCount = tokenize(query).length;
  if (termCount <= 4) return 5;
  if (termCount <= 12) return 8;
  return 12;
}

function hash32(input: string) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeVector(vector: number[]) {
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(8)));
}

function localEmbedding(text: string, dimensions = 1536) {
  const vector = Array.from({ length: dimensions }, () => 0);
  const terms = tokenize(text);
  for (const term of terms) {
    const idx = hash32(term) % dimensions;
    const sign = hash32(`${term}:sign`) % 2 === 0 ? 1 : -1;
    vector[idx] += sign * (1 + Math.min(term.length, 16) / 16);
  }
  return normalizeVector(vector);
}

function vectorLiteral(vector: number[]) {
  return `[${vector.map((value) => Number.isFinite(value) ? value.toFixed(8) : "0").join(",")}]`;
}

async function embedTexts(texts: string[]) {
  const apiKey = optionalEnv("EMBEDDING_API_KEY") || optionalEnv("OPENAI_API_KEY");
  const model = optionalEnv("EMBEDDING_MODEL") || optionalEnv("OPENAI_EMBEDDING_MODEL");
  const baseUrl = optionalEnv("EMBEDDING_BASE_URL") || optionalEnv("OPENAI_BASE_URL") || "https://api.openai.com/v1";
  if (!apiKey || !model) return texts.map((text) => localEmbedding(text));

  try {
    const vectors: number[][] = [];
    for (let index = 0; index < texts.length; index += 64) {
      const input = texts.slice(index, index + 64);
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model, input })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { data?: Array<{ embedding?: number[] }> };
      for (const item of payload.data || []) {
        if (!Array.isArray(item.embedding)) throw new Error("missing embedding vector");
        vectors.push(normalizeVector(item.embedding.slice(0, 1536)));
      }
    }
    if (vectors.length === texts.length) return vectors;
  } catch (error) {
    console.warn("[rag] embedding API failed, using local deterministic embeddings", error instanceof Error ? error.message : String(error));
  }

  return texts.map((text) => localEmbedding(text));
}

let vectorSchemaReady: Promise<boolean> | null = null;

async function ensureVectorSchema() {
  if (!vectorSchemaReady) {
    vectorSchemaReady = (async () => {
      try {
        await prisma.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS vector");
        await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS kb_chunks_embedding_hnsw_idx ON kb_chunks USING hnsw (embedding vector_cosine_ops)");
        return true;
      } catch (error) {
        console.warn("[rag] pgvector schema unavailable, lexical fallback remains active", error instanceof Error ? error.message : String(error));
        return false;
      }
    })();
  }
  return vectorSchemaReady;
}

async function createChunksWithEmbeddings(tx: Prisma.TransactionClient, chunks: Array<{
  documentId: string;
  shopId: string;
  content: string;
  metadata: Prisma.InputJsonValue;
  scoreHint?: number;
}>) {
  const embeddings = await embedTexts(chunks.map((chunk) => chunk.content));
  const canStoreVectors = await ensureVectorSchema();
  const created = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = await tx.kbChunk.create({
      data: {
        documentId: chunks[index].documentId,
        shopId: chunks[index].shopId,
        content: chunks[index].content,
        metadata: chunks[index].metadata,
        scoreHint: chunks[index].scoreHint
      }
    });
    if (canStoreVectors) {
      await tx.$executeRawUnsafe(
        "UPDATE kb_chunks SET embedding = $1::vector WHERE id = $2::uuid",
        vectorLiteral(embeddings[index]),
        chunk.id
      );
    }
    created.push(chunk);
  }
  return created;
}

async function retrieveKnowledge(shopId: string, query: string, options: { sku?: string; limit?: number } = {}): Promise<KnowledgeHit[]> {
  const sku = normalizeText(options.sku);
  const limit = dynamicTopK(query, options.limit);
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

  if (await ensureVectorSchema()) {
    try {
      const [queryVector] = await embedTexts([query]);
      const vectorRows = await prisma.$queryRawUnsafe<Array<{
        id: string;
        title: string;
        doc_type: string;
        content: string;
        metadata: Prisma.JsonValue | null;
        score_hint: unknown;
        similarity: unknown;
      }>>(
        `SELECT c.id, d.title, d.doc_type, c.content, c.metadata, c.score_hint,
                1 - (c.embedding <=> $1::vector) AS similarity
           FROM kb_chunks c
           JOIN kb_documents d ON d.id = c.document_id
          WHERE c.embedding IS NOT NULL
            AND (c.shop_id = $2::uuid OR c.shop_id IS NULL)
          ORDER BY c.embedding <=> $1::vector
          LIMIT $3`,
        vectorLiteral(queryVector),
        shopId,
        Math.max(limit * 4, 20)
      );

      for (const row of vectorRows) {
        const meta = (row.metadata || {}) as Record<string, unknown>;
        const skuTags = Array.isArray(meta.sku_tags) ? meta.sku_tags.map((tag) => String(tag)) : [];
        if (sku && skuTags.length && !skuTags.includes(sku)) continue;
        const semantic = Number(row.similarity || 0);
        const scoreHint = Number(row.score_hint || 0);
        const lexical = lexicalScore(query, `${row.content} ${JSON.stringify(meta)}`);
        const threshold = tokenize(query).length <= 4 ? 0.03 : 0.015;
        if (semantic >= threshold || lexical > 0) {
          hits.push({
            id: row.id,
            title: normalizeText(meta.title) || row.title,
            docType: normalizeText(meta.doc_type) || row.doc_type,
            content: row.content,
            source: "chunk",
            metadata: meta,
            score: semantic * 20 + lexical + scoreHint
          });
        }
      }
    } catch (error) {
      console.warn("[rag] vector search failed, using lexical fallback", error instanceof Error ? error.message : String(error));
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

  const deduped = new Map<string, KnowledgeHit>();
  for (const hit of hits.sort((a, b) => (b.score || 0) - (a.score || 0))) {
    const key = hit.id || `${hit.title}:${hit.content.slice(0, 80)}`;
    if (!deduped.has(key)) deduped.set(key, hit);
  }

  return [...deduped.values()].slice(0, limit);
}

const DEFAULT_REPLY_TEMPLATES = [
  {
    name: "物流未收到",
    intentCode: "not_received",
    category: "shipping_not_received",
    keywords: ["no recibí", "no llego", "no ha llegado", "paquete"],
    content: "Hola, lamentamos lo ocurrido. Te recomendamos revisar el estado del envío desde Mercado Libre. Si el paquete sigue sin actualizarse, por favor continúa el seguimiento desde el flujo oficial de la plataforma.",
    variables: ["orderId", "trackingStatus"],
    requiresReview: false
  },
  {
    name: "物流延迟",
    intentCode: "shipping_delay",
    category: "shipping_delay",
    keywords: ["demora", "tarde", "retraso", "entrega"],
    content: "Hola, sentimos la demora. El envío es gestionado por Mercado Libre y puedes revisar la fecha estimada desde el detalle de tu compra. Seguiremos atentos por este medio.",
    variables: ["estimatedDeliveryDate"],
    requiresReview: false
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
    name: "转人工安抚",
    intentCode: "human_request",
    category: "human_request",
    keywords: ["humano", "persona", "asesor", "agente", "ejecutivo", "representante", "atención humana", "atencion humana", "supervisor"],
    content: "Hola, claro. Ya notificamos a nuestro equipo de atención y una persona revisará tu caso lo antes posible por este mismo chat de Mercado Libre.",
    variables: ["packId", "orderId"],
    requiresReview: false
  },
  {
    name: "商品损坏",
    intentCode: "damaged_item",
    category: "damaged_product",
    keywords: ["dañado", "roto", "quebrado", "defecto"],
    content: "Hola, lamentamos el inconveniente. Para poder revisar el caso, por favor comparte fotos o evidencia del estado del producto dentro del chat de Mercado Libre.",
    variables: ["itemTitle", "sku"],
    requiresReview: false
  },
  {
    name: "退货流程",
    intentCode: "return_request",
    category: "return_request",
    keywords: ["devolver", "devolución", "regresar", "cambio"],
    content: "Hola, para una devolución o cambio es necesario seguir el flujo oficial de Mercado Libre desde el detalle de la compra. Revisaremos la información disponible y te apoyaremos por este medio.",
    variables: ["orderId"],
    requiresReview: false
  },
  {
    name: "退款问题",
    intentCode: "refund_request",
    category: "refund_request",
    keywords: ["reembolso", "dinero", "refund", "pago"],
    content: "Hola, entendemos tu solicitud. Cualquier reembolso debe revisarse y procesarse mediante el flujo oficial de Mercado Libre según el estado del pedido.",
    variables: ["orderId"],
    requiresReview: false
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
      update: {
        category: template.category,
        keywords: template.keywords,
        content: template.content,
        variables: template.variables,
        requiresReview: template.requiresReview
      }
    });
    created.push(record);
  }
  return created;
}

function fillReplyTemplate(content: string, values: Record<string, unknown>) {
  return content.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => normalizeText(values[key]) || "-");
}

function replyTemplateKeywordScore(template: { keywords: string[] }, normalizedText: string) {
  return template.keywords.reduce((total, keyword) => {
    const normalizedKeyword = normalizeText(keyword).toLowerCase();
    return total + (normalizedKeyword && normalizedText.includes(normalizedKeyword) ? 1 : 0);
  }, 0);
}

async function findBestReplyTemplate(shopId: string, intentCode: string | null | undefined, text: string) {
  const templates = await prisma.replyTemplate.findMany({
    where: { shopId, active: true },
    orderBy: [{ intentCode: "asc" }, { updatedAt: "desc" }]
  });
  if (!templates.length) return null;

  const normalizedIntent = normalizeText(intentCode);
  const normalizedText = normalizeText(text).toLowerCase();
  const exactMatches = templates.filter((template) => template.intentCode === normalizedIntent);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    const scoredMatches = exactMatches
      .map((template) => ({ template, score: replyTemplateKeywordScore(template, normalizedText) }))
      .sort((a, b) => b.score - a.score || b.template.updatedAt.getTime() - a.template.updatedAt.getTime());
    if (scoredMatches[0]?.score > 0 && scoredMatches[0].score > (scoredMatches[1]?.score ?? -1)) {
      return scoredMatches[0].template;
    }
    return null;
  }

  const scored = templates
    .map((template) => ({
      template,
      score: replyTemplateKeywordScore(template, normalizedText)
    }))
    .sort((a, b) => b.score - a.score || b.template.updatedAt.getTime() - a.template.updatedAt.getTime());
  if (scored[0]?.score > 0 && scored[0].score > (scored[1]?.score ?? -1)) return scored[0].template;
  return templates.find((template) => template.intentCode === "other") || null;
}

async function assertNoActiveReplyTemplateConflict(input: {
  shopId: string;
  id?: string;
  intentCode: string;
  language: string;
  scenario: string | null;
  active: boolean;
}) {
  if (!input.active) return;
  const conflict = await prisma.replyTemplate.findFirst({
    where: {
      shopId: input.shopId,
      active: true,
      intentCode: input.intentCode,
      language: input.language,
      scenario: input.scenario,
      id: input.id ? { not: input.id } : undefined
    },
    select: { id: true, name: true, intentCode: true }
  });
  if (conflict) {
    throw new HttpError(409, `同一店铺、语言和问题类型只能启用一条预设回复。请先停用「${conflict.name}」或改用不同的问题类型。`);
  }
}

function categoryLabel(category: string | null | undefined) {
  const map: Record<string, string> = {
    human_request: "买家要求人工",
    invoice_request: "开票待人工",
    other: "未识别问题",
    claim_opened: "平台纠纷",
    not_received: "未收到货",
    shipping_not_received: "物流未收到",
    shipping_delay: "物流延迟",
    damaged_item: "商品损坏",
    damaged_product: "商品损坏",
    refund_request: "退款问题",
    return_request: "退换货",
    warranty: "保修咨询"
  };
  return map[normalizeText(category)] || normalizeText(category) || "未分类";
}

function statusLabel(status: string | null | undefined) {
  const map: Record<string, string> = {
    open: "待跟进",
    human_pending: "人工待处理",
    closed: "已关闭"
  };
  return map[normalizeText(status)] || normalizeText(status) || "未知状态";
}

function decideAftersaleHandoff(input: { category?: string | null; shouldEscalate?: boolean | null; status?: string | null }): HandoffDecision {
  const category = normalizeText(input.category);
  if (category === "human_request") return { required: true, reason: "buyer_requested_human", label: "买家要求人工" };
  if (category === "invoice_request") return { required: true, reason: "invoice_required", label: "开票待人工" };
  if (category === "other") return { required: true, reason: "unmatched_other", label: "未识别问题转人工" };
  if (input.status === "human_pending") return { required: true, reason: "ai_escalation", label: "人工待处理" };
  return { required: false };
}

function handoffLabel(reason: string | null | undefined) {
  const map: Record<string, string> = {
    buyer_requested_human: "买家要求人工",
    invoice_required: "开票待人工",
    unmatched_other: "未识别问题",
    ai_escalation: "风险规则转人工"
  };
  return map[normalizeText(reason)] || "无需人工";
}

function pickInvoiceValue(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = normalizeText(match?.[1])
      .replace(/\s+(RFC|raz[oó]n social|nombre fiscal|r[eé]gimen fiscal|regimen|uso de cfdi|cfdi|forma de pago|m[eé]todo de pago|metodo de pago|c[oó]digo postal fiscal|codigo postal fiscal|cp fiscal|c\.?p\.?)\b.*$/i, "")
      .replace(/[。.;；,，]+$/, "");
    if (value) return value.slice(0, 80);
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
    `Reason: ${input.handoff.label || handoffLabel(input.handoff.reason)}`,
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

function withAftersaleComputedFields<T extends { category?: string | null; status?: string | null; messages?: unknown[]; _count?: { messages?: number } }>(thread: T) {
  const handoff = decideAftersaleHandoff({ category: thread.category, status: thread.status });
  return {
    ...thread,
    messageCount: thread._count?.messages ?? thread.messages?.length ?? 0,
    handoffRequired: handoff.required,
    handoffReason: handoff.reason,
    handoffLabel: handoff.label
  };
}

function countBy<T>(items: T[], key: (item: T) => string | null | undefined) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = normalizeText(key(item)) || "unknown";
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function toChart(counts: Map<string, number>, labeler: (key: string) => string) {
  return [...counts.entries()]
    .map(([key, value]) => ({ key, value, label: labeler(key) }))
    .sort((a, b) => b.value - a.value);
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
  if (!aiGenerationEnabled()) return fallback;

  try {
    const raw = await callAiJson([
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

async function buildPresaleGenerationContext(shopId: string, question: {
  shopId: string;
  itemId: string;
  questionText?: string | null;
  rawItem?: Prisma.JsonValue | null;
}) {
  const sku = await findSkuKnowledgeForQuestion(question);
  const rawItem = (question.rawItem || {}) as Record<string, unknown>;
  const query = `${question.questionText || ""} ${rawItem.title || ""} ${sku?.sku || ""}`;
  const ragHits = await retrieveKnowledge(shopId, query, { sku: sku?.sku || normalizeText(rawItem.sku), limit: 6 });
  const input = {
    questionText: question.questionText || "",
    itemTitle: normalizeText(rawItem.title),
    sku: sku?.sku,
    knowledge: skuToKnowledge(sku),
    ragHits
  };
  return { sku, rawItem, ragHits, input };
}

async function savePresaleDraft(shopId: string, question: { id: string }, draft: PresaleReply, inputSnapshot: unknown) {
  const updated = await prisma.presaleQuestion.update({
    where: { id: question.id },
    data: { aiDraft: draft.answer_es_mx, aiConfidence: draft.confidence, riskLevel: draft.risk_level, reviewStatus: draft.needs_human_review ? "needs_human" : "draft_ready" }
  });
  await prisma.aiSuggestion.create({
    data: {
      shopId,
      targetType: "presale_question",
      targetId: question.id,
      model: selectedAiProvider() || "local_rules",
      promptVersion: aiPromptVersion("presale"),
      inputSnapshot: safeJson(inputSnapshot) as unknown as Prisma.InputJsonValue,
      outputJson: safeJson(draft) as unknown as Prisma.InputJsonValue,
      outputText: draft.answer_es_mx,
      riskFlags: draft.policy_flags
    }
  });
  return updated;
}

function buildStreamingPresaleDraft(answer: string, fallback: PresaleReply): PresaleReply {
  const text = normalizeText(answer) || fallback.answer_es_mx;
  const safety = assertSafePresaleAnswer(text);
  return PresaleReplySchema.parse({
    answer_es_mx: text.slice(0, 2000),
    confidence: safety.safe ? Math.max(fallback.confidence, 0.78) : 0.35,
    risk_level: safety.safe ? fallback.risk_level : "high",
    needs_human_review: fallback.needs_human_review || !safety.safe,
    missing_info: fallback.missing_info,
    policy_flags: [...new Set([...fallback.policy_flags, ...safety.flags])]
  });
}

async function generateAftersaleWithAi(input: {
  latestMessage: string;
  conversationHistory?: string[];
  orderStatus?: string;
  shipmentStatus?: string;
  hasClaim?: boolean;
  hasReturn?: boolean;
  sku?: string | null;
  knowledge?: SkuKnowledgeContext | null;
  ragHits: KnowledgeHit[];
}): Promise<AftersaleAnalysis> {
  const fallback = generateLocalAftersaleAnalysis(input);
  if (!aiGenerationEnabled()) return fallback;

  try {
    const raw = await callAiJson([
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

async function getFreshMeliAccessToken(shopId: string) {
  const current = await prisma.meliToken.findFirst({ where: { shopId }, orderBy: { createdAt: "desc" } });
  if (!current) throw new HttpError(409, "Mercado Libre shop is not authorized yet");
  if (current.expiresAt.getTime() > Date.now() + 60_000) return decryptSecret(current.accessTokenEnc);

  const refreshed = await refreshMeliToken(decryptSecret(current.refreshTokenEnc));
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
  await prisma.meliToken.update({ where: { id: current.id }, data: { refreshError: null } }).catch(() => undefined);
  await prisma.apiCallLog.create({ data: { shopId, method: "POST", path: "/oauth/token", statusCode: 200, latencyMs: 0 } }).catch(() => undefined);
  return decryptSecret(token.accessTokenEnc);
}

async function postMeliAnswer(shopId: string, questionId: bigint, text: string) {
  const accessToken = await getFreshMeliAccessToken(shopId);
  const path = "/marketplace/answers";
  const startedAt = Date.now();
  let statusCode: number | undefined;
  let errorText = "";

  try {
    const response = await fetch(`https://api.mercadolibre.com${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ question_id: questionId.toString(), text, text_translated: "" })
    });
    statusCode = response.status;
    const body = await response.text();
    if (!response.ok) {
      errorText = body.slice(0, 1000);
      throw new HttpError(502, `Mercado Libre answer failed: HTTP ${response.status} ${errorText}`);
    }
    return body ? JSON.parse(body) as unknown : {};
  } catch (error) {
    errorText = errorText || (error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    await prisma.apiCallLog.create({
      data: { shopId, method: "POST", path, statusCode, latencyMs: Date.now() - startedAt, error: errorText || undefined }
    }).catch(() => undefined);
  }
}

async function postMeliPackMessage(shopId: string, packId: bigint, text: string) {
  const accessToken = await getFreshMeliAccessToken(shopId);
  const path = `/marketplace/messages/packs/${packId.toString()}`;
  const startedAt = Date.now();
  let statusCode: number | undefined;
  let errorText = "";

  try {
    const response = await fetch(`https://api.mercadolibre.com${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text, text_translated: "" })
    });
    statusCode = response.status;
    const body = await response.text();
    if (!response.ok) {
      errorText = body.slice(0, 1000);
      throw new HttpError(502, `Mercado Libre post-sale message failed: HTTP ${response.status} ${errorText}`);
    }
    return body ? JSON.parse(body) as unknown : {};
  } catch (error) {
    errorText = errorText || (error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    await prisma.apiCallLog.create({
      data: { shopId, method: "POST", path, statusCode, latencyMs: Date.now() - startedAt, error: errorText || undefined }
    }).catch(() => undefined);
  }
}

app.get("/livez", (_req, res) => {
  sendJson(res, {
    success: true,
    status: "alive",
    service: "meli-ai-support-api",
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.get("/readyz", async (_req, res) => {
  const readiness = await buildReadiness();
  sendJson(res, { success: readiness.ready, status: readiness.ready ? "ready" : "not_ready", ...readiness }, readiness.ready ? 200 : 503);
});

app.get("/health", async (req, res) => {
  const shopId = normalizeText(req.query.shopId);
  const shopScoped = shopId ? { shopId } : {};
  const ai = getAiRuntimeConfig();
  const [readiness, shopCount, pendingWebhookCount, skuCount, chunkCount, presalePending, aftersaleOpen] = await Promise.all([
    buildReadiness().catch((error) => ({ ready: false, checks: { error: error instanceof Error ? error.message : String(error) } })),
    prisma.shop.count().catch(() => -1),
    prisma.webhookEvent.count({ where: { status: "pending" } }).catch(() => -1),
    prisma.skuKnowledge.count({ where: shopScoped }).catch(() => -1),
    prisma.kbChunk.count({ where: shopScoped }).catch(() => -1),
    prisma.presaleQuestion.count({ where: { ...shopScoped, reviewStatus: { in: ["pending", "draft_ready", "needs_human"] } } }).catch(() => -1),
    prisma.aftersaleThread.count({ where: { ...shopScoped, status: { in: ["open", "human_pending"] } } }).catch(() => -1)
  ]);

  sendJson(res, {
    success: true,
    status: readiness.ready ? "ok" : "degraded",
    service: "meli-ai-support-api",
    time: new Date().toISOString(),
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    shopScope: shopId || "all",
    shopCount,
    pendingWebhookCount,
    skuCount,
    chunkCount,
    presalePending,
    aftersaleOpen,
    readiness,
    ai: {
      provider: ai.provider,
      configured: ai.configured,
      kimiConfigured: kimiConfigured(),
      model: ai.model,
      baseUrl: ai.baseUrl,
      stream: ai.stream
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
    if (secret && req.headers["x-webhook-secret"] !== secret) {
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
      jobId: queueJobId(dedupeKey),
      attempts: 5,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: 1000,
      removeOnFail: false
    });

    const sellerIdForNotification = toBigIntOrNull(payload.user_id);
    if (sellerIdForNotification && (payload.topic === "questions" || payload.topic === "messages" || payload.topic === "claims")) {
      const shop = await prisma.shop.findUnique({ where: { sellerId: sellerIdForNotification } }).catch(() => null);
      if (shop) {
        const config = await getFeishuWebhookConfig(shop.id).catch(() => null);
        const isPresale = payload.topic === "questions";
        const shouldNotify = isPresale && config?.notifyPresale !== false;
        if (config?.enabled && shouldNotify) {
          void notifyFeishuSafely(shop.id, [
            "[Mercado Libre] New platform event",
            `Store: ${shop.nickname || shop.sellerId.toString()}`,
            `Topic: ${payload.topic}`,
            `Resource: ${payload.resource}`,
            "Status: queued for processing"
          ].join("\n"));
        }
      }
    }

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
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - 6);
    const [shop, presalePending, presaleReady, presaleNeedsHuman, aftersaleOpen, aftersaleHumanPending, aftersaleHigh, knowledgeFailed, todayReplied, aiCount, acceptedCount, templateCount, tokenCount, aftersaleThreads, recentActions] = await Promise.all([
      prisma.shop.findUnique({ where: { id: shopId } }),
      prisma.presaleQuestion.count({ where: { shopId, reviewStatus: "pending" } }),
      prisma.presaleQuestion.count({ where: { shopId, reviewStatus: "draft_ready" } }),
      prisma.presaleQuestion.count({ where: { shopId, reviewStatus: "needs_human" } }),
      prisma.aftersaleThread.count({ where: { shopId, status: "open" } }),
      prisma.aftersaleThread.count({ where: { shopId, status: "human_pending" } }),
      prisma.aftersaleThread.count({ where: { shopId, riskLevel: "high" } }),
      prisma.kbDocument.count({ where: { shopId, status: { in: ["failed", "partial_failed"] } } }),
      prisma.presaleQuestion.count({ where: { shopId, sentAt: { gte: today } } }),
      prisma.aiSuggestion.count({ where: { shopId } }),
      prisma.aiSuggestion.count({ where: { shopId, accepted: true } }),
      prisma.replyTemplate.count({ where: { shopId, active: true } }),
      prisma.meliToken.count({ where: { shopId } }),
      prisma.aftersaleThread.findMany({
        where: { shopId },
        select: { category: true, status: true, riskLevel: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 1000
      }),
      prisma.operationLog.findMany({
        where: {
          shopId,
          createdAt: { gte: weekStart },
          action: { in: ["presale.send.dry_run", "presale.send.real", "aftersale.send.dry_run", "aftersale.send.local_record", "aftersale.close"] }
        },
        select: { createdAt: true },
        take: 1000
      })
    ]);

    const pendingReviews = presaleReady;
    const adoptionRate = aiCount ? Math.round((acceptedCount / aiCount) * 100) : 0;
    const dailyProcessed = Array.from({ length: 7 }, (_unused, index) => {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + index);
      const key = date.toISOString().slice(0, 10);
      return {
        date: key,
        value: recentActions.filter((action) => action.createdAt.toISOString().slice(0, 10) === key).length
      };
    });
    const handoffCounts = new Map<string, number>();
    for (const thread of aftersaleThreads) {
      const handoff = decideAftersaleHandoff({ category: thread.category, status: thread.status });
      if (handoff.required && handoff.reason) handoffCounts.set(handoff.reason, (handoffCounts.get(handoff.reason) || 0) + 1);
    }
    return sendJson(res, {
      success: true,
      shop,
      metrics: {
        pendingConsultations: presalePending + presaleNeedsHuman,
        pendingReviews,
        aftersaleFollowups: aftersaleOpen + aftersaleHumanPending,
        knowledgeFailed,
        todayReplied,
        adoptionRate,
        templateCount,
        highRisk: aftersaleHigh,
        invoiceHandoff: handoffCounts.get("invoice_required") || 0,
        humanPending: aftersaleHumanPending
      },
      charts: {
        categoryBreakdown: toChart(countBy(aftersaleThreads, (thread) => thread.category), categoryLabel),
        statusBreakdown: toChart(countBy(aftersaleThreads, (thread) => thread.status), statusLabel),
        handoffBreakdown: toChart(handoffCounts, handoffLabel),
        dailyProcessed
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
    await notifyFeishuSafely(shop.id, [
      "[Demo] New support workspace data",
      `Store: ${shop.nickname || shop.sellerId.toString()}`,
      `Presale question: ${question.questionText || "-"}`,
      `Aftersale pack: ${thread.packId.toString()}`,
      "You can now test draft generation and review flows."
    ].join("\n"));
    return sendJson(res, { success: true, shop, sku, question, thread, templates });
  } catch (error) {
    return next(error);
  }
});

function nextDemoBigInt(offset = 0) {
  return BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 900) + offset);
}

async function createDemoPresaleQuestion(shopId: string, input: {
  sku: string;
  itemId: string;
  itemTitle: string;
  questionText: string;
  buyerId?: bigint;
}) {
  const questionId = nextDemoBigInt(100);
  return prisma.presaleQuestion.create({
    data: {
      shopId,
      questionId,
      itemId: input.itemId,
      buyerId: input.buyerId || nextDemoBigInt(200),
      questionText: input.questionText,
      questionStatus: "UNANSWERED",
      reviewStatus: "pending",
      riskLevel: "low",
      rawQuestion: safeJson({
        id: questionId.toString(),
        text: input.questionText,
        status: "UNANSWERED",
        source: "demo_qa"
      }) as Prisma.InputJsonValue,
      rawItem: safeJson({
        id: input.itemId,
        sku: input.sku,
        title: input.itemTitle,
        source: "demo_qa"
      }) as Prisma.InputJsonValue
    }
  });
}

async function createDemoAftersaleThread(shopId: string, input: {
  sku: string;
  orderStatus: string;
  shipmentStatus: string;
  latestMessage: string;
  orderId?: bigint;
  packId?: bigint;
  buyerId?: bigint;
}) {
  const packId = input.packId || nextDemoBigInt(300);
  const orderId = input.orderId || nextDemoBigInt(400);
  const messageId = `demo-qa-message-${packId.toString()}-${Date.now()}`;
  const thread = await prisma.aftersaleThread.create({
    data: {
      shopId,
      packId,
      orderId,
      buyerId: input.buyerId || nextDemoBigInt(500),
      status: "open",
      riskLevel: "medium",
      lastMessageAt: new Date(),
      rawContext: safeJson({
        sku: input.sku,
        orderStatus: input.orderStatus,
        shipmentStatus: input.shipmentStatus,
        latestMessage: input.latestMessage,
        source: "demo_qa"
      }) as Prisma.InputJsonValue
    }
  });

  await prisma.message.create({
    data: {
      shopId,
      threadId: thread.id,
      meliMessageId: messageId,
      packId,
      direction: "inbound",
      text: input.latestMessage,
      rawMessage: safeJson({ source: "demo_qa", sku: input.sku }) as Prisma.InputJsonValue,
      messageDate: new Date()
    }
  });

  return prisma.aftersaleThread.findUnique({
    where: { id: thread.id },
    include: { messages: { orderBy: { messageDate: "asc" }, take: 10 } }
  });
}

app.post("/demo/qa/seed", async (req, res, next) => {
  try {
    const actor = await getActor(req);
    const shop = await getOrCreateDemoShop(actor.id);
    const skus = [];

    for (const item of [
      {
        sku: "QA-KB-USB-C-65W",
        itemId: "MLM-QA-USB-C-65W",
        title: "Cargador USB-C 65W con cable tipo C",
        brand: "QA Brand",
        category: "Cargadores",
        sellingPoints: "Carga rápida de 65W para laptops compatibles, celulares y tablets USB-C.",
        faq: "Compatible con equipos USB-C Power Delivery. No incluye adaptador para iPhone Lightning.",
        warrantyPolicy: "Garantía de 30 días por defectos de fabricación.",
        invoicePolicy: "Sí facturamos después de la compra con RFC, razón social, uso de CFDI y forma de pago por chat de Mercado Libre.",
        shippingNotes: "El envío y la fecha estimada dependen de Mercado Libre.",
        returnPolicy: "Para cambios o devoluciones se debe seguir el flujo oficial de Mercado Libre."
      },
      {
        sku: "QA-KB-HEADSET-RGB",
        itemId: "MLM-QA-HEADSET-RGB",
        title: "Audífonos gamer RGB con micrófono",
        brand: "QA Brand",
        category: "Audio",
        sellingPoints: "Audífonos alámbricos con micrófono ajustable, luz RGB y conexión USB.",
        faq: "Funciona en PC y laptop con puerto USB. No es Bluetooth.",
        warrantyPolicy: "Garantía por defectos de fabricación, no cubre daño por líquido o mal uso.",
        invoicePolicy: "La factura se solicita después de la compra dentro del chat de Mercado Libre.",
        shippingNotes: "Mercado Libre gestiona la entrega.",
        returnPolicy: "Si llega dañado, pedir evidencia y continuar por el flujo oficial."
      }
    ]) {
      skus.push(await upsertSkuKnowledge(shop.id, item));
    }

    const docs = [];
    for (const doc of [
      {
        title: "QA política de factura para preventa",
        docType: "invoice",
        sku: "QA-KB-USB-C-65W",
        content: "Para el cargador QA-KB-USB-C-65W sí se puede emitir factura. El comprador debe compartir RFC, razón social, régimen fiscal, uso de CFDI y forma de pago después de comprar. No pedir datos fuera de Mercado Libre."
      },
      {
        title: "QA compatibilidad audífonos gamer",
        docType: "faq",
        sku: "QA-KB-HEADSET-RGB",
        content: "Los audífonos QA-KB-HEADSET-RGB son alámbricos USB. Funcionan en PC y laptop con puerto USB. No son Bluetooth y no se recomienda prometer compatibilidad con consolas sin validar el modelo."
      }
    ]) {
      const plan = await agenticChunkDocument(doc);
      const created = await prisma.$transaction(async (tx) => {
        const document = await tx.kbDocument.create({ data: { shopId: shop.id, title: doc.title, docType: doc.docType, content: doc.content, locale: "es-MX", status: "indexed" } });
        await tx.kbChunk.createMany({
          data: plan.chunks.map((chunk) => ({
            documentId: document.id,
            shopId: shop.id,
            content: chunk.content,
            metadata: safeJson({ title: chunk.title, doc_type: chunk.doc_type, sku_tags: chunk.sku_tags, intent_tags: chunk.intent_tags, risk_tags: chunk.risk_tags, source_title: doc.title }) as Prisma.InputJsonValue,
            scoreHint: chunk.priority
          }))
        });
        return document;
      });
      docs.push(created);
    }

    const presale = await createDemoPresaleQuestion(shop.id, {
      sku: "QA-KB-USB-C-65W",
      itemId: "MLM-QA-USB-C-65W",
      itemTitle: "Cargador USB-C 65W con cable tipo C",
      questionText: "Hola, ¿sirve para laptop con USB-C y me pueden facturar?"
    });
    const aftersale = await createDemoAftersaleThread(shop.id, {
      sku: "QA-KB-HEADSET-RGB",
      orderStatus: "paid",
      shipmentStatus: "delivered",
      latestMessage: "Hola, mis audífonos llegaron pero el micrófono no funciona. ¿Me pueden ayudar?",
      orderId: BigInt(Date.now() + 7000),
      packId: BigInt(Date.now() + 8000)
    });
    if (!aftersale) throw new HttpError(500, "Failed to create aftersale thread");

    await ensureDefaultReplyTemplates(shop.id);
    await createOperationLog(req, { shopId: shop.id, action: "demo.qa.seed", targetType: "shop", targetId: shop.id, detail: { skus: skus.length, docs: docs.length, presale: presale.id, aftersale: aftersale.id } });
    return sendJson(res, { success: true, shop, skus, docs, presale, aftersale });
  } catch (error) {
    return next(error);
  }
});

app.post("/demo/qa/presale", async (req, res, next) => {
  try {
    const actor = await getActor(req);
    const shopId = String(req.body?.shopId || "");
    const shop = shopId
      ? await prisma.shop.findFirst({ where: { id: shopId } })
      : await getOrCreateDemoShop(actor.id);
    if (!shop) throw new HttpError(404, "Shop not found");
    const question = await createDemoPresaleQuestion(shop.id, {
      sku: String(req.body?.sku || "QA-KB-USB-C-65W"),
      itemId: String(req.body?.itemId || "MLM-QA-USB-C-65W"),
      itemTitle: String(req.body?.itemTitle || "Cargador USB-C 65W con cable tipo C"),
      questionText: String(req.body?.questionText || "Hola, sirve para laptop con USB-C y me pueden facturar?")
    });
    await createOperationLog(req, { shopId: shop.id, action: "demo.qa.presale", targetType: "presale_question", targetId: question.id, detail: { source: "frontend_qa" } });
    return sendJson(res, { success: true, shop, question });
  } catch (error) {
    return next(error);
  }
});

app.post("/demo/qa/aftersale", async (req, res, next) => {
  try {
    const actor = await getActor(req);
    const shopId = String(req.body?.shopId || "");
    const shop = shopId
      ? await prisma.shop.findFirst({ where: { id: shopId } })
      : await getOrCreateDemoShop(actor.id);
    if (!shop) throw new HttpError(404, "Shop not found");
    const thread = await createDemoAftersaleThread(shop.id, {
      sku: String(req.body?.sku || "QA-KB-HEADSET-RGB"),
      orderStatus: String(req.body?.orderStatus || "paid"),
      shipmentStatus: String(req.body?.shipmentStatus || "delivered"),
      latestMessage: String(req.body?.latestMessage || "Hola, mis audifonos llegaron pero el microfono no funciona. Me pueden ayudar?")
    });
    if (!thread) throw new HttpError(500, "Failed to create aftersale thread");
    await createOperationLog(req, { shopId: shop.id, action: "demo.qa.aftersale", targetType: "aftersale_thread", targetId: thread.id, detail: { source: "frontend_qa" } });
    return sendJson(res, { success: true, shop, thread });
  } catch (error) {
    return next(error);
  }
});

app.get("/settings/ai", (_req, res) => {
  const ai = getAiRuntimeConfig();
  sendJson(res, {
    success: true,
    provider: ai.provider,
    configured: ai.configured,
    kimiConfigured: kimiConfigured(),
    model: ai.model,
    baseUrl: ai.baseUrl,
    stream: ai.stream,
    note: "Model API keys are read only from backend environment variables and are never exposed to the browser."
  });
});

app.post("/ai/test", async (_req, res, next) => {
  try {
    const result = await callAiJson([
      { role: "system", content: "You are a JSON-only health checker." },
      { role: "user", content: "Return {\"ok\":true,\"message\":\"model connected\"}." }
    ], { ok: false, message: "model not configured" });
    return sendJson(res, { success: true, result });
  } catch (error) {
    return next(error);
  }
});

app.get("/settings/feishu-webhook", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req);
    const raw = await getSetting<FeishuWebhookConfig>(shopId, "feishu_webhook");
    const webhookUrl = tryDecryptSecret(raw?.webhookUrlEnc);
    return sendJson(res, {
      success: true,
      configured: Boolean(raw?.webhookUrlEnc),
      webhookUrlMasked: maskUrl(webhookUrl),
      decryptable: !raw?.webhookUrlEnc || Boolean(webhookUrl),
      secretConfigured: Boolean(raw?.secretEnc),
      enabled: raw?.enabled !== false && Boolean(webhookUrl),
      notifyPresale: raw?.notifyPresale !== false,
      notifyAftersale: raw?.notifyAftersale !== false
    });
  } catch (error) {
    return next(error);
  }
});

app.delete("/settings/feishu-webhook", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId || req.query.shopId);
    await prisma.settingsRule.deleteMany({ where: { shopId, key: "feishu_webhook" } });
    await createOperationLog(req, { shopId, action: "settings.feishu_webhook.delete", targetType: "settings_rule" });
    return sendJson(res, {
      success: true,
      configured: false,
      webhookUrlMasked: "",
      decryptable: true,
      secretConfigured: false,
      enabled: false,
      notifyPresale: true,
      notifyAftersale: true
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/settings/feishu-webhook", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const webhookUrl = normalizeText(req.body?.webhookUrl);
    const secret = normalizeText(req.body?.secret);
    const current = await getSetting<FeishuWebhookConfig>(shopId, "feishu_webhook");
    if (!webhookUrl && !current?.webhookUrlEnc) throw new HttpError(400, "webhookUrl is required");

    const value: FeishuWebhookConfig = {
      webhookUrlEnc: webhookUrl ? encryptSecret(webhookUrl) : current?.webhookUrlEnc,
      secretEnc: secret ? encryptSecret(secret) : current?.secretEnc,
      enabled: req.body?.enabled === undefined ? true : Boolean(req.body.enabled),
      notifyPresale: req.body?.notifyPresale === undefined ? true : Boolean(req.body.notifyPresale),
      notifyAftersale: req.body?.notifyAftersale === undefined ? true : Boolean(req.body.notifyAftersale)
    };
    await upsertSetting(shopId, "feishu_webhook", value as Prisma.InputJsonValue);
    await createOperationLog(req, { shopId, action: "settings.feishu_webhook.save", targetType: "settings_rule", detail: { configured: true, enabled: value.enabled } });
    return sendJson(res, {
      success: true,
      configured: true,
      webhookUrlMasked: maskUrl(webhookUrl || tryDecryptSecret(current?.webhookUrlEnc)),
      decryptable: true,
      secretConfigured: Boolean(value.secretEnc),
      enabled: value.enabled,
      notifyPresale: value.notifyPresale,
      notifyAftersale: value.notifyAftersale
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/settings/feishu-webhook/test", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    const result = await sendFeishuWebhook(shopId, [
      "[Meli AI Support] Test notification",
      `Store: ${shop?.nickname || shop?.sellerId?.toString() || shopId}`,
      "Status: Feishu webhook is connected."
    ].join("\n"));
    await createOperationLog(req, { shopId, action: "settings.feishu_webhook.test", targetType: "settings_rule", detail: result });
    return sendJson(res, { success: true, result });
  } catch (error) {
    return next(error);
  }
});

app.get("/settings/automation", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req);
    const policy = await getSetting<AutomationPolicy>(shopId, "automation_policy");
    return sendJson(res, {
      success: true,
      policy: {
        autoReplyMode: policy?.autoReplyMode || "low_risk_templates_only",
        bulkApproveLowRisk: policy?.bulkApproveLowRisk !== false,
        requireHumanForHighRisk: Boolean(policy?.requireHumanForHighRisk)
      }
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/settings/automation", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const mode = normalizeText(req.body?.autoReplyMode) as AutomationPolicy["autoReplyMode"];
    const allowed = new Set(["off", "low_risk_templates_only", "all_templates"]);
    const policy: AutomationPolicy = {
      autoReplyMode: allowed.has(mode || "") ? mode : "low_risk_templates_only",
      bulkApproveLowRisk: req.body?.bulkApproveLowRisk === undefined ? true : Boolean(req.body.bulkApproveLowRisk),
      requireHumanForHighRisk: req.body?.requireHumanForHighRisk === undefined ? false : Boolean(req.body.requireHumanForHighRisk)
    };
    await upsertSetting(shopId, "automation_policy", policy as Prisma.InputJsonValue);
    await createOperationLog(req, { shopId, action: "settings.automation.save", targetType: "settings_rule", detail: policy });
    return sendJson(res, { success: true, policy });
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
    const language = normalizeText(req.body?.language) || "es-MX";
    const scenario = normalizeText(req.body?.scenario) || "售后处理";
    const active = req.body?.active === undefined ? true : Boolean(req.body.active);

    const latest = await prisma.replyTemplate.findFirst({
      where: { shopId, name },
      orderBy: { version: "desc" }
    });
    const version = latest ? latest.version + 1 : 1;
    await assertNoActiveReplyTemplateConflict({ shopId, intentCode, language, scenario, active });
    const template = await prisma.replyTemplate.create({
      data: {
        shopId,
        name,
        intentCode,
        category,
        language,
        scenario,
        keywords: Array.isArray(req.body?.keywords) ? req.body.keywords.map((item: unknown) => normalizeText(item)).filter(Boolean) : [],
        content,
        variables: Array.isArray(req.body?.variables) ? req.body.variables.map((item: unknown) => normalizeText(item)).filter(Boolean) : [],
        requiresReview: req.body?.requiresReview === undefined ? true : Boolean(req.body.requiresReview),
        active,
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
    const active = req.body?.active === undefined ? !existing.active : Boolean(req.body.active);
    await assertNoActiveReplyTemplateConflict({
      shopId,
      id: existing.id,
      intentCode: existing.intentCode,
      language: existing.language,
      scenario: existing.scenario,
      active
    });
    const template = await prisma.replyTemplate.update({
      where: { id: existing.id },
      data: { active }
    });
    await createOperationLog(req, { shopId, action: "reply_template.toggle", targetType: "reply_template", targetId: template.id, detail: { active: template.active } });
    return sendJson(res, { success: true, template });
  } catch (error) {
    return next(error);
  }
});

app.patch("/reply-templates/:id", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const template = await prisma.replyTemplate.findFirst({ where: { id: String(req.params.id), shopId } });
    if (!template) throw new HttpError(404, "reply template not found");
    const content = String(req.body?.content ?? template.content);
    const intentCode = normalizeText(req.body?.intentCode) || template.intentCode;
    const language = normalizeText(req.body?.language) || template.language;
    const scenario = req.body?.scenario === undefined ? template.scenario : normalizeText(req.body?.scenario);
    const active = req.body?.active === undefined ? template.active : Boolean(req.body.active);
    await assertNoActiveReplyTemplateConflict({ shopId, id: template.id, intentCode, language, scenario, active });
    const updated = await prisma.replyTemplate.update({
      where: { id: template.id },
      data: {
        name: normalizeText(req.body?.name) || template.name,
        intentCode,
        category: normalizeText(req.body?.category) || intentCode || template.category,
        language,
        scenario,
        keywords: Array.isArray(req.body?.keywords) ? req.body.keywords.map((keyword: unknown) => normalizeText(keyword)).filter(Boolean) : template.keywords,
        content,
        variables: Array.isArray(req.body?.variables) ? req.body.variables.map((item: unknown) => normalizeText(item)).filter(Boolean) : template.variables,
        active,
        version: content !== template.content ? template.version + 1 : template.version
      }
    });
    if (content !== template.content) {
      await prisma.replyTemplateVersion.create({ data: { templateId: template.id, version: updated.version, content, changedBy: (await getActor(req)).id, note: normalizeText(req.body?.note) || "frontend edit" } });
    }
    await createOperationLog(req, { shopId, action: "reply_template.update", targetType: "reply_template", targetId: template.id });
    return sendJson(res, { success: true, template: updated });
  } catch (error) {
    return next(error);
  }
});

app.delete("/reply-templates/:id", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId || req.query.shopId);
    const template = await prisma.replyTemplate.findFirst({ where: { id: String(req.params.id), shopId } });
    if (!template) throw new HttpError(404, "reply template not found");
    await prisma.replyTemplate.delete({ where: { id: template.id } });
    await createOperationLog(req, { shopId, action: "reply_template.delete", targetType: "reply_template", targetId: template.id, detail: { name: template.name } });
    return sendJson(res, { success: true, deletedId: template.id });
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
    const parsedRows = parseSkuImportRows(req.body);
    const rowMap = new Map<string, Record<string, unknown>>();
    for (const row of parsedRows) {
      const sku = mapSkuInput(row as Record<string, unknown>).sku;
      if (sku) rowMap.set(sku, row as Record<string, unknown>);
    }
    const rows = [...rowMap.values()];
    if (!rows.length) throw new HttpError(400, "No SKU rows found");

    await ensureVectorSchema();
    const results = await prisma.$transaction(async (tx) => {
      const imported = [];
      const chunkInputs: Array<{
        documentId: string;
        shopId: string;
        content: string;
        metadata: Prisma.InputJsonValue;
        scoreHint?: number;
      }> = [];

      for (const row of rows) {
        const sku = await upsertSkuKnowledge(shopId, row as Record<string, unknown>, tx);
        const title = `SKU ${sku.sku}`;
        const content = skuKnowledgeContent(sku);
        const plan = fallbackChunkPlan(title, "product", content, sku.sku);
        const existing = await tx.kbDocument.findMany({ where: { shopId, docType: "product", title } });
        if (existing.length) await tx.kbDocument.deleteMany({ where: { id: { in: existing.map((document) => document.id) } } });
        const document = await tx.kbDocument.create({
          data: {
            shopId,
            title,
            docType: "product",
            content,
            locale: sku.locale || "es-MX",
            status: "indexed"
          }
        });
        for (const chunk of plan.chunks) {
          chunkInputs.push({
            documentId: document.id,
            shopId,
            content: chunk.content,
            metadata: safeJson({
              title: chunk.title,
              doc_type: chunk.doc_type,
              sku_tags: [sku.sku],
              intent_tags: ["presale", "product"],
              risk_tags: chunk.risk_tags,
              source_title: title,
              source: "sku_import",
              skuKnowledgeId: sku.id,
              category: sku.category
            }) as Prisma.InputJsonValue,
            scoreHint: chunk.priority
          });
        }
        imported.push(sku);
      }

      await createChunksWithEmbeddings(tx, chunkInputs);
      return imported;
    }, { timeout: 120_000 });

    await createOperationLog(req, { shopId, action: "kb.sku.import", targetType: "sku_knowledge", detail: { count: results.length, indexed: true, ip: getClientIp(req) } });
    return sendJson(res, { success: true, count: results.length, indexed: results.length, skus: results });
  } catch (error) {
    return next(error);
  }
});

app.delete("/kb/skus/:id", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId || req.query.shopId);
    const existing = await prisma.skuKnowledge.findFirst({ where: { id: String(req.params.id), shopId } });
    if (!existing) throw new HttpError(404, "SKU knowledge not found");
    await prisma.skuKnowledge.delete({ where: { id: existing.id } });
    await createOperationLog(req, { shopId, action: "kb.sku.delete", targetType: "sku_knowledge", targetId: existing.id, detail: { sku: existing.sku, title: existing.title } });
    return sendJson(res, { success: true, deletedId: existing.id });
  } catch (error) {
    return next(error);
  }
});

app.post("/kb/documents/import", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const parsedFile = await parseKnowledgeDocumentFile(req.body);
    const title = normalizeText(req.body?.title) || parsedFile?.title || "";
    const docType = normalizeText(req.body?.docType) || "faq";
    const content = (parsedFile?.content || String(req.body?.content || "")).trim();
    const sku = normalizeText(req.body?.sku);
    const locale = normalizeText(req.body?.locale) || "es-MX";
    if (!title) throw new HttpError(400, "请填写资料名称，或上传带文件名的资料文件");
    if (!content) throw new HttpError(400, "请填写资料内容，或上传 TXT/PDF/DOCX 文件");

    const plan = await agenticChunkDocument({ title, docType, content, sku });
    await ensureVectorSchema();
    const result = await prisma.$transaction(async (tx) => {
      const document = await tx.kbDocument.create({ data: { shopId, title, docType, content, locale, status: "indexed" } });
      await createChunksWithEmbeddings(tx, plan.chunks.map((chunk) => ({
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
        })));
      return { document, chunks: plan.chunks };
    }, { timeout: 120_000 });

    const parsedFileSummary = parsedFile
      ? { fileName: parsedFile.fileName, type: parsedFile.type, characters: parsedFile.characters }
      : undefined;
    await createOperationLog(req, {
      shopId,
      action: "kb.document.import",
      targetType: "kb_document",
      targetId: result.document.id,
      detail: { chunks: result.chunks.length, ai: aiConfigured(), provider: selectedAiProvider(), parsedFile: parsedFileSummary }
    });
    return sendJson(res, { success: true, ...result, parsedFile: parsedFileSummary });
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

app.delete("/kb/documents/:id", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId || req.query.shopId);
    const existing = await prisma.kbDocument.findFirst({ where: { id: String(req.params.id), shopId } });
    if (!existing) throw new HttpError(404, "knowledge document not found");
    await prisma.kbDocument.delete({ where: { id: existing.id } });
    await createOperationLog(req, { shopId, action: "kb.document.delete", targetType: "kb_document", targetId: existing.id, detail: { title: existing.title, docType: existing.docType } });
    return sendJson(res, { success: true, deletedId: existing.id });
  } catch (error) {
    return next(error);
  }
});

app.patch("/kb/documents/:id", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const existing = await prisma.kbDocument.findFirst({ where: { id: String(req.params.id), shopId } });
    if (!existing) throw new HttpError(404, "knowledge document not found");
    const title = normalizeText(req.body?.title) || existing.title;
    const docType = normalizeText(req.body?.docType) || existing.docType;
    const content = String(req.body?.content ?? existing.content).trim();
    if (!title || !content) throw new HttpError(400, "title and content are required");
    const sku = normalizeText(req.body?.sku);
    const plan = await agenticChunkDocument({ title, docType, content, sku });
    await ensureVectorSchema();
    const result = await prisma.$transaction(async (tx) => {
      const document = await tx.kbDocument.update({ where: { id: existing.id }, data: { title, docType, content, locale: normalizeText(req.body?.locale) || existing.locale, status: "indexed", active: req.body?.active === undefined ? existing.active : Boolean(req.body.active) } });
      await tx.kbChunk.deleteMany({ where: { documentId: existing.id } });
      await createChunksWithEmbeddings(tx, plan.chunks.map((chunk) => ({
          documentId: existing.id,
          shopId,
          content: chunk.content,
          metadata: safeJson({ title: chunk.title, doc_type: chunk.doc_type, sku_tags: chunk.sku_tags, intent_tags: chunk.intent_tags, risk_tags: chunk.risk_tags, source_title: title }) as Prisma.InputJsonValue,
          scoreHint: chunk.priority
        })));
      return document;
    }, { timeout: 120_000 });
    await createOperationLog(req, { shopId, action: "kb.document.update", targetType: "kb_document", targetId: existing.id, detail: { chunks: plan.chunks.length } });
    return sendJson(res, { success: true, document: result, chunks: plan.chunks });
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
    const context = await buildPresaleGenerationContext(shopId, question);
    const draft = await generatePresaleWithAi(context.input);
    const updated = await savePresaleDraft(shopId, question, draft, { question, sku: context.sku, ragHits: context.ragHits });

    return sendJson(res, { success: true, question: updated, draft, ragHits: context.ragHits });
  } catch (error) {
    return next(error);
  }
});

function writeSse(res: express.Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(safeJson(data))}\n\n`);
}

app.post("/presale/questions/:id/generate/stream", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const question = await prisma.presaleQuestion.findFirst({ where: { id: String(req.params.id), shopId } });
    if (!question) throw new HttpError(404, "question not found");

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    writeSse(res, "status", { message: "正在检索售前知识库..." });
    const context = await buildPresaleGenerationContext(shopId, question);
    writeSse(res, "references", { ragHits: context.ragHits });

    const fallback = generateLocalPresaleDraft(context.input);
    let answer = "";
    if (aiGenerationEnabled()) {
      try {
        let aiStarted = false;
        writeSse(res, "status", { message: "AI 正在生成回复..." });
        answer = await streamAiText([
          { role: "system", content: streamPresaleSystemPrompt() },
          { role: "user", content: JSON.stringify(context.input) }
        ], (chunk) => {
          if (!aiStarted) {
            writeSse(res, "replace", { text: "" });
            aiStarted = true;
          }
          writeSse(res, "chunk", { text: chunk });
        });
      } catch (error) {
        console.warn("[ai] streaming presale generation failed", error instanceof Error ? error.message : String(error));
      }
    }

    if (!answer.trim()) {
      writeSse(res, "error", { message: aiGenerationEnabled() ? "AI 暂未返回内容，请稍后重试。" : "AI 未配置，无法生成售前回复。" });
      res.end();
      return;
    }

    const draft = buildStreamingPresaleDraft(answer, fallback);
    const updated = await savePresaleDraft(shopId, question, draft, { question, sku: context.sku, ragHits: context.ragHits, streamed: true });
    writeSse(res, "done", { success: true, question: updated, draft, ragHits: context.ragHits });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      writeSse(res, "error", { message: error instanceof Error ? error.message : String(error) });
      res.end();
      return;
    }
    return next(error);
  }
});

app.post("/presale/questions/:id/approve", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const existing = await prisma.presaleQuestion.findFirst({ where: { id: String(req.params.id), shopId } });
    if (!existing) throw new HttpError(404, "question not found");
    const answer = String(req.body?.answerText || req.body?.finalAnswer || existing.aiDraft || "").trim();
    const safety = assertSafePresaleAnswer(answer);
    if (!safety.safe) throw new HttpError(400, `Unsafe answer: ${safety.flags.join(", ")}`);
    const question = await prisma.presaleQuestion.update({
      where: { id: existing.id },
      data: { finalAnswer: answer, reviewStatus: "approved" }
    });
    await prisma.aiSuggestion.updateMany({
      where: { shopId, targetType: "presale_question", targetId: question.id },
      data: { accepted: true, editedText: answer }
    });
    await createOperationLog(req, { shopId, action: "presale.approve", targetType: "presale_question", targetId: question.id });
    return sendJson(res, { success: true, question });
  } catch (error) {
    return next(error);
  }
});

app.delete("/presale/questions/:id", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId || req.query.shopId);
    const question = await prisma.presaleQuestion.findFirst({ where: { id: String(req.params.id), shopId } });
    if (!question) throw new HttpError(404, "question not found");
    await prisma.$transaction([
      prisma.aiSuggestion.deleteMany({ where: { shopId, targetType: "presale_question", targetId: question.id } }),
      prisma.presaleQuestion.delete({ where: { id: question.id } })
    ]);
    await createOperationLog(req, { shopId, action: "presale.delete", targetType: "presale_question", targetId: question.id });
    return sendJson(res, { success: true, deletedId: question.id });
  } catch (error) {
    return next(error);
  }
});

app.post("/presale/questions/bulk-approve", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((id: unknown) => normalizeText(id)).filter(Boolean) : [];
    const limit = Math.min(Number(req.body?.limit || 50), 200);
    const candidates = await prisma.presaleQuestion.findMany({
      where: {
        shopId,
        ...(ids.length ? { id: { in: ids } } : { reviewStatus: "draft_ready", OR: [{ riskLevel: "low" }, { riskLevel: null }] }),
        aiDraft: { not: null }
      },
      orderBy: { updatedAt: "asc" },
      take: limit
    });

    const approved: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const question of candidates) {
      const answer = String(question.aiDraft || "").trim();
      const safety = assertSafePresaleAnswer(answer);
      if (!answer) {
        skipped.push({ id: question.id, reason: "empty_draft" });
        continue;
      }
      if (question.riskLevel && question.riskLevel !== "low") {
        skipped.push({ id: question.id, reason: "not_low_risk" });
        continue;
      }
      if (!safety.safe) {
        skipped.push({ id: question.id, reason: `unsafe:${safety.flags.join(",")}` });
        continue;
      }
      await prisma.presaleQuestion.update({
        where: { id: question.id },
        data: { finalAnswer: answer, reviewStatus: "approved" }
      });
      await prisma.aiSuggestion.updateMany({
        where: { shopId, targetType: "presale_question", targetId: question.id },
        data: { accepted: true, editedText: answer }
      });
      approved.push(question.id);
    }

    await createOperationLog(req, { shopId, action: "presale.bulk_approve", targetType: "presale_question", detail: { approved: approved.length, skipped: skipped.length } });
    return sendJson(res, { success: true, approvedCount: approved.length, skippedCount: skipped.length, approved, skipped });
  } catch (error) {
    return next(error);
  }
});

app.post("/presale/questions/:id/send", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const wantsRealSend = req.body?.dryRun === false;
    if (wantsRealSend && process.env.AUTO_SEND_PRESALE !== "true") {
      throw new HttpError(409, "Real Mercado Libre send is disabled. Set AUTO_SEND_PRESALE=true after OAuth and audit checks are ready.");
    }
    const dryRun = !wantsRealSend;
    const question = await prisma.presaleQuestion.findFirst({ where: { id: String(req.params.id), shopId } });
    if (!question) throw new HttpError(404, "question not found");
    const answer = String(req.body?.answerText || question.finalAnswer || question.aiDraft || "").trim();
    if (!answer) throw new HttpError(400, "answerText is required");
    const safety = assertSafePresaleAnswer(answer);
    if (!safety.safe) throw new HttpError(400, `Unsafe answer: ${safety.flags.join(", ")}`);

    if (dryRun) {
      const updated = await prisma.presaleQuestion.update({
        where: { id: question.id },
        data: { finalAnswer: answer, reviewStatus: "dry_run_sent", sentAt: new Date() }
      });
      await createOperationLog(req, { shopId, action: "presale.send.dry_run", targetType: "presale_question", targetId: question.id });
      return sendJson(res, { success: true, dryRun: true, question: updated });
    }

    const meliResult = await postMeliAnswer(shopId, question.questionId, answer);
    const updated = await prisma.presaleQuestion.update({
      where: { id: question.id },
      data: { finalAnswer: answer, reviewStatus: "sent", questionStatus: "ANSWERED", sentAt: new Date() }
    });
    await prisma.aiSuggestion.updateMany({
      where: { shopId, targetType: "presale_question", targetId: question.id },
      data: { accepted: true, editedText: answer }
    });
    await createOperationLog(req, { shopId, action: "presale.send.real", targetType: "presale_question", targetId: question.id, detail: { questionId: question.questionId.toString() } });
    return sendJson(res, { success: true, dryRun: false, question: updated, meliResult });
  } catch (error) {
    return next(error);
  }
});

app.get("/aftersale/threads", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req);
    const threads = await prisma.aftersaleThread.findMany({
      where: { shopId },
      include: {
        messages: { orderBy: { messageDate: "asc" }, take: 30 },
        _count: { select: { messages: true } }
      },
      orderBy: { updatedAt: "desc" },
      take: 100
    });
    return sendJson(res, { success: true, threads: threads.map(withAftersaleComputedFields) });
  } catch (error) {
    return next(error);
  }
});

app.post("/aftersale/threads/:id/analyze", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const thread = await prisma.aftersaleThread.findFirst({
      where: { id: String(req.params.id), shopId },
      include: {
        messages: { orderBy: { messageDate: "desc" }, take: 20 },
        _count: { select: { messages: true } }
      }
    });
    if (!thread) throw new HttpError(404, "thread not found");

    const rawContext = (thread.rawContext || {}) as Record<string, unknown>;
    const sku = normalizeText(rawContext.sku);
    const latestMessage = normalizeText(req.body?.latestMessage) || thread.messages[0]?.text || normalizeText(rawContext.latestMessage);
    const conversationHistory = thread.messages.slice().reverse().map((message) => normalizeText(message.text)).filter(Boolean);
    const analysis = await generateAftersaleWithAi({
      latestMessage,
      conversationHistory,
      orderStatus: normalizeText(rawContext.orderStatus),
      shipmentStatus: normalizeText(rawContext.shipmentStatus),
      hasClaim: Boolean(thread.claimId || rawContext.claimId),
      hasReturn: Boolean(thread.returnId || rawContext.returnId),
      sku,
      knowledge: null,
      ragHits: []
    });
    await ensureDefaultReplyTemplates(shopId);
    const matchedTemplate = await findBestReplyTemplate(shopId, analysis.category, latestMessage);
    const suggestedReply = matchedTemplate
      ? fillReplyTemplate(matchedTemplate.content, {
        orderId: thread.orderId?.toString(),
        packId: thread.packId.toString(),
        sku: sku || rawContext.sku,
        itemTitle: rawContext.title || rawContext.itemTitle,
        trackingStatus: rawContext.shipmentStatus,
        estimatedDeliveryDate: rawContext.estimatedDeliveryDate
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
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    const feishuResult = handoff.required
      ? await notifyFeishuSafely(shopId, buildAftersaleHandoffNotice({
        shopName: shop?.nickname,
        handoff,
        packId: thread.packId.toString(),
        orderId: thread.orderId?.toString(),
        buyerMessage: latestMessage,
        conversationText: conversationHistory.join("\n"),
        suggestedAction: analysis.suggested_action_zh,
        suggestedReply
      }))
      : null;
    if (handoff.required && req.body?.dispatch === true) {
      const now = new Date();
      await prisma.message.create({
        data: {
          shopId,
          threadId: thread.id,
          meliMessageId: `system-handoff-${thread.id}-${now.getTime()}`,
          packId: thread.packId,
          direction: "system",
          text: `已通过飞书提醒人工处理：${handoff.label || handoff.reason || "转人工"}`,
          rawMessage: safeJson({ source: "system_handoff", handoff, feishuResult }) as Prisma.InputJsonValue,
          messageDate: now
        }
      });
    }
    await prisma.aiSuggestion.create({
      data: {
        shopId,
        targetType: "aftersale_thread",
        targetId: thread.id,
        model: selectedAiProvider() || "local_rules",
        promptVersion: aiPromptVersion("aftersale"),
        inputSnapshot: safeJson({ thread, latestMessage, sku, knowledgeScope: "aftersale_templates_only" }) as unknown as Prisma.InputJsonValue,
        outputJson: safeJson({ ...analysis, handoff, matchedTemplate: matchedTemplate ? { id: matchedTemplate.id, name: matchedTemplate.name } : null, feishuResult }) as unknown as Prisma.InputJsonValue,
        outputText: suggestedReply,
        riskFlags: analysis.forbidden_commitments_detected
      }
    });

    const refreshedThread = await prisma.aftersaleThread.findUnique({
      where: { id: thread.id },
      include: {
        messages: { orderBy: { messageDate: "asc" }, take: 30 },
        _count: { select: { messages: true } }
      }
    });
    return sendJson(res, { success: true, thread: refreshedThread ? withAftersaleComputedFields(refreshedThread) : withAftersaleComputedFields({ ...updated, messages: thread.messages.slice().reverse(), _count: thread._count }), analysis, handoff, suggestedReply, matchedTemplate, feishuResult, ragHits: [] });
  } catch (error) {
    return next(error);
  }
});

app.post("/aftersale/threads/:id/send", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId);
    const wantsRealSend = req.body?.dryRun === false;
    const allowLocalRecord = req.body?.allowLocalRecord === true;
    if (wantsRealSend && process.env.AUTO_SEND_AFTERSALE !== "true" && !allowLocalRecord) {
      throw new HttpError(409, "Real Mercado Libre post-sale send is disabled. Set AUTO_SEND_AFTERSALE=true after OAuth and audit checks are ready.");
    }
    const dryRun = !wantsRealSend || process.env.AUTO_SEND_AFTERSALE !== "true";
    const thread = await prisma.aftersaleThread.findFirst({ where: { id: String(req.params.id), shopId } });
    if (!thread) throw new HttpError(404, "thread not found");
    const replyText = String(req.body?.replyText || thread.suggestedReply || "").trim();
    if (!replyText) throw new HttpError(400, "replyText is required");

    if (dryRun) {
      const now = new Date();
      const localSource = allowLocalRecord ? "manual_local_record" : "dry_run";
      const outboundMessage = await prisma.message.create({
        data: {
          shopId,
          threadId: thread.id,
          meliMessageId: `dry-run-aftersale-${thread.id}-${now.getTime()}`,
          packId: thread.packId,
          direction: "outbound",
          text: replyText,
          rawMessage: safeJson({ source: localSource, replyText }) as Prisma.InputJsonValue,
          messageDate: now
        }
      });
      await prisma.aftersaleThread.update({
        where: { id: thread.id },
        data: { suggestedReply: replyText, status: "closed", lastMessageAt: now }
      });
      await createOperationLog(req, {
        shopId,
        action: allowLocalRecord ? "aftersale.send.local_record" : "aftersale.send.dry_run",
        targetType: "aftersale_thread",
        targetId: thread.id,
        detail: { packId: thread.packId.toString(), orderId: thread.orderId?.toString(), replyText }
      });
      const updatedThread = await prisma.aftersaleThread.findUnique({
        where: { id: thread.id },
        include: {
          messages: { orderBy: { messageDate: "asc" }, take: 30 },
          _count: { select: { messages: true } }
        }
      });
      return sendJson(res, {
        success: true,
        dryRun: true,
        localRecord: allowLocalRecord,
        message: allowLocalRecord ? "Reply recorded locally because real Mercado Libre message send is not enabled yet." : "Reply recorded as dry run. Real Mercado Libre message send is not enabled yet.",
        outboundMessage,
        thread: updatedThread ? withAftersaleComputedFields(updatedThread) : null
      });
    }

    const meliResult = await postMeliPackMessage(shopId, thread.packId, replyText);
    const now = new Date();
    const outboundMessage = await prisma.message.create({
      data: {
        shopId,
        threadId: thread.id,
        meliMessageId: `meli-aftersale-${thread.id}-${now.getTime()}`,
        packId: thread.packId,
        direction: "outbound",
        text: replyText,
        rawMessage: safeJson({ source: "mercado_libre", meliResult }) as Prisma.InputJsonValue,
        messageDate: now
      }
    });
    await prisma.aftersaleThread.update({
      where: { id: thread.id },
      data: { suggestedReply: replyText, status: "closed", lastMessageAt: now }
    });
    await createOperationLog(req, {
      shopId,
      action: "aftersale.send.real",
      targetType: "aftersale_thread",
      targetId: thread.id,
      detail: { packId: thread.packId.toString(), orderId: thread.orderId?.toString() }
    });
    const updatedThread = await prisma.aftersaleThread.findUnique({
      where: { id: thread.id },
      include: {
        messages: { orderBy: { messageDate: "asc" }, take: 30 },
        _count: { select: { messages: true } }
      }
    });
    return sendJson(res, {
      success: true,
      dryRun: false,
      outboundMessage,
      thread: updatedThread ? withAftersaleComputedFields(updatedThread) : null,
      meliResult
    });
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

app.delete("/aftersale/threads/:id", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req, req.body?.shopId || req.query.shopId);
    const thread = await prisma.aftersaleThread.findFirst({ where: { id: String(req.params.id), shopId } });
    if (!thread) throw new HttpError(404, "thread not found");
    await prisma.$transaction([
      prisma.aiSuggestion.deleteMany({ where: { shopId, targetType: "aftersale_thread", targetId: thread.id } }),
      prisma.message.deleteMany({ where: { threadId: thread.id, shopId } }),
      prisma.aftersaleThread.delete({ where: { id: thread.id } })
    ]);
    await createOperationLog(req, { shopId, action: "aftersale.delete", targetType: "aftersale_thread", targetId: thread.id });
    return sendJson(res, { success: true, deletedId: thread.id });
  } catch (error) {
    return next(error);
  }
});

app.get("/reply-reviews", async (req, res, next) => {
  try {
    const shopId = await resolveShopId(req);
    const [questions, threads] = await Promise.all([
      prisma.presaleQuestion.findMany({
        where: { shopId, reviewStatus: { in: ["draft_ready", "needs_human"] } },
        orderBy: { updatedAt: "desc" },
        take: 100
      }),
      prisma.aftersaleThread.findMany({
        where: { shopId, suggestedReply: { not: null }, status: { in: ["open", "human_pending"] } },
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
          targetType: "presale_question",
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
        targetType: "aftersale_thread",
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
