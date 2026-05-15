-- Enable pgvector for kb_chunks.embedding. Managed PostgreSQL must allow this extension.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "shops" (
    "id" UUID NOT NULL,
    "seller_id" BIGINT NOT NULL,
    "site_id" VARCHAR(10) NOT NULL DEFAULT 'MLM',
    "nickname" VARCHAR(255),
    "status" VARCHAR(30) NOT NULL DEFAULT 'active',
    "authorized_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "name" VARCHAR(120),
    "role" VARCHAR(30) NOT NULL DEFAULT 'operator',
    "status" VARCHAR(30) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "app_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_members" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" VARCHAR(30) NOT NULL DEFAULT 'operator',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "shop_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_ip_policies" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "label" VARCHAR(120),
    "cidr" VARCHAR(80) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "shop_ip_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meli_tokens" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT NOT NULL,
    "scope" TEXT,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "last_refresh_at" TIMESTAMPTZ,
    "refresh_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "meli_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "topic" VARCHAR(80) NOT NULL,
    "resource" TEXT NOT NULL,
    "user_id" BIGINT,
    "application_id" BIGINT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "raw_payload" JSONB NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "dedupe_key" TEXT,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,
    "error" TEXT,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "presale_questions" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "question_id" BIGINT NOT NULL,
    "item_id" VARCHAR(50) NOT NULL,
    "buyer_id" BIGINT,
    "question_text" TEXT,
    "question_status" VARCHAR(50),
    "ai_draft" TEXT,
    "ai_confidence" DECIMAL(5,2),
    "risk_level" VARCHAR(20) DEFAULT 'low',
    "review_status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "final_answer" TEXT,
    "sent_at" TIMESTAMPTZ,
    "raw_question" JSONB,
    "raw_item" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "presale_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aftersale_threads" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "pack_id" BIGINT NOT NULL,
    "order_id" BIGINT,
    "buyer_id" BIGINT,
    "status" VARCHAR(30) NOT NULL DEFAULT 'open',
    "category" VARCHAR(50),
    "risk_level" VARCHAR(20),
    "summary" TEXT,
    "suggested_action" TEXT,
    "suggested_reply" TEXT,
    "claim_id" BIGINT,
    "return_id" BIGINT,
    "last_message_at" TIMESTAMPTZ,
    "raw_context" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "aftersale_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "thread_id" UUID,
    "meli_message_id" TEXT,
    "pack_id" BIGINT,
    "sender_user_id" BIGINT,
    "receiver_user_id" BIGINT,
    "direction" VARCHAR(20),
    "text" TEXT,
    "raw_message" JSONB,
    "message_date" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_suggestions" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "target_type" VARCHAR(30) NOT NULL,
    "target_id" UUID NOT NULL,
    "model" VARCHAR(100),
    "prompt_version" VARCHAR(50),
    "input_snapshot" JSONB NOT NULL,
    "output_json" JSONB,
    "output_text" TEXT,
    "risk_flags" TEXT[],
    "accepted" BOOLEAN,
    "edited_text" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_documents" (
    "id" UUID NOT NULL,
    "shop_id" UUID,
    "title" TEXT NOT NULL,
    "doc_type" VARCHAR(50) NOT NULL,
    "content" TEXT NOT NULL,
    "locale" VARCHAR(10) NOT NULL DEFAULT 'es-MX',
    "status" VARCHAR(30) NOT NULL DEFAULT 'indexed',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kb_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_chunks" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "shop_id" UUID,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "metadata" JSONB,
    "score_hint" DECIMAL(5,2),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sku_knowledge" (
    "id" UUID NOT NULL,
    "shop_id" UUID,
    "sku" VARCHAR(100) NOT NULL,
    "item_id" VARCHAR(80),
    "title" TEXT NOT NULL,
    "brand" VARCHAR(120),
    "category" VARCHAR(120),
    "locale" VARCHAR(10) NOT NULL DEFAULT 'es-MX',
    "selling_points" TEXT,
    "faq" TEXT,
    "warranty_policy" TEXT,
    "invoice_policy" TEXT,
    "shipping_notes" TEXT,
    "return_policy" TEXT,
    "forbidden_notes" TEXT,
    "attributes" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sku_knowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_call_logs" (
    "id" UUID NOT NULL,
    "shop_id" UUID,
    "method" VARCHAR(10) NOT NULL,
    "path" TEXT NOT NULL,
    "status_code" INTEGER,
    "request_id" TEXT,
    "latency_ms" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_logs" (
    "id" UUID NOT NULL,
    "shop_id" UUID,
    "actor_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "target_type" VARCHAR(50) NOT NULL,
    "target_id" UUID,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings_rules" (
    "id" UUID NOT NULL,
    "shop_id" UUID,
    "key" VARCHAR(120) NOT NULL,
    "value" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "settings_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reply_templates" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "intent_code" VARCHAR(80) NOT NULL,
    "category" VARCHAR(80) NOT NULL,
    "language" VARCHAR(10) NOT NULL DEFAULT 'es-MX',
    "scenario" VARCHAR(160),
    "keywords" TEXT[],
    "content" TEXT NOT NULL,
    "variables" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "requires_review" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "reply_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reply_template_versions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "changed_by" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reply_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shops_seller_id_key" ON "shops"("seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_users_email_key" ON "app_users"("email");

-- CreateIndex
CREATE INDEX "shop_members_user_id_active_idx" ON "shop_members"("user_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "shop_members_shop_id_user_id_key" ON "shop_members"("shop_id", "user_id");

-- CreateIndex
CREATE INDEX "shop_ip_policies_shop_id_active_idx" ON "shop_ip_policies"("shop_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_dedupe_key_key" ON "webhook_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "webhook_events_topic_status_idx" ON "webhook_events"("topic", "status");

-- CreateIndex
CREATE UNIQUE INDEX "presale_questions_question_id_key" ON "presale_questions"("question_id");

-- CreateIndex
CREATE INDEX "presale_questions_shop_id_review_status_idx" ON "presale_questions"("shop_id", "review_status");

-- CreateIndex
CREATE INDEX "aftersale_threads_shop_id_status_risk_level_idx" ON "aftersale_threads"("shop_id", "status", "risk_level");

-- CreateIndex
CREATE UNIQUE INDEX "aftersale_threads_shop_id_pack_id_key" ON "aftersale_threads"("shop_id", "pack_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_meli_message_id_key" ON "messages"("meli_message_id");

-- CreateIndex
CREATE INDEX "messages_shop_id_pack_id_idx" ON "messages"("shop_id", "pack_id");

-- CreateIndex
CREATE INDEX "ai_suggestions_shop_id_target_type_target_id_idx" ON "ai_suggestions"("shop_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "kb_documents_shop_id_doc_type_active_idx" ON "kb_documents"("shop_id", "doc_type", "active");

-- CreateIndex
CREATE INDEX "kb_chunks_shop_id_idx" ON "kb_chunks"("shop_id");

-- CreateIndex
CREATE INDEX "sku_knowledge_shop_id_item_id_idx" ON "sku_knowledge"("shop_id", "item_id");

-- CreateIndex
CREATE INDEX "sku_knowledge_shop_id_active_idx" ON "sku_knowledge"("shop_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "sku_knowledge_shop_id_sku_key" ON "sku_knowledge"("shop_id", "sku");

-- CreateIndex
CREATE INDEX "api_call_logs_shop_id_created_at_idx" ON "api_call_logs"("shop_id", "created_at");

-- CreateIndex
CREATE INDEX "operation_logs_shop_id_action_created_at_idx" ON "operation_logs"("shop_id", "action", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "settings_rules_shop_id_key_key" ON "settings_rules"("shop_id", "key");

-- CreateIndex
CREATE INDEX "reply_templates_shop_id_intent_code_active_idx" ON "reply_templates"("shop_id", "intent_code", "active");

-- CreateIndex
CREATE UNIQUE INDEX "reply_templates_shop_id_name_version_key" ON "reply_templates"("shop_id", "name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "reply_template_versions_template_id_version_key" ON "reply_template_versions"("template_id", "version");

-- AddForeignKey
ALTER TABLE "shop_members" ADD CONSTRAINT "shop_members_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_members" ADD CONSTRAINT "shop_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_ip_policies" ADD CONSTRAINT "shop_ip_policies_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meli_tokens" ADD CONSTRAINT "meli_tokens_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "presale_questions" ADD CONSTRAINT "presale_questions_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aftersale_threads" ADD CONSTRAINT "aftersale_threads_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "aftersale_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "kb_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_knowledge" ADD CONSTRAINT "sku_knowledge_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_call_logs" ADD CONSTRAINT "api_call_logs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_logs" ADD CONSTRAINT "operation_logs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_logs" ADD CONSTRAINT "operation_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "app_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings_rules" ADD CONSTRAINT "settings_rules_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reply_templates" ADD CONSTRAINT "reply_templates_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reply_template_versions" ADD CONSTRAINT "reply_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "reply_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;



