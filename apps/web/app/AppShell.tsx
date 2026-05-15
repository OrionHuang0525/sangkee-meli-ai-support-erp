"use client";

import { useEffect, useMemo, useState } from "react";

type Tab = "today" | "consultations" | "aftersale" | "reviews" | "knowledge" | "templates" | "stats" | "shop";
type AnyRecord = Record<string, unknown>;
type CsvEncoding = "auto" | "utf-8" | "gb18030" | "utf-16le" | "big5";
type FileDraft = {
  fileName: string;
  fileType: string;
  mimeType: string;
  sizeLabel: string;
  preview: string;
};

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
    human_pending: "人工待处理",
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
    other: "未识别问题",
    buyer_requested_human: "买家要求人工",
    invoice_required: "开票待人工",
    unmatched_other: "未识别问题",
    ai_escalation: "风险规则转人工",
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

function asChart(value: unknown, key: string): AnyRecord[] {
  return asList<AnyRecord>(value, key).filter((item) => Number(valueOf(item, "value")) > 0);
}

function chartMax(items: AnyRecord[]) {
  return Math.max(1, ...items.map((item) => Number(valueOf(item, "value") || 0)));
}

function percentOf(value: string, max: number) {
  const number = Number(value || 0);
  if (number <= 0) return "0%";
  return `${Math.max(4, Math.round((number / max) * 100))}%`;
}

function displayDateTime(value: string) {
  if (!value) return "";
  return value.replace("T", " ").slice(0, 16);
}

function messageRole(message: AnyRecord) {
  const direction = valueOf(message, "direction");
  if (direction === "outbound") return "assistant";
  if (direction === "system") return "system";
  return "customer";
}

function isAftersaleHandoffThread(thread: unknown) {
  return valueOf(thread, "handoffRequired") === "true" || ["human_request", "invoice_request", "other"].includes(valueOf(thread, "category"));
}

function messageRoleText(role: string, thread?: unknown) {
  if (role === "assistant") return isAftersaleHandoffThread(thread) ? "客服人工回复" : "系统自动回复";
  if (role === "system") return "系统记录";
  return "买家消息";
}

function aftersaleReplyHeading(thread: unknown) {
  if (!thread) return "待处理回复";
  return isAftersaleHandoffThread(thread) ? "人工处理回复" : "已路由预设回复";
}

function aftersaleDraftLabel(thread: unknown) {
  return isAftersaleHandoffThread(thread) ? "待发送人工回复" : "待发送自动回复";
}

function presaleReplyLabel(question: AnyRecord) {
  const status = valueOf(question, "reviewStatus");
  if (status === "sent") return "已正式发送到平台";
  if (status === "approved" || valueOf(question, "finalAnswer")) return "待发送回复";
  if (valueOf(question, "aiDraft")) return "AI 草稿，待审核";
  return "";
}

async function requestJson(apiUrl: string, path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-User-Email": "local-admin@local",
        ...(init?.headers || {})
      }
    });
  } catch {
    throw new Error(`无法连接客服后端。请确认 API 服务已启动，并且前端配置的地址是 ${apiUrl}`);
  }

  const text = await response.text();
  let data: AnyRecord = {};
  try {
    data = text ? JSON.parse(text) as AnyRecord : {};
  } catch {
    throw new Error(response.ok ? "后端返回了无法识别的内容" : `后端请求失败：HTTP ${response.status}`);
  }
  if (!response.ok || data.success === false) throw new Error(String(data.message || `HTTP ${response.status}`));
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

function isWorkbookBuffer(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer.slice(0, 4));
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

function extensionOf(fileName: string) {
  return fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
}

function formatFileSize(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function fileTypeLabel(extension: string) {
  const map: Record<string, string> = {
    csv: "CSV 商品表",
    txt: "文本资料",
    xlsx: "Excel 商品表",
    xls: "Excel 商品表",
    pdf: "PDF 文档",
    docx: "Word 文档"
  };
  return map[extension] || "未知文件";
}

function canUseAsProductFile(extension: string) {
  return ["csv", "txt", "xlsx", "xls"].includes(extension);
}

function canUseAsDocumentFile(extension: string) {
  return ["txt", "pdf", "docx"].includes(extension);
}

async function decodeFile(file: File, encoding: CsvEncoding) {
  const buffer = await file.arrayBuffer();
  if (isWorkbookBuffer(buffer)) {
    return {
      kind: "workbook" as const,
      fileName: file.name,
      mimeType: file.type,
      sizeLabel: formatFileSize(file.size),
      base64: arrayBufferToBase64(buffer),
      preview: `已选择 Excel 工作簿：${file.name}\n保存后会解析多工作表，并生成可用于售前回复的商品资料。`
    };
  }

  if (encoding !== "auto") return { kind: "text" as const, text: decodeBuffer(buffer, encoding).replace(/^\uFEFF/, "") };

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
  if (best) return { kind: "text" as const, text: best.text };

  try {
    return { kind: "text" as const, text: new TextDecoder("gb18030").decode(buffer) };
  } catch {
    return { kind: "text" as const, text: new TextDecoder("utf-8").decode(buffer) };
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
  const [feishu, setFeishu] = useState<AnyRecord | null>(null);
  const [automation, setAutomation] = useState<AnyRecord | null>(null);
  const [selectedShop, setSelectedShop] = useState("");
  const [productText, setProductText] = useState("");
  const [productFileBase64, setProductFileBase64] = useState("");
  const [productFileName, setProductFileName] = useState("");
  const [productFileMimeType, setProductFileMimeType] = useState("");
  const [productFileInfo, setProductFileInfo] = useState<FileDraft | null>(null);
  const [docTitle, setDocTitle] = useState("");
  const [docType, setDocType] = useState("invoice");
  const [docSku, setDocSku] = useState("");
  const [docContent, setDocContent] = useState("");
  const [docFileBase64, setDocFileBase64] = useState("");
  const [docFileName, setDocFileName] = useState("");
  const [docFileMimeType, setDocFileMimeType] = useState("");
  const [docFileInfo, setDocFileInfo] = useState<FileDraft | null>(null);
  const [referenceQuery, setReferenceQuery] = useState("");
  const [referenceHits, setReferenceHits] = useState<AnyRecord[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templateIntent, setTemplateIntent] = useState("");
  const [templateContent, setTemplateContent] = useState("");
  const [editingTemplateId, setEditingTemplateId] = useState("");
  const [editingDocumentId, setEditingDocumentId] = useState("");
  const [feishuUrl, setFeishuUrl] = useState("");
  const [feishuSecret, setFeishuSecret] = useState("");
  const [autoMode, setAutoMode] = useState("low_risk_templates_only");
  const [selectedQuestionId, setSelectedQuestionId] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [aftersaleFilter, setAftersaleFilter] = useState<"all" | "open" | "handoff" | "high">("all");
  const [csvEncoding, setCsvEncoding] = useState<CsvEncoding>("auto");
  const [draftText, setDraftText] = useState("");
  const [aftersaleReplyText, setAftersaleReplyText] = useState("");
  const [presaleReferences, setPresaleReferences] = useState<AnyRecord[]>([]);
  const [aftersaleReferences, setAftersaleReferences] = useState<AnyRecord[]>([]);
  const [message, setMessage] = useState("");
  const [apiConnected, setApiConnected] = useState(true);
  const [busy, setBusy] = useState(false);

  const metrics = useMemo(() => dashboard?.metrics as AnyRecord | undefined || {}, [dashboard]);
  const charts = useMemo(() => dashboard?.charts as AnyRecord | undefined || {}, [dashboard]);
  const categoryChart = useMemo(() => asChart(charts, "categoryBreakdown"), [charts]);
  const statusChart = useMemo(() => asChart(charts, "statusBreakdown"), [charts]);
  const handoffChart = useMemo(() => asChart(charts, "handoffBreakdown"), [charts]);
  const dailyChart = useMemo(() => asList<AnyRecord>(charts, "dailyProcessed"), [charts]);
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
  const filteredThreads = useMemo(() => {
    if (aftersaleFilter === "open") return threads.filter((thread) => valueOf(thread, "status") === "open");
    if (aftersaleFilter === "handoff") return threads.filter((thread) => valueOf(thread, "handoffRequired") === "true" || valueOf(thread, "status") === "human_pending");
    if (aftersaleFilter === "high") return threads.filter((thread) => valueOf(thread, "riskLevel") === "high");
    return threads;
  }, [threads, aftersaleFilter]);
  const shopQuery = selectedShop ? `?shopId=${encodeURIComponent(selectedShop)}` : "";

  function replaceThread(updatedThread: AnyRecord | undefined) {
    if (!updatedThread?.id) return;
    setThreads((current) => current.map((thread) => valueOf(thread, "id") === valueOf(updatedThread, "id") ? { ...thread, ...updatedThread } : thread));
    setSelectedThreadId(valueOf(updatedThread, "id"));
  }

  async function refresh() {
    const [nextDashboard, nextShops, nextSkus, nextDocs, nextQuestions, nextThreads, nextTemplates, nextReviews, nextFeishu, nextAutomation] = await Promise.all([
      requestJson(apiUrl, `/dashboard${shopQuery}`),
      requestJson(apiUrl, "/shops"),
      requestJson(apiUrl, `/kb/skus${shopQuery}`),
      requestJson(apiUrl, `/kb/documents${shopQuery}`),
      requestJson(apiUrl, `/presale/questions${shopQuery}`),
      requestJson(apiUrl, `/aftersale/threads${shopQuery}`),
      requestJson(apiUrl, `/reply-templates${shopQuery}`),
      requestJson(apiUrl, `/reply-reviews${shopQuery}`),
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
    const nextPolicy = nextAutomation.policy && typeof nextAutomation.policy === "object" ? nextAutomation.policy as AnyRecord : null;
    setFeishu(nextFeishu);
    setAutomation(nextPolicy);
    setAutoMode(String(nextPolicy?.autoReplyMode || "low_risk_templates_only"));
    setApiConnected(true);
    const nextShop = nextDashboard.shop && typeof nextDashboard.shop === "object" ? nextDashboard.shop as AnyRecord : null;
    if (!selectedShop && nextShop?.id) setSelectedShop(String(nextShop.id));
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
      const nextMessage = error instanceof Error ? error.message : String(error);
      if (nextMessage.includes("无法连接客服后端")) setApiConnected(false);
      setMessage(nextMessage);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refresh().catch((error) => {
      setApiConnected(false);
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }, [selectedShop]);

  useEffect(() => {
    setDraftText(selectedQuestion ? valueOf(selectedQuestion, "finalAnswer") || valueOf(selectedQuestion, "aiDraft") : "");
    setPresaleReferences([]);
  }, [selectedQuestion?.id]);

  useEffect(() => {
    setAftersaleReplyText(selectedThread ? valueOf(selectedThread, "suggestedReply") : "");
    setAftersaleReferences([]);
  }, [selectedThread?.id]);

  async function handleProductFile(file: File) {
    const extension = extensionOf(file.name);
    if (!canUseAsProductFile(extension)) throw new Error("商品资料请上传 CSV、TXT 或 Excel 文件");
    const result = await decodeFile(file, csvEncoding);
    if (result.kind === "workbook") {
      setProductFileBase64(result.base64);
      setProductFileName(result.fileName);
      setProductFileMimeType(result.mimeType || file.type);
      setProductText(result.preview);
      setProductFileInfo({
        fileName: result.fileName,
        fileType: fileTypeLabel(extension),
        mimeType: result.mimeType || file.type,
        sizeLabel: result.sizeLabel,
        preview: result.preview
      });
      setMessage("Excel 文件已选择，保存后会解析为商品资料");
      return;
    }

    setProductFileBase64("");
    setProductFileName("");
    setProductFileMimeType("");
    setProductText(result.text);
    setProductFileInfo({
      fileName: file.name,
      fileType: fileTypeLabel(extension),
      mimeType: file.type,
      sizeLabel: formatFileSize(file.size),
      preview: short(result.text.replace(/\s+/g, " "), 240)
    });
    setMessage("文件已读取，请检查预览内容后保存商品资料");
  }

  async function handleDocumentFile(file: File) {
    const extension = extensionOf(file.name);
    if (!canUseAsDocumentFile(extension)) throw new Error("文本资料请上传 TXT、PDF 或 DOCX 文件");
    const buffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    const decoded = extension === "txt" ? await decodeFile(file, csvEncoding) : null;
    const textPreview = decoded?.kind === "text" ? decoded.text : "";
    setEditingDocumentId("");
    setDocFileBase64(base64);
    setDocFileName(file.name);
    setDocFileMimeType(file.type);
    if (!docTitle) setDocTitle(titleFromFileName(file.name));
    if (textPreview) setDocContent(textPreview);
    setDocFileInfo({
      fileName: file.name,
      fileType: fileTypeLabel(extension),
      mimeType: file.type,
      sizeLabel: formatFileSize(file.size),
      preview: textPreview ? short(textPreview.replace(/\s+/g, " "), 240) : "保存后由后端提取文档文字，并生成售前回复依据。"
    });
    setMessage(`${fileTypeLabel(extension)} 已选择，保存后会生成售前回复依据`);
  }

  function titleFromFileName(fileName: string) {
    return fileName.replace(/\.[^.]+$/, "").trim() || "售前资料";
  }

  function clearDocumentFile() {
    setDocFileBase64("");
    setDocFileName("");
    setDocFileMimeType("");
    setDocFileInfo(null);
  }

  async function saveProductKnowledge() {
    await requestJson(apiUrl, "/kb/skus/import", {
      method: "POST",
      body: JSON.stringify(productFileBase64
        ? { shopId: selectedShop, fileBase64: productFileBase64, fileName: productFileName, mimeType: productFileMimeType, encoding: csvEncoding }
        : { shopId: selectedShop, csv: productText, encoding: csvEncoding })
    });
    setProductFileBase64("");
    setProductFileName("");
    setProductFileMimeType("");
    setProductFileInfo(null);
    setProductText("");
  }

  async function saveDocument() {
    const body = docFileBase64 && !editingDocumentId
      ? { shopId: selectedShop, title: docTitle, docType, sku: docSku, fileBase64: docFileBase64, fileName: docFileName, mimeType: docFileMimeType, encoding: csvEncoding }
      : { shopId: selectedShop, title: docTitle, docType, sku: docSku, content: docContent };
    await requestJson(apiUrl, editingDocumentId ? `/kb/documents/${editingDocumentId}` : "/kb/documents/import", {
      method: editingDocumentId ? "PATCH" : "POST",
      body: JSON.stringify(body)
    });
    setEditingDocumentId("");
    setDocTitle("");
    setDocContent("");
    clearDocumentFile();
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
    const result = await requestJson(apiUrl, "/settings/feishu-webhook", {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop, webhookUrl: feishuUrl, secret: feishuSecret, enabled: true, notifyPresale: true, notifyAftersale: true })
    });
    setFeishu(result);
    setFeishuUrl("");
    setFeishuSecret("");
  }

  async function setFeishuEnabled(enabled: boolean) {
    const result = await requestJson(apiUrl, "/settings/feishu-webhook", {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop, enabled, notifyPresale: true, notifyAftersale: true })
    });
    setFeishu(result);
  }

  async function deleteFeishu() {
    if (!window.confirm("删除当前飞书机器人配置？")) return;
    const result = await requestJson(apiUrl, "/settings/feishu-webhook", {
      method: "DELETE",
      body: JSON.stringify({ shopId: selectedShop })
    });
    setFeishu(result);
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
    clearDocumentFile();
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
    setProductFileBase64("");
    setProductFileName("");
    setProductFileMimeType("");
    setProductFileInfo(null);
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
      replaceThread(updatedThread);
    }
    setAftersaleReplyText(valueOf(updatedThread, "suggestedReply"));
    setAftersaleReferences(asList(result, "ragHits"));
  }

  async function sendAftersaleMessage() {
    if (!selectedThread) return;
    const threadId = valueOf(selectedThread, "id");
    let thread = selectedThread;
    let replyText = aftersaleReplyText.trim() || valueOf(thread, "suggestedReply").trim();

    if (!replyText) {
      const analyzed = await requestJson(apiUrl, `/aftersale/threads/${threadId}/analyze`, {
        method: "POST",
        body: JSON.stringify({ shopId: selectedShop, dispatch: true })
      });
      const updatedThread = analyzed.thread as AnyRecord | undefined;
      if (updatedThread?.id) {
        thread = { ...thread, ...updatedThread };
        replaceThread(updatedThread);
        setAftersaleReplyText(valueOf(updatedThread, "suggestedReply"));
      }
      setAftersaleReferences(asList(analyzed, "ragHits"));
      replyText = valueOf(thread, "suggestedReply").trim();
    }
    if (!replyText) throw new Error("没有可发送的售后回复，请先填写本次人工回复或维护对应预设回复。");
    const sent = await requestJson(apiUrl, `/aftersale/threads/${threadId}/send`, {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop, replyText, dryRun: false, allowLocalRecord: true })
    });
    const sentThread = sent.thread as AnyRecord | undefined;
    if (sentThread?.id) {
      replaceThread(sentThread);
      setAftersaleReplyText("");
    }
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

  async function deleteReviewItem(item: AnyRecord) {
    const id = valueOf(item, "id");
    if (!id) return;
    if (valueOf(item, "targetType") === "presale_question") {
      await deletePresaleQuestion(id);
      return;
    }
    if (valueOf(item, "targetType") === "aftersale_thread") {
      await deleteAftersaleThread(id);
    }
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

        {!apiConnected ? (
          <div className="notice warn">
            后端服务未连接。当前页面可查看和编辑草稿，但保存、同步、匹配测试需要先启动 API 服务。
          </div>
        ) : null}
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
              <h2>售前对话闭环</h2>
              {selectedQuestion ? (
                <>
                  <div className="columns">
                    <div className="label-block"><span>商品编号</span><strong>{valueOf(selectedQuestion, "itemId")}</strong></div>
                    <div className="label-block"><span>状态</span><strong>{statusText(valueOf(selectedQuestion, "questionStatus"))}</strong></div>
                  </div>
                  <div className="conversation-stream">
                    <div className="bubble customer">
                      <div className="bubble-head"><span>买家消息</span>{valueOf(selectedQuestion, "createdAt") ? <em>{displayDateTime(valueOf(selectedQuestion, "createdAt"))}</em> : null}</div>
                      <p>{valueOf(selectedQuestion, "questionText") || "-"}</p>
                    </div>
                    {valueOf(selectedQuestion, "finalAnswer") || valueOf(selectedQuestion, "aiDraft") ? (
                      <div className={`bubble assistant ${valueOf(selectedQuestion, "finalAnswer") ? "sent" : "draft"}`}>
                        <div className="bubble-head"><span>{presaleReplyLabel(selectedQuestion)}</span>{valueOf(selectedQuestion, "sentAt") ? <em>{displayDateTime(valueOf(selectedQuestion, "sentAt"))}</em> : null}</div>
                        <p>{valueOf(selectedQuestion, "finalAnswer") || valueOf(selectedQuestion, "aiDraft")}</p>
                      </div>
                    ) : (
                      <div className="bubble system"><p>还没有生成或记录回复。右侧生成草稿后，可在这里核对买家问题与回复内容是否闭环。</p></div>
                    )}
                  </div>
                  <h3>已上传商品资料</h3>
                  {skus.slice(0, 3).map((sku) => <div className="info-card" key={valueOf(sku, "id")}><strong>SKU：{valueOf(sku, "sku")}</strong><p>{valueOf(sku, "title")}</p></div>)}
                </>
              ) : <div className="empty-state">先初始化演示数据，或等待平台同步咨询</div>}
            </article>
            <aside className="assist-panel">
              <h2>编辑回复</h2>
              <div className="reply-status">
                <strong>{selectedQuestion ? presaleReplyLabel(selectedQuestion) || "待生成回复" : "未选择咨询"}</strong>
                <span>{selectedQuestion ? statusText(valueOf(selectedQuestion, "reviewStatus")) : "-"}</span>
              </div>
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
                </div>
                <div className="action-group">
                  <span>发送</span>
                  <button disabled={!selectedQuestion || busy || !draftText.trim()} onClick={() => run("发送到平台", sendPresaleToMeli)}>发送到平台</button>
                  <button disabled={!selectedQuestion || busy} onClick={() => run("删除咨询", () => deletePresaleQuestion(valueOf(selectedQuestion, "id")))}>删除咨询</button>
                </div>
              </div>
            </aside>
          </section>
        )}

        {tab === "aftersale" && (
          <section className="workbench aftersale-workbench">
            <aside className="queue-panel">
              <h2>售后队列</h2>
              <div className="mini-tabs aftersale-filter">
                <button className={aftersaleFilter === "all" ? "active" : ""} onClick={() => setAftersaleFilter("all")}>全部</button>
                <button className={aftersaleFilter === "open" ? "active" : ""} onClick={() => setAftersaleFilter("open")}>待跟进</button>
                <button className={aftersaleFilter === "handoff" ? "active" : ""} onClick={() => setAftersaleFilter("handoff")}>转人工</button>
                <button className={aftersaleFilter === "high" ? "active" : ""} onClick={() => setAftersaleFilter("high")}>高风险</button>
              </div>
              <div className="mini-tabs"><button>全部</button><button>待跟进</button><button>转人工提醒</button><button>高风险</button></div>
              <div className="queue-list">
                {filteredThreads.map((thread) => (
                  <button
                    key={valueOf(thread, "id")}
                    className={`queue-card ${valueOf(thread, "id") === valueOf(selectedThread, "id") ? "active" : ""}`}
                    onClick={() => setSelectedThreadId(valueOf(thread, "id"))}
                  >
                    <strong>订单 {valueOf(thread, "orderId") || valueOf(thread, "packId")}</strong>
                    <span>{valueOf(thread, "handoffLabel") || statusText(valueOf(thread, "category"))}</span>
                    <em>{statusText(valueOf(thread, "status"))} · 风险 {statusText(valueOf(thread, "riskLevel"))} · {String(valueOf(thread, "messageCount") || asList(thread, "messages").length)} 条消息</em>
                  </button>
                ))}
                {!filteredThreads.length ? <div className="empty-state">暂无售后工单</div> : null}
              </div>
            </aside>
            <article className="detail-panel aftersale-detail">
              <h2>售后对话闭环</h2>
              {selectedThread ? (
                <>
                  <div className="columns">
                    <div className="label-block"><span>包裹号</span><strong>{valueOf(selectedThread, "packId")}</strong></div>
                    <div className="label-block"><span>订单号</span><strong>{valueOf(selectedThread, "orderId") || "-"}</strong></div>
                  </div>
                  {valueOf(selectedThread, "handoffRequired") === "true" ? <div className="handoff-banner">{valueOf(selectedThread, "handoffLabel") || "人工待处理"}</div> : null}
                  <div className="conversation-stream">
                    {(asList(selectedThread, "messages")).map((msg) => {
                      const record = msg as AnyRecord;
                      const role = messageRole(record);
                      return (
                        <div className={`bubble ${role}`} key={valueOf(record, "id")}>
                          <div className="bubble-head"><span>{messageRoleText(role, selectedThread)}</span>{valueOf(record, "messageDate") ? <em>{displayDateTime(valueOf(record, "messageDate"))}</em> : null}</div>
                          <p>{valueOf(record, "text") || "-"}</p>
                        </div>
                      );
                    })}
                    {!asList(selectedThread, "messages").some((msg) => messageRole(msg as AnyRecord) === "assistant") && valueOf(selectedThread, "suggestedReply") ? (
                      <div className="bubble assistant draft">
                        <div className="bubble-head"><span>{aftersaleDraftLabel(selectedThread)}</span></div>
                        <p>{valueOf(selectedThread, "suggestedReply")}</p>
                      </div>
                    ) : null}
                  </div>
                </>
              ) : <div className="empty-state">暂无售后消息</div>}
            </article>
            <aside className="assist-panel aftersale-composer">
              <h2>售后处理</h2>
              <div className="reply-status">
                <strong>{valueOf(selectedThread, "handoffLabel") || statusText(valueOf(selectedThread, "category"))}</strong>
                <span>{selectedThread ? `${statusText(valueOf(selectedThread, "status"))} · ${String(valueOf(selectedThread, "messageCount") || asList(selectedThread, "messages").length)} 条消息` : "-"}</span>
              </div>
              <div className="info-card"><strong>问题类型：{statusText(valueOf(selectedThread, "category"))}</strong><p>{valueOf(selectedThread, "suggestedAction") || "售后消息进入后会自动识别意图；需要人工的场景会进入人工处理。"}</p></div>
              {valueOf(selectedThread, "suggestedReply") ? <div className="info-card"><strong>{aftersaleReplyHeading(selectedThread)}</strong><p>{valueOf(selectedThread, "suggestedReply")}</p></div> : null}
              <textarea className="reply-box" value={aftersaleReplyText} onChange={(event) => setAftersaleReplyText(event.target.value)} placeholder={isAftersaleHandoffThread(selectedThread) ? "这里填写客服人工回复；发送后会同步到对话并关闭当前待处理项。" : "发送前可编辑本次自动回复内容。"} />
              <h3>处理依据</h3>
              <ul className="plain-list">
                <li>售后分析不使用售前回复依据，优先使用订单上下文、风险规则和售后处理规则。</li>
                {valueOf(selectedThread, "category") ? <li>当前分类：{statusText(valueOf(selectedThread, "category"))}</li> : null}
                {valueOf(selectedThread, "category") === "human_request" ? <li>买家明确要求转人工，本区显示的是客服人工回复，不属于预设回复路由。</li> : null}
                {valueOf(selectedThread, "category") === "invoice_request" ? <li>开票问题需要人工核对资料，本区显示的是人工处理回复，并通过飞书提醒客服。</li> : null}
                {valueOf(selectedThread, "category") === "other" ? <li>未识别问题不自动回复，通过飞书提醒人工处理。</li> : null}
                {valueOf(selectedThread, "category") && !["human_request", "invoice_request", "other"].includes(valueOf(selectedThread, "category")) ? <li>该类型按预设回复自动处理，不额外转人工。</li> : null}
              </ul>
              <div className="button-row">
                <button disabled={!selectedThread || busy} onClick={() => run("发送售后信息", sendAftersaleMessage)}>发送信息</button>
              </div>
            </aside>
          </section>
        )}

        {tab === "reviews" && (
          <section className="table-wrap">
            <table>
              <thead><tr><th>来源</th><th>买家问题</th><th>推荐回复</th><th>风险</th><th>状态</th><th>参考资料</th><th>操作</th></tr></thead>
              <tbody>
                {reviews.map((item) => (
                  <tr key={`${valueOf(item, "source")}-${valueOf(item, "id")}`}>
                    <td>{valueOf(item, "source")}</td>
                    <td>{short(valueOf(item, "buyerQuestion"), 120)}</td>
                    <td>{short(valueOf(item, "recommendedReply"), 180)}</td>
                    <td><span className={`pill ${valueOf(item, "riskLevel")}`}>{statusText(valueOf(item, "riskLevel"))}</span></td>
                    <td>{statusText(valueOf(item, "status"))}</td>
                    <td>{Array.isArray(item.references) ? item.references.join(" / ") : "-"}</td>
                    <td><button disabled={busy} onClick={() => run("删除审核项", () => deleteReviewItem(item))}>删除</button></td>
                  </tr>
                ))}
                {!reviews.length ? <tr><td colSpan={7}>暂无待审核信息</td></tr> : null}
              </tbody>
            </table>
          </section>
        )}

        {tab === "knowledge" && (
          <section className="knowledge-layout">
            <article
              className="upload-card"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files?.[0];
                if (file) handleProductFile(file).catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
              }}
            >
              <h2>售前商品资料</h2>
              <p className="muted">用于买家咨询的建议回复。可拖入 CSV、TXT 或 Excel，字段可包含 SKU、商品名称、发票规则、保修政策、物流说明和退换货规则。</p>
              <div className="toolbar">
                <select value={csvEncoding} onChange={(event) => setCsvEncoding(event.target.value as CsvEncoding)} title="CSV 文件编码">
                  <option value="auto">自动识别编码</option>
                  <option value="utf-8">UTF-8</option>
                  <option value="gb18030">GBK / GB18030</option>
                  <option value="utf-16le">UTF-16 LE</option>
                  <option value="big5">Big5</option>
                </select>
                <input aria-label="上传商品资料文件" type="file" accept=".csv,.txt,.xlsx,.xls,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    handleProductFile(file).catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
                  }
                }} />
              </div>
              {productFileInfo ? (
                <div className="file-summary">
                  <strong>{productFileInfo.fileName}</strong>
                  <span>{productFileInfo.fileType} · {productFileInfo.sizeLabel}</span>
                  <p>{productFileInfo.preview}</p>
                </div>
              ) : <div className="drop-hint">拖入商品资料文件，或直接粘贴表格内容。</div>}
              <textarea value={productText} onChange={(event) => { setProductText(event.target.value); setProductFileBase64(""); setProductFileName(""); setProductFileMimeType(""); setProductFileInfo(null); }} placeholder="粘贴或上传 CSV / Excel。字段示例：SKU,DESCRIPTION 或 sku,itemId,title,sellingPoints,faq,warrantyPolicy,invoicePolicy,shippingNotes,returnPolicy" />
              <button disabled={busy || (!productText.trim() && !productFileBase64)} onClick={() => run("商品资料保存", saveProductKnowledge)}>保存商品资料</button>
            </article>
            <article
              className="upload-card"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files?.[0];
                if (file) handleDocumentFile(file).catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
              }}
            >
              <h2>售前文本资料</h2>
              <p className="muted">只参与买家咨询的回复依据，不参与售后工单分析。支持 TXT、PDF、DOCX；PDF 和 Word 保存后由后端提取文字。</p>
              <div className="form-grid">
                <input value={docTitle} onChange={(event) => setDocTitle(event.target.value)} placeholder="资料名称" />
                <select value={docType} onChange={(event) => setDocType(event.target.value)}>
                  <option value="product">商品说明</option><option value="invoice">发票规则</option><option value="warranty">保修政策</option><option value="shipping">物流说明</option><option value="return">退换货规则</option><option value="faq">常见问题</option><option value="presale">售前话术</option>
                </select>
                <input value={docSku} onChange={(event) => setDocSku(event.target.value)} placeholder="关联 SKU" />
              </div>
              <input aria-label="上传文本资料文件" type="file" accept=".txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) handleDocumentFile(file).catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
              }} />
              {docFileInfo ? (
                <div className="file-summary">
                  <strong>{docFileInfo.fileName}</strong>
                  <span>{docFileInfo.fileType} · {docFileInfo.sizeLabel}</span>
                  <p>{docFileInfo.preview}</p>
                </div>
              ) : <div className="drop-hint">拖入文本资料文件，或直接输入内容。</div>}
              <textarea value={docContent} onChange={(event) => { setDocContent(event.target.value); clearDocumentFile(); }} placeholder="输入售前文本资料内容。该内容只参与买家咨询的回复依据，不参与售后回复。" />
              <button disabled={busy || (!docContent.trim() && !docFileBase64)} onClick={() => run(editingDocumentId ? "文本资料更新" : "文本资料保存", saveDocument)}>{editingDocumentId ? "更新文本资料" : "保存文本资料"}</button>
              {editingDocumentId ? <button disabled={busy} onClick={() => { setEditingDocumentId(""); setDocTitle(""); setDocContent(""); clearDocumentFile(); }}>取消编辑</button> : null}
            </article>
            <article>
              <h2>售前匹配测试</h2>
              <p className="muted">输入买家咨询，检查生成建议回复前会参考哪些商品资料和文本资料。</p>
              <textarea value={referenceQuery} onChange={(event) => setReferenceQuery(event.target.value)} placeholder="输入一条买家售前咨询，用来测试会命中哪些知识库资料。" />
              <button disabled={busy || !referenceQuery.trim()} onClick={() => run("参考资料匹配", searchReferences)}>查看匹配结果</button>
              <div className="hit-list">
                {referenceHits.map((hit) => {
                  const metadata = hit.metadata as AnyRecord | undefined;
                  const skuTags = Array.isArray(metadata?.sku_tags) ? metadata.sku_tags.join(", ") : "";
                  return (
                    <div className="hit" key={valueOf(hit, "id")}>
                      <strong>{valueOf(hit, "title")} · 匹配度 {matchText(valueOf(hit, "score"))}</strong>
                      <span>资料类型：{docTypeText(valueOf(hit, "docType"))}{skuTags ? ` · 关联 SKU：${skuTags}` : ""}</span>
                      <p>{short(valueOf(hit, "content"), 220)}</p>
                    </div>
                  );
                })}
                {!referenceHits.length ? <div className="empty-state compact">暂无匹配结果。请先保存资料，或换一个更接近买家原话的问题测试。</div> : null}
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
          <section className="stats-layout">
            <article className="full">
              <h2>处理统计</h2>
              <div className="stat-cards">
                <div><span>今日已回复</span><strong>{String(metrics.todayReplied ?? 0)}</strong></div>
                <div><span>建议采纳率</span><strong>{String(metrics.adoptionRate ?? 0)}%</strong></div>
                <div><span>人工待处理</span><strong>{String(metrics.humanPending ?? 0)}</strong></div>
                <div><span>开票待人工</span><strong>{String(metrics.invoiceHandoff ?? 0)}</strong></div>
                <div><span>高风险售后</span><strong>{String(metrics.highRisk ?? 0)}</strong></div>
                <div><span>可用预设回复</span><strong>{String(metrics.templateCount ?? 0)}</strong></div>
              </div>
            </article>
            <article>
              <h2>售后问题分布</h2>
              <div className="bar-list">
                {categoryChart.map((item) => {
                  const max = chartMax(categoryChart);
                  return <div className="bar-row" key={valueOf(item, "key")}><span>{valueOf(item, "label")}</span><div><i style={{ width: percentOf(valueOf(item, "value"), max) }} /></div><strong>{valueOf(item, "value")}</strong></div>;
                })}
                {!categoryChart.length ? <div className="empty-state compact">暂无售后分类数据</div> : null}
              </div>
            </article>
            <article>
              <h2>处理状态</h2>
              <div className="bar-list">
                {statusChart.map((item) => {
                  const max = chartMax(statusChart);
                  return <div className="bar-row" key={valueOf(item, "key")}><span>{valueOf(item, "label")}</span><div><i style={{ width: percentOf(valueOf(item, "value"), max) }} /></div><strong>{valueOf(item, "value")}</strong></div>;
                })}
                {!statusChart.length ? <div className="empty-state compact">暂无状态数据</div> : null}
              </div>
            </article>
            <article>
              <h2>转人工原因</h2>
              <div className="bar-list">
                {handoffChart.map((item) => {
                  const max = chartMax(handoffChart);
                  return <div className="bar-row" key={valueOf(item, "key")}><span>{valueOf(item, "label")}</span><div><i style={{ width: percentOf(valueOf(item, "value"), max) }} /></div><strong>{valueOf(item, "value")}</strong></div>;
                })}
                {!handoffChart.length ? <div className="empty-state compact">暂无转人工事项</div> : null}
              </div>
            </article>
            <article>
              <h2>近 7 天处理量</h2>
              <div className="mini-chart">
                {dailyChart.map((item) => (
                  <div key={valueOf(item, "date")}>
                    <span style={{ height: percentOf(valueOf(item, "value"), chartMax(dailyChart)) }} />
                    <strong>{valueOf(item, "value")}</strong>
                    <em>{valueOf(item, "date").slice(5)}</em>
                  </div>
                ))}
              </div>
            </article>
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
              <p className="muted">配置保存在后端数据库。开票和买家明确要求人工时，会推送到飞书。</p>
              <div className="info-card">
                <strong>{feishu?.configured ? `已保存：${valueOf(feishu, "webhookUrlMasked") || "机器人地址已加密保存"}` : "未配置飞书机器人"}</strong>
                <p>{feishu?.configured && feishu?.decryptable === false ? "当前 TOKEN_ENCRYPTION_KEY 无法解密已保存配置，请重新保存机器人地址。" : feishu?.enabled ? "当前已启用" : "当前未启用"}</p>
              </div>
              <input value={feishuUrl} onChange={(event) => setFeishuUrl(event.target.value)} placeholder={valueOf(feishu, "webhookUrlMasked") || "飞书机器人地址"} />
              <input value={feishuSecret} onChange={(event) => setFeishuSecret(event.target.value)} placeholder={feishu?.secretConfigured ? "签名密钥已保存，留空不改" : "签名密钥（可选）"} />
              <div className="button-row">
                <button disabled={busy} onClick={() => run("飞书配置保存", saveFeishu)}>保存</button>
                <button disabled={busy || !feishu?.configured || feishu?.decryptable === false} onClick={() => run(feishu?.enabled ? "飞书停用" : "飞书启用", () => setFeishuEnabled(!feishu?.enabled))}>{feishu?.enabled ? "停用" : "启用"}</button>
                <button disabled={busy || !feishu?.enabled} onClick={() => run("飞书测试", () => requestJson(apiUrl, "/settings/feishu-webhook/test", { method: "POST", body: JSON.stringify({ shopId: selectedShop }) }))}>发送测试消息</button>
                <button disabled={busy || !feishu?.configured} onClick={() => run("飞书配置删除", deleteFeishu)}>删除配置</button>
              </div>
            </article>
            <article>
              <h2>客服助手设置</h2>
              <p className="muted">售后建议先按风险分级处理。低风险可自动使用预设回复，高风险建议进入人工复核。</p>
              <select value={autoMode} onChange={(event) => setAutoMode(event.target.value)}>
                <option value="low_risk_templates_only">仅低风险自动处理</option>
                <option value="all_templates">全部按预设回复处理</option>
                <option value="off">关闭自动处理</option>
              </select>
              <button disabled={busy} onClick={() => run("客服助手设置保存", saveAutomation)}>保存设置</button>
              <div className="info-card">
                <strong>当前模式：{automation?.autoReplyMode === "off" ? "关闭自动处理" : automation?.autoReplyMode === "all_templates" ? "全部按预设回复处理" : "仅低风险自动处理"}</strong>
                <p>{automation?.autoReplyMode === "all_templates" ? "请确认预设回复和人工复核规则已经成熟，再用于真实发送。" : "高风险售后会保留人工复核空间，转人工意图可额外推送飞书。"}</p>
              </div>
            </article>
          </section>
        )}
      </section>
    </main>
  );
}
