import { z } from "zod";

export const MeliTopicSchema = z.enum([
  "questions",
  "messages",
  "claims",
  "orders_v2",
  "shipments"
]);

export type MeliTopic = z.infer<typeof MeliTopicSchema>;

export const WebhookPayloadSchema = z.object({
  topic: z.string().min(1),
  resource: z.string().min(1),
  user_id: z.union([z.number(), z.string()]).optional(),
  application_id: z.union([z.number(), z.string()]).optional(),
  sent: z.string().optional(),
  attempts: z.number().optional()
}).passthrough();

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

export const PresaleRiskSchema = z.enum(["low", "medium", "high"]);
export type PresaleRisk = z.infer<typeof PresaleRiskSchema>;

export const AftersaleCategorySchema = z.enum([
  "shipping_delay",
  "tracking_question",
  "not_received",
  "wrong_item",
  "damaged_item",
  "missing_part",
  "return_request",
  "refund_request",
  "invoice_request",
  "warranty",
  "claim_opened",
  "negative_feedback_risk",
  "buyer_abuse",
  "other"
]);

export type AftersaleCategory = z.infer<typeof AftersaleCategorySchema>;

export const forbiddenWords = {
  blocked_contact: [
    "whatsapp",
    "wa.me",
    "telefono",
    "teléfono",
    "celular",
    "correo",
    "email",
    "@",
    "facebook",
    "instagram"
  ],
  blocked_off_platform: [
    "fuera de mercado libre",
    "transferencia",
    "deposito",
    "depósito",
    "pago directo"
  ],
  refund_sensitive: [
    "reembolso",
    "devolución de dinero",
    "devolucion de dinero",
    "compensación",
    "compensacion",
    "te regresamos",
    "te pagamos"
  ],
  liability_sensitive: [
    "fue nuestro error",
    "tenemos la culpa",
    "aceptamos responsabilidad"
  ]
} as const;

export function makeWebhookDedupeKey(payload: WebhookPayload): string {
  return [
    payload.topic,
    payload.resource,
    payload.user_id ?? "",
    payload.sent ?? ""
  ].join(":");
}

export function toBigIntOrNull(value: unknown): bigint | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
