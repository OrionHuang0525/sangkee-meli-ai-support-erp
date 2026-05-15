#!/usr/bin/env node

const apiUrl = (process.env.SMOKE_API_URL || process.env.API_URL || "http://127.0.0.1:3001").replace(/\/+$/, "");
const webhookSecret = process.env.SMOKE_WEBHOOK_SECRET || process.env.WEBHOOK_SHARED_SECRET || "";
const expectReady = process.env.SMOKE_EXPECT_READY !== "false";
const postWebhook = process.env.SMOKE_POST_WEBHOOK === "true";
const waitMs = Number(process.env.SMOKE_WAIT_MS || 30000);

async function request(path, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-User-Email": "local-admin@local",
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} returned non-JSON response: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  if (!response.ok && !init.allowFailure) {
    throw new Error(`${path} failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 500)}`);
  }
  return { response, data };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollAftersalePack(packId) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const { data } = await request("/aftersale/threads");
    const threads = Array.isArray(data.threads) ? data.threads : [];
    const match = threads.find((thread) => String(thread.packId) === String(packId));
    if (match) return match;
    await sleep(1500);
  }
  throw new Error(`Webhook smoke event was not visible in /aftersale/threads after ${waitMs}ms`);
}

async function main() {
  console.log(`[smoke] Checking ${apiUrl}`);
  await request("/livez");

  const ready = await request("/readyz", { allowFailure: true });
  if (expectReady && !ready.response.ok) {
    throw new Error(`/readyz is not ready: ${JSON.stringify(ready.data).slice(0, 1000)}`);
  }
  console.log(`[smoke] readyz=${ready.response.status}`);

  if (!postWebhook) {
    console.log("[smoke] Webhook bridge test skipped. Set SMOKE_POST_WEBHOOK=true to create and verify a test event.");
    return;
  }

  const now = Date.now();
  const packId = String(now);
  const payload = {
    topic: "messages",
    resource: `/messages/packs/${packId}`,
    user_id: process.env.SMOKE_SELLER_ID || "900000000001",
    application_id: process.env.SMOKE_APP_ID || "0",
    sent: new Date(now).toISOString(),
    pack_id: packId,
    order_id: String(now + 1),
    message_id: `smoke-${now}`,
    text: process.env.SMOKE_BUYER_TEXT || "Hola, no he recibido mi paquete. ¿Me pueden ayudar?"
  };

  await request("/webhooks/meli", {
    method: "POST",
    headers: webhookSecret ? { "x-webhook-secret": webhookSecret } : {},
    body: JSON.stringify(payload)
  });

  const thread = await pollAftersalePack(packId);
  console.log(`[smoke] Webhook bridge ok: pack=${packId}, status=${thread.status || "-"}, category=${thread.category || "-"}`);
}

main().catch((error) => {
  console.error(`[smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
