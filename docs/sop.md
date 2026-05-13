# Meli AI Support MVP SOP

This repo implements the first thin slice of a Mercado Libre support assistant:

- OAuth-ready API skeleton.
- Webhook intake with dedupe and BullMQ enqueue.
- PostgreSQL schema for shops, tokens, webhook events, presale questions, aftersale threads, messages, AI suggestions, KB, and API logs.
- Shared Mercado Libre client wrapper with retryable errors, 401 refresh hook, 429 handling, and API call logging hook.
- AI schemas and guardrail helpers for presale drafts and aftersale analysis.
- Minimal Next.js console for health and shop authorization entry.

## First Run

```bash
cp .env.example .env
pnpm install
pnpm db:generate
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev
```

## Current Boundary

The skeleton intentionally does not send presale answers yet. Before enabling `POST /answers`, add:

- User authentication and operator permissions.
- Final forbidden phrase checks.
- Mercado Libre question status recheck.
- Operation audit log.

Aftersale is analysis-only in MVP.

## Next Development Order

1. Finish token decrypt/refresh lock provider.
2. Implement `process-presale-question`: GET question, GET item, save `presale_questions`.
3. Add OpenAI structured output call for presale drafts.
4. Build presale list/detail pages.
5. Implement manual send with `/answers`.
6. Implement aftersale message/claim processors.
