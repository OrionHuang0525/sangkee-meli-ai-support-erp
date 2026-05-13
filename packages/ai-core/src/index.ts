import { z } from "zod";
import { AftersaleCategorySchema, forbiddenWords, PresaleRiskSchema } from "@meli-ai-support/shared";

export const PresaleReplySchema = z.object({
  answer_es_mx: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  risk_level: PresaleRiskSchema,
  needs_human_review: z.boolean(),
  missing_info: z.array(z.string()),
  policy_flags: z.array(z.string())
});

export type PresaleReply = z.infer<typeof PresaleReplySchema>;

export const AftersaleAnalysisSchema = z.object({
  summary_zh: z.string(),
  summary_es: z.string(),
  category: AftersaleCategorySchema,
  risk_level: z.enum(["low", "medium", "high"]),
  buyer_intent: z.string(),
  evidence: z.array(z.string()),
  suggested_action_zh: z.string(),
  suggested_reply_es_mx: z.string(),
  should_reply: z.boolean(),
  should_escalate_to_human: z.boolean(),
  forbidden_commitments_detected: z.array(z.string())
});

export type AftersaleAnalysis = z.infer<typeof AftersaleAnalysisSchema>;

export const KbChunkPlanSchema = z.object({
  chunks: z.array(z.object({
    title: z.string(),
    doc_type: z.string(),
    content: z.string(),
    sku_tags: z.array(z.string()).default([]),
    intent_tags: z.array(z.string()).default([]),
    risk_tags: z.array(z.string()).default([]),
    priority: z.number().min(0).max(1).default(0.5)
  }))
});

export type KbChunkPlan = z.infer<typeof KbChunkPlanSchema>;

export interface KnowledgeHit {
  id?: string;
  title: string;
  docType: string;
  content: string;
  score?: number;
  source?: "sku" | "document" | "chunk";
  metadata?: Record<string, unknown> | null;
}

export interface SkuKnowledgeContext {
  sku?: string | null;
  title?: string | null;
  sellingPoints?: string | null;
  faq?: string | null;
  warrantyPolicy?: string | null;
  invoicePolicy?: string | null;
  shippingNotes?: string | null;
  returnPolicy?: string | null;
  forbiddenNotes?: string | null;
}

export interface LocalPresaleInput {
  questionText: string;
  itemTitle?: string | null;
  sku?: string | null;
  knowledge?: SkuKnowledgeContext | null;
  ragHits?: KnowledgeHit[];
}

export interface LocalAftersaleInput {
  latestMessage?: string | null;
  orderStatus?: string | null;
  shipmentStatus?: string | null;
  hasClaim?: boolean;
  hasReturn?: boolean;
  sku?: string | null;
  knowledge?: SkuKnowledgeContext | null;
  ragHits?: KnowledgeHit[];
}

export function findForbiddenPhrases(text: string): string[] {
  const normalized = text.toLowerCase();
  const groups = Object.values(forbiddenWords).flat();
  return groups.filter((phrase) => normalized.includes(phrase.toLowerCase()));
}

export function assertSafePresaleAnswer(text: string): { safe: boolean; flags: string[] } {
  const flags = findForbiddenPhrases(text).filter((phrase) => {
    const allBlocked = [
      ...forbiddenWords.blocked_contact,
      ...forbiddenWords.blocked_off_platform
    ];
    return allBlocked.includes(phrase as never);
  });

  return {
    safe: flags.length === 0 && text.length <= 2000,
    flags
  };
}

export const presaleSystemPrompt = [
  "Eres un asistente de atención preventa para Mercado Libre México.",
  "Responde en español mexicano natural, breve y útil.",
  "Usa únicamente la información del producto, SKU, políticas y base de conocimiento proporcionadas.",
  "No compartas WhatsApp, teléfono, correo, direcciones, enlaces externos ni invites a pagar fuera de Mercado Libre.",
  "No prometas fechas exactas, descuentos, reembolsos ni garantías no documentadas.",
  "Si falta información, marca needs_human_review=true y ofrece una respuesta segura.",
  "Devuelve JSON válido con el esquema PresaleReplySchema."
].join("\n");

export const aftersaleSystemPrompt = [
  "Eres un asistente de control de calidad y análisis postventa para Mercado Libre México.",
  "No decides reembolsos, compensaciones ni aceptas responsabilidad; solo sugieres análisis y borradores.",
  "Considera mensaje del comprador, historial, orden, logística, claim/return y políticas de tienda.",
  "Riesgo alto siempre requiere revisión humana.",
  "La respuesta sugerida debe estar en español mexicano, ser breve, empática y segura.",
  "Devuelve JSON válido con el esquema AftersaleAnalysisSchema."
].join("\n");

function includesAny(text: string, patterns: string[]): boolean {
  const normalized = text.toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

function firstHitText(hits: KnowledgeHit[] | undefined, docType: string): string {
  return hits?.find((hit) => hit.docType === docType)?.content || "";
}

export function generateLocalPresaleDraft(input: LocalPresaleInput): PresaleReply {
  const question = input.questionText || "";
  const knowledge = input.knowledge;
  const flags = findForbiddenPhrases(question);
  let risk: "low" | "medium" | "high" = "low";
  let needsHumanReview = false;
  const missingInfo: string[] = [];
  let answer = "Hola, gracias por tu pregunta. Vamos a revisar la información del producto para confirmarte con precisión.";

  const invoicePolicy = knowledge?.invoicePolicy || firstHitText(input.ragHits, "invoice");
  const warrantyPolicy = knowledge?.warrantyPolicy || firstHitText(input.ragHits, "warranty");
  const compatibility = knowledge?.faq || knowledge?.sellingPoints || firstHitText(input.ragHits, "product");

  if (flags.length) {
    risk = "high";
    needsHumanReview = true;
    answer = "Hola, gracias por tu pregunta. Podemos ayudarte por este medio dentro de Mercado Libre.";
  } else if (includesAny(question, ["factura", "facturan", "cfdi"])) {
    answer = invoicePolicy
      ? `Hola, sí facturamos. ${invoicePolicy}`
      : "Hola, sí podemos facturar. Después de tu compra, envíanos tus datos fiscales por el chat de Mercado Libre para apoyarte.";
  } else if (includesAny(question, ["garantia", "garantía"])) {
    answer = warrantyPolicy
      ? `Hola, sí cuenta con garantía. ${warrantyPolicy}`
      : "Hola, sí cuenta con garantía. Si necesitas un detalle específico, lo confirmamos antes de tu compra.";
  } else if (includesAny(question, ["compatible", "sirve", "funciona"])) {
    if (compatibility) {
      answer = `Hola, ${compatibility}`;
    } else {
      risk = "medium";
      needsHumanReview = true;
      missingInfo.push("No hay información suficiente de compatibilidad en la base de conocimiento.");
      answer = "Hola, para confirmarte compatibilidad exacta, por favor indícanos el modelo completo que deseas usar.";
    }
  } else if (includesAny(question, ["disponible", "stock", "hay", "tienen"])) {
    answer = "Hola, si la publicación te permite comprar, tenemos disponibilidad. Puedes realizar tu compra directamente desde Mercado Libre.";
  } else if (includesAny(question, ["reembolso", "devolución", "devolucion", "malo", "dañado", "danado", "roto"])) {
    risk = "high";
    needsHumanReview = true;
    answer = "Hola, gracias por escribirnos. Para casos de devolución o garantía, revisaremos tu situación por el canal correspondiente de Mercado Libre.";
  } else if (compatibility) {
    answer = `Hola, ${compatibility}`;
  } else {
    risk = "medium";
    needsHumanReview = true;
    missingInfo.push("No hay conocimiento suficiente para responder con confianza.");
  }

  const safety = assertSafePresaleAnswer(answer);

  return PresaleReplySchema.parse({
    answer_es_mx: answer.slice(0, 2000),
    confidence: risk === "low" && safety.safe ? 0.86 : risk === "medium" ? 0.62 : 0.35,
    risk_level: safety.safe ? risk : "high",
    needs_human_review: needsHumanReview || !safety.safe || missingInfo.length > 0,
    missing_info: missingInfo,
    policy_flags: [...new Set([...flags, ...safety.flags])]
  });
}

export function generateLocalAftersaleAnalysis(input: LocalAftersaleInput): AftersaleAnalysis {
  const latest = input.latestMessage || "";
  const evidence: string[] = [];
  const forbidden = findForbiddenPhrases(latest);
  let category: z.infer<typeof AftersaleCategorySchema> = "other";
  let risk: "low" | "medium" | "high" = "low";
  let intent = "Consulta general de postventa";
  let action = "El agente debe revisar el contexto del pedido y responder de forma conservadora.";
  let reply = "Hola, gracias por contactarnos. Estamos revisando tu caso y te responderemos por este medio a la brevedad.";

  if (input.hasClaim) {
    category = "claim_opened";
    risk = "high";
    evidence.push("Existe un claim abierto, requiere revisión humana prioritaria.");
  }

  if (input.hasReturn) {
    category = "return_request";
    risk = "high";
    evidence.push("Existe una devolución asociada, requiere revisar estado y evidencia.");
  }

  if (includesAny(latest, ["factura", "cfdi", "facturación", "facturacion"])) {
    category = "invoice_request";
    intent = "El comprador solicita factura o datos de facturación.";
    action = "Revisar datos fiscales, monto y orden; si falta información, pedirla por el chat de Mercado Libre.";
    reply = "Hola, gracias por la información. Vamos a revisar los datos de facturación y, si falta algún dato adicional, te contactaremos por este medio.";
  } else if (includesAny(latest, ["no lleg", "no he recibido", "no recibido"])) {
    category = "not_received";
    risk = input.shipmentStatus?.toLowerCase().includes("delivered") ? "high" : "medium";
    intent = "El comprador indica que no recibió el paquete.";
    action = "Revisar tracking y estado de entrega antes de prometer una solución.";
    reply = "Hola, lamentamos el inconveniente. Vamos a revisar el estado del envío y te compartiremos la información disponible por este medio.";
  } else if (includesAny(latest, ["dañado", "danado", "roto", "no funciona", "defecto"])) {
    category = "damaged_item";
    risk = "high";
    intent = "El comprador reporta producto dañado o defectuoso.";
    action = "Pedir evidencia, revisar claim/return y escalar a revisión humana.";
    reply = "Hola, sentimos el inconveniente. Para revisar tu caso, por favor compártenos evidencia del problema por este chat de Mercado Libre.";
  } else if (includesAny(latest, ["reembolso", "devolución", "devolucion", "dinero"])) {
    category = "refund_request";
    risk = "high";
    intent = "El comprador solicita reembolso o devolución.";
    action = "Escalar a humano y revisar el flujo oficial de Mercado Libre sin prometer reembolso.";
    reply = "Hola, entendemos tu solicitud. Vamos a revisar el estado de tu compra y las opciones disponibles dentro de Mercado Libre.";
  } else if (includesAny(latest, ["garantía", "garantia"])) {
    category = "warranty";
    risk = "medium";
    intent = "El comprador consulta garantía.";
    action = "Revisar política del SKU y fecha de compra antes de confirmar cobertura.";
    reply = input.knowledge?.warrantyPolicy
      ? `Hola, con gusto te apoyamos. ${input.knowledge.warrantyPolicy}`
      : "Hola, con gusto te apoyamos. Vamos a revisar la garantía aplicable a tu compra.";
  }

  if (forbidden.length) {
    risk = "high";
    evidence.push("Hay términos sensibles en el mensaje/contexto y se requiere confirmación humana.");
  }

  if (input.orderStatus) evidence.push(`Estado de orden: ${input.orderStatus}`);
  if (input.shipmentStatus) evidence.push(`Estado de logística: ${input.shipmentStatus}`);
  if (input.knowledge?.returnPolicy) evidence.push(`Política postventa: ${input.knowledge.returnPolicy}`);
  for (const hit of input.ragHits || []) {
    evidence.push(`KB ${hit.title}: ${hit.content.slice(0, 160)}`);
  }

  return AftersaleAnalysisSchema.parse({
    summary_zh: `${intent} 风险等级：${risk}。`,
    summary_es: intent,
    category,
    risk_level: risk,
    buyer_intent: intent,
    evidence,
    suggested_action_zh: action,
    suggested_reply_es_mx: reply,
    should_reply: risk !== "high",
    should_escalate_to_human: risk === "high",
    forbidden_commitments_detected: forbidden
  });
}
