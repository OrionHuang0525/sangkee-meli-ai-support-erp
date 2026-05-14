"use client";

import { useEffect, useMemo, useState } from "react";

type Tab = "today" | "consultations" | "aftersale" | "reviews" | "knowledge" | "templates" | "stats" | "shop";
type AnyRecord = Record<string, unknown>;
type CsvEncoding = "auto" | "utf-8" | "gb18030" | "utf-16le" | "big5";

interface AppShellProps {
  apiUrl: string;
}

function asList<T = AnyRecord>(value: unknown, key: string): T[] {
  if (value && typeof value === "object" && Array.isArray((value as AnyRecord)[key])) return (value as Record<string, T[]>)[key];
  return [];
}

function valueOf(item: unknown, key: string): string {
  if (!item || typeof item !== "object") return "";
  const value = (item as AnyRecord)[key];
  return value === null || value === undefined ? "" : String(value);
}

function short(value: string, max = 150) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function statusText(value: string) {
  const map: Record<string, string> = {
    pending: "待处理",
    draft_ready: "待审核",
    needs_human: "需要人工处理",
    approved: "已通过",
    sent: "已发送",
    dry_run_sent: "已记录发送",
    open: "待跟进",
    closed: "已关闭",
    low: "低",
    medium: "中",
    high: "高",
    human_request: "转人工请求",
    claim_opened: "平台纠纷",
    invoice_request: "发票问题",
    not_received: "未收到货",
    shipping_not_received: "物流未收到",
    shipping_delay: "物流延迟",
    damaged_item: "商品损坏",
    refund_request: "退款请求",
    return_request: "退换货",
    warranty: "保修咨询",
    indexed: "可使用",
    failed: "处理失败",
    partial_failed: "部分失败"
  };
  return map[value] || value || "-";
}

function docTypeText(value: string) {
  const map: Record<string, string> = {
    product: "商品说明",
    invoice: "发票规则",
    warranty: "保修政策",
    shipping: "物流说明",
    return: "退换货规则",
    faq: "常见问题",
    presale: "售前话术",
    aftersale: "售后规则",
    policy: "店铺资料"
  };
  return map[value] || value || "-";
}

function matchText(score: string) {
  const number = Number(score || 0);
  if (number >= 10) return "高";
  if (number >= 4) return "中";
  return "低";
}

async function requestJson(apiUrl: string, path: string, init?: RequestInit) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-User-Email": "local-admin@local",
      ...(init?.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok || data.success === false) throw new Error(data.message || `HTTP ${response.status}`);
  return data;
}

function scoreDecodedText(text: string) {
  const badPatterns = [
    "\ufffd", "锟", "閿", "鍙", "鏂", "涓", "涔", "鑱", "绋", "铆", "贸", "帽", "煤", "Ã", "Â"
  ];
  let score = 0;
  for (const pattern of badPatterns) score += (text.match(new RegExp(pattern, "g")) || []).length * 10;
  score += (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length * 6;
  if (/sku/i.test(text)) score -= 6;
  if (/title|商品|标题|名称|factura|garant/i.test(text)) score -= 3;
  if (text.includes(",") || text.includes("\t") || text.includes(";")) score -= 2;
  return score;
}

function decodeBuffer(buffer: ArrayBuffer, encoding: Exclude<CsvEncoding, "auto">) {
  const label = encoding === "utf-8" ? "utf-8" : encoding;
  return new TextDecoder(label, { fatal: encoding === "utf-8" }).decode(buffer);
}

async function decodeFile(file: File, encoding: CsvEncoding) {
  const buffer = await file.arrayBuffer();
  if (encoding !== "auto") return decodeBuffer(buffer, encoding);

  const candidates: Array<Exclude<CsvEncoding, "auto">> = ["utf-8", "gb18030", "utf-16le", "big5"];
  const decoded = candidates.flatMap((candidate) => {
    try {
      const text = decodeBuffer(buffer, candidate).replace(/^\uFEFF/, "");
      return [{ encoding: candidate, text, score: scoreDecodedText(text) }];
    } catch {
      return [];
    }
  });

  const best = decoded.sort((a, b) => a.score - b.score)[0];
  if (best) return best.text;

  try {
    return new TextDecoder("gb18030").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

export default function AppShell({ apiUrl }: AppShellProps) {
  const [tab, setTab] = useState<Tab>("today");
  const [dashboard, setDashboard] = useState<AnyRecord | null>(null);
  const [shops, setShops] = useState<AnyRecord[]>([]);
  const [skus, setSkus] = useState<AnyRecord[]>([]);
  const [documents, setDocuments] = useState<AnyRecord[]>([]);
  const [questions, setQuestions] = useState<AnyRecord[]>([]);
  const [threads, setThreads] = useState<AnyRecord[]>([]);
  const [templates, setTemplates] = useState<AnyRecord[]>([]);
  const [reviews, setReviews] = useState<AnyRecord[]>([]);
  const [logs, setLogs] = useState<AnyRecord[]>([]);
  const [feishu, setFeishu] = useState<AnyRecord | null>(null);
  const [automation, setAutomation] = useState<AnyRecord | null>(null);
  const [selectedShop, setSelectedShop] = useState("");
  const [productText, setProductText] = useState("");
  const [docTitle, setDocTitle] = useState("");
  const [docType, setDocType] = useState("invoice");
  const [docSku, setDocSku] = useState("");
  const [docContent, setDocContent] = useState("");
  const [referenceQuery, setReferenceQuery] = useState("");
  const [referenceHits, setReferenceHits] = useState<AnyRecord[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templateIntent, setTemplateIntent] = useState("");
  const [templateContent, setTemplateContent] = useState("");
  const [editingTemplateId, setEditingTemplateId] = useState("");
  const [editingDocumentId, setEditingDocumentId] = useState("");
  const [feishuUrl, setFeishuUrl] = useState("");
  const [feishuSecret, setFeishuSecret] = useState("");
  const [autoMode, setAutoMode] = useState("all_templates");
  const [selectedQuestionId, setSelectedQuestionId] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [csvEncoding, setCsvEncoding] = useState<CsvEncoding>("auto");
  const [draftText, setDraftText] = useState("");
  const [aftersaleReplyText, setAftersaleReplyText] = useState("");
  const [presaleReferences, setPresaleReferences] = useState<AnyRecord[]>([]);
  const [aftersaleReferences, setAftersaleReferences] = useState<AnyRecord[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const metrics = useMemo(() => dashboard?.metrics as AnyRecord | undefined || {}, [dashboard]);
  const systemStatus = useMemo(() => dashboard?.systemStatus as AnyRecord | undefined || {}, [dashboard]);
  const currentShop = useMemo(() => shops.find((shop) => valueOf(shop, "id") === selectedShop), [shops, selectedShop]);
  const selectedQuestion = useMemo(
    () => questions.find((question) => valueOf(question, "id") === selectedQuestionId) || questions[0],
    [questions, selectedQuestionId]
  );
  const selectedThread = useMemo(
    () => threads.find((thread) => valueOf(thread, "id") === selectedThreadId) || threads[0],
    [threads, selectedThreadId]
  );
  const shopQuery = selectedShop ? `?shopId=${encodeURIComponent(selectedShop)}` : "";

  async function refresh() {
    const [nextDashboard, nextShops, nextSkus, nextDocs, nextQuestions, nextThreads, nextTemplates, nextReviews, nextLogs, nextFeishu, nextAutomation] = await Promise.all([
      requestJson(apiUrl, `/dashboard${shopQuery}`),
      requestJson(apiUrl, "/shops"),
      requestJson(apiUrl, `/kb/skus${shopQuery}`),
      requestJson(apiUrl, `/kb/documents${shopQuery}`),
      requestJson(apiUrl, `/presale/questions${shopQuery}`),
      requestJson(apiUrl, `/aftersale/threads${shopQuery}`),
      requestJson(apiUrl, `/reply-templates${shopQuery}`),
      requestJson(apiUrl, `/reply-reviews${shopQuery}`),
      requestJson(apiUrl, `/operation-logs${shopQuery}`),
      requestJson(apiUrl, `/settings/feishu-webhook${shopQuery}`),
      requestJson(apiUrl, `/settings/automation${shopQuery}`)
    ]);
    setDashboard(nextDashboard);
    setShops(asList(nextShops, "shops"));
    setSkus(asList(nextSkus, "skus"));
    setDocuments(asList(nextDocs, "documents"));
    setQuestions(asList(nextQuestions, "questions"));
    setThreads(asList(nextThreads, "threads"));
    setTemplates(asList(nextTemplates, "templates"));
    setReviews(asList(nextReviews, "reviews"));
    setLogs(asList(nextLogs, "logs"));
    setFeishu(nextFeishu);
    setAutomation(nextAutomation.policy || null);
    setAutoMode(String(nextAutomation.policy?.autoReplyMode || "all_templates"));
    if (!selectedShop && nextDashboard.shop?.id) setSelectedShop(String(nextDashboard.shop.id));
    const loadedQuestions = asList(nextQuestions, "questions");
    const loadedThreads = asList(nextThreads, "threads");
    if (!selectedQuestionId && loadedQuestions[0]) setSelectedQuestionId(valueOf(loadedQuestions[0], "id"));
    if (!selectedThreadId && loadedThreads[0]) setSelectedThreadId(valueOf(loadedThreads[0], "id"));
  }

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      await refresh();
      setMessage(`${label}完成`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refresh().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, [selectedShop]);

  useEffect(() => {
    setDraftText("");
    setPresaleReferences([]);
  }, [selectedQuestion?.id]);

  useEffect(() => {
    setAftersaleReplyText("");
    setAftersaleReferences([]);
  }, [selectedThread?.id]);

  async function saveProductKnowledge() {
    await requestJson(apiUrl, "/kb/skus/import", { method: "POST", body: JSON.stringify({ shopId: selectedShop, csv: productText }) });
  }

  async function saveDocument() {
    await requestJson(apiUrl, editingDocumentId ? `/kb/documents/${editingDocumentId}` : "/kb/documents/import", {
      method: editingDocumentId ? "PATCH" : "POST",
      body: JSON.stringify({ shopId: selectedShop, title: docTitle, docType, sku: docSku, content: docContent })
    });
    setEditingDocumentId("");
  }

  async function searchReferences() {
    const result = await requestJson(apiUrl, "/kb/search", { method: "POST", body: JSON.stringify({ shopId: selectedShop, query: referenceQuery, sku: docSku, limit: 8 }) });
    setReferenceHits(asList(result, "hits"));
  }

  async function saveTemplate() {
    await requestJson(apiUrl, editingTemplateId ? `/reply-templates/${editingTemplateId}` : "/reply-templates", {
      method: editingTemplateId ? "PATCH" : "POST",
      body: JSON.stringify({ shopId: selectedShop, name: templateName, intentCode: templateIntent, category: templateIntent, keywords: templateIntent.split("_"), content: templateContent, variables: ["orderId", "sku"] })
    });
    setEditingTemplateId("");
  }

  async function saveFeishu() {
    await requestJson(apiUrl, "/settings/feishu-webhook", {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop, webhookUrl: feishuUrl, secret: feishuSecret, enabled: true, notifyPresale: true, notifyAftersale: true })
    });
    setFeishuUrl("");
    setFeishuSecret("");
  }

  async function saveAutomation() {
    await requestJson(apiUrl, "/settings/automation", {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop, autoReplyMode: autoMode, bulkApproveLowRisk: true, requireHumanForHighRisk: true })
    });
  }

  async function generatePresaleDraft() {
    if (!selectedQuestion) return;
    const response = await fetch(`${apiUrl}/presale/questions/${valueOf(selectedQuestion, "id")}/generate/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-User-Email": "local-admin@local"
      },
      body: JSON.stringify({ shopId: selectedShop })
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

    setDraftText("");
    setPresaleReferences([]);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let started = false;

    const handleEvent = (block: string) => {
      const lines = block.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
      const dataText = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      const data = dataText ? JSON.parse(dataText) as AnyRecord : {};

      if (event === "status") {
        setMessage(valueOf(data, "message"));
      } else if (event === "references") {
        setPresaleReferences(asList(data, "ragHits"));
      } else if (event === "chunk") {
        const chunk = valueOf(data, "text");
        if (!started) {
          started = true;
          setDraftText(chunk);
        } else {
          setDraftText((current) => `${current}${chunk}`);
        }
      } else if (event === "replace") {
        const text = valueOf(data, "text");
        started = Boolean(text);
        setDraftText(text);
      } else if (event === "done") {
        setDraftText(valueOf((data.draft as AnyRecord | undefined), "answer_es_mx"));
        setPresaleReferences(asList(data, "ragHits"));
      } else if (event === "error") {
        throw new Error(valueOf(data, "message") || "AI 流式生成失败");
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\n\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) if (block.trim()) handleEvent(block);
    }
    if (buffer.trim()) handleEvent(buffer);
  }

  async function approvePresaleDraft() {
    if (!selectedQuestion) return;
    await requestJson(apiUrl, `/presale/questions/${valueOf(selectedQuestion, "id")}/approve`, {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop, answerText: draftText })
    });
  }

  async function sendPresaleDryRun() {
    if (!selectedQuestion) return;
    await requestJson(apiUrl, `/presale/questions/${valueOf(selectedQuestion, "id")}/send`, {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop, answerText: draftText })
    });
  }

  async function sendPresaleToMeli() {
    if (!selectedQuestion) return;
    await requestJson(apiUrl, `/presale/questions/${valueOf(selectedQuestion, "id")}/send`, {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop, answerText: draftText, dryRun: false })
    });
  }

  async function deletePresaleQuestion(id: string) {
    if (!id || !window.confirm("删除这条买家咨询及其 AI 建议？")) return;
    await requestJson(apiUrl, `/presale/questions/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ shopId: selectedShop })
    });
    setSelectedQuestionId("");
    setDraftText("");
  }

  async function deleteSkuKnowledge(id: string, title: string) {
    if (!id || !window.confirm(`删除商品资料「${title || id}」？删除后售前 AI 将不再引用这条商品资料。`)) return;
    await requestJson(apiUrl, `/kb/skus/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ shopId: selectedShop })
    });
  }

  async function deleteDocument(id: string, title: string) {
    if (!id || !window.confirm(`删除文本资料「${title || id}」？相关检索片段会一起删除。`)) return;
    await requestJson(apiUrl, `/kb/documents/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ shopId: selectedShop })
    });
  }

  function editDocument(doc: AnyRecord) {
    setEditingDocumentId(valueOf(doc, "id"));
    setDocTitle(valueOf(doc, "title"));
    setDocType(valueOf(doc, "docType") || "faq");
    setDocContent(valueOf(doc, "content"));
    setDocSku("");
    setTab("knowledge");
  }

  function editSkuKnowledge(sku: AnyRecord) {
    const cells = [
      valueOf(sku, "sku"),
      valueOf(sku, "itemId"),
      valueOf(sku, "title"),
      valueOf(sku, "sellingPoints"),
      valueOf(sku, "faq"),
      valueOf(sku, "warrantyPolicy"),
      valueOf(sku, "invoicePolicy"),
      valueOf(sku, "shippingNotes"),
      valueOf(sku, "returnPolicy")
    ].map((cell) => `"${cell.replace(/"/g, '""')}"`);
    setProductText(`sku,itemId,title,sellingPoints,faq,warrantyPolicy,invoicePolicy,shippingNotes,returnPolicy\n${cells.join(",")}`);
    setTab("knowledge");
  }

  async function analyzeAftersaleThread() {
    if (!selectedThread) return;
    const result = await requestJson(apiUrl, `/aftersale/threads/${valueOf(selectedThread, "id")}/analyze`, {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop })
    });
    const updatedThread = result.thread as AnyRecord | undefined;
    if (updatedThread?.id) {
      setThreads((current) => current.map((thread) => valueOf(thread, "id") === valueOf(updatedThread, "id") ? { ...thread, ...updatedThread } : thread));
      setSelectedThreadId(valueOf(updatedThread, "id"));
    }
    setAftersaleReplyText("");
    setAftersaleReferences(asList(result, "ragHits"));
  }

  async function sendAftersaleDryRun() {
    if (!selectedThread) return;
    const replyText = aftersaleReplyText.trim() || valueOf(selectedThread, "suggestedReply");
    await requestJson(apiUrl, `/aftersale/threads/${valueOf(selectedThread, "id")}/send`, {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop, replyText })
    });
  }

  async function deleteAftersaleThread(id: string) {
    if (!id || !window.confirm("删除这条售后工单及其消息记录？")) return;
    await requestJson(apiUrl, `/aftersale/threads/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ shopId: selectedShop })
    });
    setSelectedThreadId("");
    setAftersaleReplyText("");
  }

  function editTemplate(template: AnyRecord) {
    setEditingTemplateId(valueOf(template, "id"));
    setTemplateName(valueOf(template, "name"));
    setTemplateIntent(valueOf(template, "intentCode"));
    setTemplateContent(valueOf(template, "content"));
  }

  async function deleteTemplate(id: string, name: string) {
    if (!id || !window.confirm(`删除预设回复「${name || id}」？`)) return;
    await requestJson(apiUrl, `/reply-templates/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ shopId: selectedShop })
    });
    if (editingTemplateId === id) setEditingTemplateId("");
  }

  async function seedQaScenario() {
    await requestJson(apiUrl, "/demo/qa/seed", {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop })
    });
  }

  async function simulatePresaleQuestion() {
    const result = await requestJson(apiUrl, "/demo/qa/presale", {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop })
    });
    setSelectedQuestionId(valueOf(result.question, "id"));
    setTab("consultations");
  }

  async function simulateAftersaleMessage() {
    const result = await requestJson(apiUrl, "/demo/qa/aftersale", {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop })
    });
    setSelectedThreadId(valueOf(result.thread, "id"));
    setTab("aftersale");
  }

  const navItems: Array<[Tab, string]> = [
    ["today", "今日工作"],
    ["consultations", "买家咨询"],
    ["aftersale", "售后处理"],
    ["reviews", "回复审核"],
    ["knowledge", "知识库"],
    ["templates", "预设回复"],
    ["stats", "处理统计"],
    ["shop", "店铺设置"]
  ];

  return (
    <main className="erp-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">M</span>
          <div>
            <strong>客服工作台</strong>
            <small>Mercado Libre</small>
          </div>
        </div>
        <nav>
          {navItems.map(([key, label]) => (
            <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>
          ))}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">当前店铺：{valueOf(currentShop, "nickname") || "本地演示店铺"}</p>
            <h1>{navItems.find(([key]) => key === tab)?.[1]}</h1>
          </div>
          <div className="top-actions">
            <select value={selectedShop} onChange={(event) => setSelectedShop(event.target.value)}>
              <option value="">自动选择店铺</option>
              {shops.map((shop) => <option key={valueOf(shop, "id")} value={valueOf(shop, "id")}>{valueOf(shop, "nickname") || valueOf(shop, "sellerId")}</option>)}
            </select>
            <button className="button secondary" disabled={busy} onClick={() => window.location.assign(`${apiUrl}/auth/meli/start`)}>授权 Mercado Libre</button>
            <button className="button secondary" disabled={busy} onClick={() => run("演示数据初始化", () => requestJson(apiUrl, "/demo/seed", { method: "POST", body: "{}" }))}>初始化演示数据</button>
            <button className="button secondary" disabled={busy} onClick={() => run("QA 场景导入", seedQaScenario)}>导入 QA 场景</button>
            <button className="icon-button" disabled={busy} title="刷新" onClick={() => run("刷新", refresh)}>↻</button>
          </div>
        </header>

        {message ? <div className={message.endsWith("完成") ? "notice ok" : "notice warn"}>{message}</div> : null}

        {tab === "today" && (
          <section className="page-grid">
            <div className="metric-grid">
              <div><span>待处理咨询</span><strong>{String(metrics.pendingConsultations ?? 0)}</strong></div>
              <div><span>待审核回复</span><strong>{String(metrics.pendingReviews ?? 0)}</strong></div>
              <div><span>售后待跟进</span><strong>{String(metrics.aftersaleFollowups ?? 0)}</strong></div>
              <div><span>知识库异常</span><strong>{String(metrics.knowledgeFailed ?? 0)}</strong></div>
              <div><span>今日已回复</span><strong>{String(metrics.todayReplied ?? 0)}</strong></div>
              <div><span>建议采纳率</span><strong>{String(metrics.adoptionRate ?? 0)}%</strong></div>
            </div>
            <div className="quick-actions">
              <button disabled={busy} onClick={() => run("模拟售前咨询", simulatePresaleQuestion)}>模拟售前咨询</button>
              <button disabled={busy} onClick={() => run("模拟售后消息", simulateAftersaleMessage)}>模拟售后消息</button>
              <button onClick={() => setTab("consultations")}>处理买家咨询</button>
              <button onClick={() => setTab("aftersale")}>处理售后问题</button>
              <button onClick={() => setTab("knowledge")}>上传知识库</button>
              <button onClick={() => setTab("reviews")}>查看待审核回复</button>
            </div>
            <div className="status-grid">
              {[
                ["平台连接", systemStatus.platformConnected],
                ["消息同步", systemStatus.messageSync],
                ["客服助手", systemStatus.assistant],
                ["知识库", systemStatus.knowledge],
                ["飞书提醒", feishu?.enabled]
              ].map(([label, ok]) => (
                <div className="status-item" key={String(label)}>
                  <span className={ok ? "dot ok" : "dot warn"} />
                  <strong>{String(label)}</strong>
                  <em>{ok ? "正常" : "待处理"}</em>
                </div>
              ))}
            </div>
          </section>
        )}

        {tab === "consultations" && (
          <section className="workbench three">
            <aside className="queue-panel">
              <h2>咨询队列</h2>
              <div className="mini-tabs"><button>全部</button><button>待处理</button><button>待审核</button><button>高风险</button></div>
              <button className="queue-action" disabled={busy} onClick={() => run("批量采纳低风险草稿", () => requestJson(apiUrl, "/presale/questions/bulk-approve", { method: "POST", body: JSON.stringify({ shopId: selectedShop }) }))}>批量采纳低风险草稿</button>
              <div className="queue-list">
                {questions.map((question) => (
                  <button
                    key={valueOf(question, "id")}
                    className={`queue-card ${valueOf(question, "id") === valueOf(selectedQuestion, "id") ? "active" : ""}`}
                    onClick={() => setSelectedQuestionId(valueOf(question, "id"))}
                  >
                    <strong>{short(valueOf(question, "questionText"), 80)}</strong>
                    <span>{valueOf(question, "itemId")}</span>
                    <em>{statusText(valueOf(question, "reviewStatus"))} · 风险 {statusText(valueOf(question, "riskLevel"))}</em>
                  </button>
                ))}
                {!questions.length ? <div className="empty-state">暂无买家咨询</div> : null}
              </div>
            </aside>
            <article className="detail-panel">
              <h2>买家问题与商品信息</h2>
              {selectedQuestion ? (
                <>
                  <div className="message-card">{valueOf(selectedQuestion, "questionText") || "-"}</div>
                  <div className="columns">
                    <div className="label-block"><span>商品编号</span><strong>{valueOf(selectedQuestion, "itemId")}</strong></div>
                    <div className="label-block"><span>状态</span><strong>{statusText(valueOf(selectedQuestion, "questionStatus"))}</strong></div>
                  </div>
                  <h3>已上传商品资料</h3>
                  {skus.slice(0, 3).map((sku) => <div className="info-card" key={valueOf(sku, "id")}><strong>SKU：{valueOf(sku, "sku")}</strong><p>{valueOf(sku, "title")}</p></div>)}
                </>
              ) : <div className="empty-state">先初始化演示数据，或等待平台同步咨询</div>}
            </article>
            <aside className="assist-panel">
              <h2>售前 AI 回复</h2>
              <textarea className="reply-box" value={draftText} onChange={(event) => setDraftText(event.target.value)} placeholder="点击“生成 AI 草稿”后，这里会出现可审核、可编辑的回复。" />
              <h3>本次参考资料</h3>
              <ul className="plain-list">
                {(presaleReferences.length ? presaleReferences : documents.slice(0, 3)).map((item) => (
                  <li key={valueOf(item, "id") || valueOf(item, "title")}>
                    <strong>{valueOf(item, "title")}</strong>
                    <span> · {docTypeText(valueOf(item, "docType")) || valueOf(item, "source")}</span>
                    {valueOf(item, "content") ? <p>{short(valueOf(item, "content"), 150)}</p> : null}
                  </li>
                ))}
              </ul>
              <div className="action-stack">
                <div className="action-group">
                  <span>草稿处理</span>
                  <button disabled={!selectedQuestion || busy} onClick={() => run("生成 AI 草稿", generatePresaleDraft)}>生成 AI 草稿</button>
                  <button disabled={!selectedQuestion || busy || !draftText.trim()} onClick={() => run("采纳为回复", approvePresaleDraft)}>采纳为回复</button>
                </div>
                <div className="action-group">
                  <span>发送</span>
                  <button disabled={!selectedQuestion || busy || !draftText.trim()} onClick={() => run("模拟发送", sendPresaleDryRun)}>模拟发送</button>
                  <button disabled={!selectedQuestion || busy || !draftText.trim()} onClick={() => run("正式发送到平台", sendPresaleToMeli)}>正式发送到平台</button>
                  <button disabled={!selectedQuestion || busy} onClick={() => run("删除咨询", () => deletePresaleQuestion(valueOf(selectedQuestion, "id")))}>删除咨询</button>
                </div>
              </div>
            </aside>
          </section>
        )}

        {tab === "aftersale" && (
          <section className="workbench three">
            <aside className="queue-panel">
              <h2>售后队列</h2>
              <div className="mini-tabs"><button>全部</button><button>待跟进</button><button>转人工提醒</button><button>高风险</button></div>
              <div className="queue-list">
                {threads.map((thread) => (
                  <button
                    key={valueOf(thread, "id")}
                    className={`queue-card ${valueOf(thread, "id") === valueOf(selectedThread, "id") ? "active" : ""}`}
                    onClick={() => setSelectedThreadId(valueOf(thread, "id"))}
                  >
                    <strong>订单 {valueOf(thread, "orderId") || valueOf(thread, "packId")}</strong>
                    <span>{statusText(valueOf(thread, "category"))}</span>
                    <em>{statusText(valueOf(thread, "status"))} · 风险 {statusText(valueOf(thread, "riskLevel"))}</em>
                  </button>
                ))}
                {!threads.length ? <div className="empty-state">暂无售后工单</div> : null}
              </div>
            </aside>
            <article className="detail-panel">
              <h2>买家消息 / 订单 / 物流</h2>
              {selectedThread ? (
                <>
                  <div className="columns">
                    <div className="label-block"><span>包裹号</span><strong>{valueOf(selectedThread, "packId")}</strong></div>
                    <div className="label-block"><span>订单号</span><strong>{valueOf(selectedThread, "orderId") || "-"}</strong></div>
                  </div>
                  {(asList(selectedThread, "messages")).map((msg) => <div className="message-card" key={valueOf(msg, "id")}>{valueOf(msg, "text")}</div>)}
                </>
              ) : <div className="empty-state">暂无售后消息</div>}
            </article>
            <aside className="assist-panel">
              <h2>自动识别与兜底回复</h2>
              <div className="info-card"><strong>问题类型：{statusText(valueOf(selectedThread, "category"))}</strong><p>{valueOf(selectedThread, "suggestedAction") || "售后消息进入后会自动识别意图并路由到预设回复。"}</p></div>
              {valueOf(selectedThread, "suggestedReply") ? <div className="info-card"><strong>已路由预设回复</strong><p>{valueOf(selectedThread, "suggestedReply")}</p></div> : null}
              <textarea className="reply-box" value={aftersaleReplyText} onChange={(event) => setAftersaleReplyText(event.target.value)} placeholder="如需覆盖自动回复，在这里输入自定义内容；留空则使用上方已路由预设回复。" />
              <h3>处理依据</h3>
              <ul className="plain-list">
                <li>售后分析不调用售前 RAG 知识库，优先使用订单上下文、风险规则和预设回复自动兜底。</li>
                {valueOf(selectedThread, "category") ? <li>当前分类：{statusText(valueOf(selectedThread, "category"))}</li> : null}
                {valueOf(selectedThread, "category") === "human_request" ? <li>买家明确要求转人工，系统会先自动安抚并通过飞书提醒售后客服。</li> : null}
              </ul>
              <div className="button-row">
                <button disabled={!selectedThread || busy} onClick={() => run("售后分析", analyzeAftersaleThread)}>识别并自动路由</button>
                <button disabled={!selectedThread || busy || !valueOf(selectedThread, "suggestedReply")} onClick={() => setAftersaleReplyText(valueOf(selectedThread, "suggestedReply"))}>采用推荐编辑</button>
                <button disabled={!selectedThread || busy || !(aftersaleReplyText.trim() || valueOf(selectedThread, "suggestedReply"))} onClick={() => run("记录自动回复", sendAftersaleDryRun)}>记录自动回复</button>
                <button disabled={!selectedThread || busy} onClick={() => run("关闭售后", () => requestJson(apiUrl, `/aftersale/threads/${valueOf(selectedThread, "id")}/close`, { method: "POST", body: JSON.stringify({ shopId: selectedShop }) }))}>关闭</button>
                <button disabled={!selectedThread || busy} onClick={() => run("删除售后", () => deleteAftersaleThread(valueOf(selectedThread, "id")))}>删除</button>
              </div>
            </aside>
          </section>
        )}

        {tab === "reviews" && (
          <section className="table-wrap">
            <table>
              <thead><tr><th>来源</th><th>买家问题</th><th>推荐回复</th><th>风险</th><th>状态</th><th>参考资料</th></tr></thead>
              <tbody>
                {reviews.map((item) => (
                  <tr key={`${valueOf(item, "source")}-${valueOf(item, "id")}`}>
                    <td>{valueOf(item, "source")}</td>
                    <td>{short(valueOf(item, "buyerQuestion"), 120)}</td>
                    <td>{short(valueOf(item, "recommendedReply"), 180)}</td>
                    <td><span className={`pill ${valueOf(item, "riskLevel")}`}>{statusText(valueOf(item, "riskLevel"))}</span></td>
                    <td>{statusText(valueOf(item, "status"))}</td>
                    <td>{Array.isArray(item.references) ? item.references.join(" / ") : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {tab === "knowledge" && (
          <section className="knowledge-layout">
            <article>
              <h2>售前商品资料</h2>
              <p className="muted">用于买家咨询的 AI 回复。支持 CSV 文本粘贴，字段可包含 SKU、商品名称、发票规则、保修政策、物流说明和退换货规则。</p>
              <div className="toolbar">
                <select value={csvEncoding} onChange={(event) => setCsvEncoding(event.target.value as CsvEncoding)} title="CSV 文件编码">
                  <option value="auto">自动识别编码</option>
                  <option value="utf-8">UTF-8</option>
                  <option value="gb18030">GBK / GB18030</option>
                  <option value="utf-16le">UTF-16 LE</option>
                  <option value="big5">Big5</option>
                </select>
                <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    decodeFile(file, csvEncoding)
                      .then((text) => {
                        setProductText(text);
                        setMessage("文件已读取，请检查预览内容后保存商品资料");
                      })
                      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
                  }
                }} />
              </div>
              <textarea value={productText} onChange={(event) => setProductText(event.target.value)} placeholder="粘贴或上传 CSV。字段示例：sku,itemId,title,sellingPoints,faq,warrantyPolicy,invoicePolicy,shippingNotes,returnPolicy" />
              <button disabled={busy} onClick={() => run("商品资料保存", saveProductKnowledge)}>保存商品资料</button>
            </article>
            <article>
              <h2>售前文本资料</h2>
              <p className="muted">只参与售前 AI 回复检索，不参与售后工单分析。售后请使用预设回复和人工处理流程。</p>
              <div className="form-grid">
                <input value={docTitle} onChange={(event) => setDocTitle(event.target.value)} placeholder="资料名称" />
                <select value={docType} onChange={(event) => setDocType(event.target.value)}>
                  <option value="product">商品说明</option><option value="invoice">发票规则</option><option value="warranty">保修政策</option><option value="shipping">物流说明</option><option value="return">退换货规则</option><option value="faq">常见问题</option><option value="presale">售前话术</option>
                </select>
                <input value={docSku} onChange={(event) => setDocSku(event.target.value)} placeholder="关联 SKU" />
              </div>
              <textarea value={docContent} onChange={(event) => setDocContent(event.target.value)} placeholder="输入售前文本资料内容。该内容只参与售前 RAG 检索，不参与售后回复。" />
              <button disabled={busy} onClick={() => run(editingDocumentId ? "文本资料更新" : "文本资料保存", saveDocument)}>{editingDocumentId ? "更新文本资料" : "保存文本资料"}</button>
              {editingDocumentId ? <button disabled={busy} onClick={() => { setEditingDocumentId(""); setDocTitle(""); setDocContent(""); }}>取消编辑</button> : null}
            </article>
            <article>
              <h2>售前匹配测试</h2>
              <p className="muted">输入买家咨询，检查 AI 回复前会命中的商品资料和文本资料。</p>
              <textarea value={referenceQuery} onChange={(event) => setReferenceQuery(event.target.value)} placeholder="输入一条买家售前咨询，用来测试会命中哪些知识库资料。" />
              <button disabled={busy} onClick={() => run("参考资料匹配", searchReferences)}>查看匹配结果</button>
              <div className="hit-list">
                {referenceHits.map((hit) => <div className="hit" key={valueOf(hit, "id")}><strong>{valueOf(hit, "title")} · 匹配度 {matchText(valueOf(hit, "score"))}</strong><p>{short(valueOf(hit, "content"), 180)}</p></div>)}
              </div>
            </article>
            <section className="table-wrap full">
              <h2>商品资料列表</h2>
              <table>
                <thead><tr><th>SKU</th><th>商品名称</th><th>Item ID</th><th>发票/保修</th><th>最近更新</th><th>操作</th></tr></thead>
                <tbody>
                  {skus.map((sku) => (
                    <tr key={valueOf(sku, "id")}>
                      <td>{valueOf(sku, "sku")}</td>
                      <td>{valueOf(sku, "title")}</td>
                      <td>{valueOf(sku, "itemId") || "-"}</td>
                      <td>{short([valueOf(sku, "invoicePolicy"), valueOf(sku, "warrantyPolicy")].filter(Boolean).join(" / "), 160) || "-"}</td>
                      <td>{valueOf(sku, "updatedAt").slice(0, 10)}</td>
                      <td><button disabled={busy} onClick={() => editSkuKnowledge(sku)}>编辑</button> <button disabled={busy} onClick={() => run("删除商品资料", () => deleteSkuKnowledge(valueOf(sku, "id"), valueOf(sku, "sku") || valueOf(sku, "title")))}>删除</button></td>
                    </tr>
                  ))}
                  {!skus.length ? <tr><td colSpan={6}>暂无商品资料</td></tr> : null}
                </tbody>
              </table>
            </section>
            <section className="table-wrap full">
              <h2>文本资料列表</h2>
              <table>
                <thead><tr><th>资料名称</th><th>类型</th><th>状态</th><th>片段数</th><th>最近更新</th><th>操作</th></tr></thead>
                <tbody>
                  {documents.map((doc) => (
                    <tr key={valueOf(doc, "id")}>
                      <td>{valueOf(doc, "title")}</td>
                      <td>{docTypeText(valueOf(doc, "docType"))}</td>
                      <td>{statusText(valueOf(doc, "status"))}</td>
                      <td>{asList(doc, "chunks").length}</td>
                      <td>{valueOf(doc, "updatedAt").slice(0, 10)}</td>
                      <td><button disabled={busy} onClick={() => editDocument(doc)}>编辑</button> <button disabled={busy} onClick={() => run("删除文本资料", () => deleteDocument(valueOf(doc, "id"), valueOf(doc, "title")))}>删除</button></td>
                    </tr>
                  ))}
                  {!documents.length ? <tr><td colSpan={6}>暂无文本资料</td></tr> : null}
                </tbody>
              </table>
            </section>
          </section>
        )}

        {tab === "templates" && (
          <section className="split">
            <article>
              <h2>维护预设回复</h2>
              <div className="form-grid compact"><input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="回复名称" /><input value={templateIntent} onChange={(event) => setTemplateIntent(event.target.value)} placeholder="问题类型" /></div>
              <textarea value={templateContent} onChange={(event) => setTemplateContent(event.target.value)} placeholder="输入售后自动兜底回复。买家消息会先识别意图，再路由到匹配的预设回复。" />
              <button disabled={busy} onClick={() => run(editingTemplateId ? "预设回复更新" : "预设回复保存", saveTemplate)}>{editingTemplateId ? "更新预设回复" : "保存预设回复"}</button>
              {editingTemplateId ? <button disabled={busy} onClick={() => setEditingTemplateId("")}>取消编辑</button> : null}
            </article>
            <section className="table-wrap">
              <table>
                <thead><tr><th>回复名称</th><th>问题类型</th><th>语言</th><th>启用</th><th>操作</th></tr></thead>
                <tbody>
                  {templates.map((template) => <tr key={valueOf(template, "id")}><td>{valueOf(template, "name")}</td><td>{valueOf(template, "intentCode")}</td><td>{valueOf(template, "language")}</td><td>{valueOf(template, "active") === "true" ? "是" : "否"}</td><td><button onClick={() => editTemplate(template)}>编辑</button> <button onClick={() => run("状态切换", () => requestJson(apiUrl, `/reply-templates/${valueOf(template, "id")}/toggle`, { method: "POST", body: JSON.stringify({ shopId: selectedShop }) }))}>启停</button> <button onClick={() => run("删除预设回复", () => deleteTemplate(valueOf(template, "id"), valueOf(template, "name")))}>删除</button></td></tr>)}
                </tbody>
              </table>
            </section>
          </section>
        )}

        {tab === "stats" && (
          <section className="columns">
            <article><h2>处理统计</h2><div className="stat-list"><div>今日已回复：{String(metrics.todayReplied ?? 0)}</div><div>建议采纳率：{String(metrics.adoptionRate ?? 0)}%</div><div>高风险售后：{String(metrics.highRisk ?? 0)}</div><div>可用预设回复：{String(metrics.templateCount ?? 0)}</div></div></article>
            <article><h2>操作记录</h2><div className="timeline">{logs.slice(0, 10).map((log) => <div key={valueOf(log, "id")}><strong>{valueOf(log, "action")}</strong><span>{valueOf(log, "createdAt").slice(0, 19).replace("T", " ")}</span></div>)}</div></article>
          </section>
        )}

        {tab === "shop" && (
          <section className="columns">
            <article>
              <h2>店铺授权</h2>
              <p className="muted">授权后系统才能同步平台咨询、订单和售后消息。开发者应用信息由后端环境变量保存，前端只负责发起授权。</p>
              <button className="button" onClick={() => window.location.assign(`${apiUrl}/auth/meli/start`)}>打开授权页面</button>
              <div className="info-card"><strong>平台连接：{systemStatus.platformConnected ? "正常" : "待授权"}</strong><p>{valueOf(currentShop, "nickname") || "尚未选择店铺"}</p></div>
            </article>
            <article>
              <h2>飞书提醒</h2>
              <p className="muted">填写群机器人地址后，售前通知和售后转人工请求会推送到飞书。</p>
              <input value={feishuUrl} onChange={(event) => setFeishuUrl(event.target.value)} placeholder={valueOf(feishu, "webhookUrlMasked") || "飞书机器人地址"} />
              <input value={feishuSecret} onChange={(event) => setFeishuSecret(event.target.value)} placeholder={feishu?.secretConfigured ? "签名密钥已保存，留空不改" : "签名密钥（可选）"} />
              <div className="button-row">
                <button disabled={busy} onClick={() => run("飞书配置保存", saveFeishu)}>保存</button>
                <button disabled={busy} onClick={() => run("飞书测试", () => requestJson(apiUrl, "/settings/feishu-webhook/test", { method: "POST", body: JSON.stringify({ shopId: selectedShop }) }))}>发送测试消息</button>
              </div>
            </article>
            <article>
              <h2>客服助手设置</h2>
              <p className="muted">售后默认全自动兜底：先识别意图，再路由到预设回复。只有买家明确要求转人工时提醒客服。</p>
              <select value={autoMode} onChange={(event) => setAutoMode(event.target.value)}>
                <option value="all_templates">售后全部按预设自动兜底</option>
                <option value="low_risk_templates_only">仅低风险自动处理</option>
                <option value="off">关闭自动处理</option>
              </select>
              <button disabled={busy} onClick={() => run("客服助手设置保存", saveAutomation)}>保存设置</button>
              <div className="info-card"><strong>当前模式：{automation?.autoReplyMode === "off" ? "关闭自动处理" : "已开启售后自动兜底"}</strong><p>高风险售后也会自动回复；转人工意图会额外推送飞书。</p></div>
            </article>
          </section>
        )}
      </section>
    </main>
  );
}
