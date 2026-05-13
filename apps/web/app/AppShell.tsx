"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

type Tab = "today" | "consultations" | "aftersale" | "reviews" | "knowledge" | "templates" | "stats" | "shop";

interface AppShellProps {
  apiUrl: string;
}

type AnyRecord = Record<string, unknown>;

function asList<T = AnyRecord>(value: unknown, key: string): T[] {
  if (value && typeof value === "object" && Array.isArray((value as AnyRecord)[key])) {
    return (value as Record<string, T[]>)[key];
  }
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
    dry_run_sent: "已记录发送",
    open: "待跟进",
    closed: "已关闭",
    low: "低",
    medium: "中",
    high: "高",
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
    policy: "店铺政策"
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
  if (!response.ok || data.success === false) {
    throw new Error(data.message || `HTTP ${response.status}`);
  }
  return data;
}

async function decodeFile(file: File) {
  const buffer = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  if (!utf8.includes("�") && !utf8.includes("锟")) return utf8;
  try {
    return new TextDecoder("gb18030").decode(buffer);
  } catch {
    return utf8;
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
  const [selectedShop, setSelectedShop] = useState("");
  const [productText, setProductText] = useState("sku,itemId,title,sellingPoints,faq,warrantyPolicy,invoicePolicy,shippingNotes,returnPolicy\nE10146,MLM-DEMO-E10146,Terport teclado gamer mecánico 90% RGB,\"Teclado gamer compacto con distribución en español y RGB\",\"Compatible con PC y laptops con USB\",\"Garantía por defectos de fabricación\",\"Facturamos con datos fiscales por chat\",\"Envío gestionado por Mercado Libre\",\"Revisar evidencia para cambios o devoluciones\"");
  const [docTitle, setDocTitle] = useState("发票与保修政策");
  const [docType, setDocType] = useState("invoice");
  const [docSku, setDocSku] = useState("E10146");
  const [docContent, setDocContent] = useState("SKU E10146 支持发票。买家下单后可以通过 Mercado Libre 聊天提供税务资料，客服再按店铺流程处理。保修只覆盖制造缺陷，不承诺平台外退款。");
  const [referenceQuery, setReferenceQuery] = useState("买家咨询 E10146 是否支持发票和保修");
  const [referenceHits, setReferenceHits] = useState<AnyRecord[]>([]);
  const [templateName, setTemplateName] = useState("物流未收到");
  const [templateIntent, setTemplateIntent] = useState("not_received");
  const [templateContent, setTemplateContent] = useState("Hola, lamentamos lo ocurrido. Te recomendamos revisar el estado del envío desde Mercado Libre. Si el paquete sigue sin actualizarse, por favor continúa el seguimiento desde el flujo oficial de la plataforma.");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const metrics = useMemo(() => dashboard?.metrics as AnyRecord | undefined || {}, [dashboard]);
  const systemStatus = useMemo(() => dashboard?.systemStatus as AnyRecord | undefined || {}, [dashboard]);
  const currentShop = useMemo(() => shops.find((shop) => valueOf(shop, "id") === selectedShop), [shops, selectedShop]);
  const shopQuery = selectedShop ? `?shopId=${encodeURIComponent(selectedShop)}` : "";

  async function refresh() {
    const [nextDashboard, nextShops, nextSkus, nextDocs, nextQuestions, nextThreads, nextTemplates, nextReviews, nextLogs] = await Promise.all([
      requestJson(apiUrl, `/dashboard${shopQuery}`),
      requestJson(apiUrl, "/shops"),
      requestJson(apiUrl, `/kb/skus${shopQuery}`),
      requestJson(apiUrl, `/kb/documents${shopQuery}`),
      requestJson(apiUrl, `/presale/questions${shopQuery}`),
      requestJson(apiUrl, `/aftersale/threads${shopQuery}`),
      requestJson(apiUrl, `/reply-templates${shopQuery}`),
      requestJson(apiUrl, `/reply-reviews${shopQuery}`),
      requestJson(apiUrl, `/operation-logs${shopQuery}`)
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
    if (!selectedShop && nextDashboard.shop?.id) setSelectedShop(String(nextDashboard.shop.id));
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

  async function saveProductKnowledge() {
    await requestJson(apiUrl, "/kb/skus/import", {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop, csv: productText })
    });
  }

  async function saveDocument() {
    await requestJson(apiUrl, "/kb/documents/import", {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop, title: docTitle, docType, sku: docSku, content: docContent })
    });
  }

  async function searchReferences() {
    const result = await requestJson(apiUrl, "/kb/search", {
      method: "POST",
      body: JSON.stringify({ shopId: selectedShop, query: referenceQuery, sku: docSku, limit: 8 })
    });
    setReferenceHits(asList(result, "hits"));
  }

  async function saveTemplate() {
    await requestJson(apiUrl, "/reply-templates", {
      method: "POST",
      body: JSON.stringify({
        shopId: selectedShop,
        name: templateName,
        intentCode: templateIntent,
        category: templateIntent,
        keywords: templateIntent.split("_"),
        content: templateContent,
        variables: ["orderId", "sku"]
      })
    });
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
            <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
              {label}
            </button>
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
              <div><span>知识库更新失败</span><strong>{String(metrics.knowledgeFailed ?? 0)}</strong></div>
              <div><span>今日已回复</span><strong>{String(metrics.todayReplied ?? 0)}</strong></div>
              <div><span>建议回复采纳率</span><strong>{String(metrics.adoptionRate ?? 0)}%</strong></div>
            </div>
            <section className="quick-actions">
              <button onClick={() => setTab("consultations")}>处理买家咨询</button>
              <button onClick={() => setTab("aftersale")}>处理售后问题</button>
              <button onClick={() => setTab("knowledge")}>上传知识库</button>
              <button onClick={() => setTab("reviews")}>查看待审核回复</button>
            </section>
            <section className="status-grid">
              <StatusItem label="平台连接" ok={Boolean(systemStatus.platformConnected)} />
              <StatusItem label="消息同步" ok={Boolean(systemStatus.messageSync)} />
              <StatusItem label="客服助手" ok={Boolean(systemStatus.assistant)} />
              <StatusItem label="知识库" ok={Boolean(systemStatus.knowledge)} />
            </section>
          </section>
        )}

        {tab === "consultations" && (
          <section className="workbench three">
            <QueuePanel title="咨询队列" tabs={["全部", "待处理", "待生成建议", "待审核", "已回复", "需要人工处理", "高风险"]}>
              {questions.map((question) => (
                <button key={valueOf(question, "id")} className="queue-card">
                  <strong>{short(valueOf(question, "questionText"), 72)}</strong>
                  <span>{valueOf(question, "itemId")}</span>
                  <em>{statusText(valueOf(question, "reviewStatus"))}</em>
                </button>
              ))}
            </QueuePanel>
            <DetailPanel title="买家问题与商品信息">
              {questions[0] ? (
                <>
                  <LabelBlock label="买家问题" value={valueOf(questions[0], "questionText")} />
                  <LabelBlock label="关联商品" value={valueOf(questions[0], "itemId")} />
                  <LabelBlock label="状态" value={statusText(valueOf(questions[0], "reviewStatus"))} />
                  <h3>商品资料</h3>
                  {skus.slice(0, 3).map((sku) => (
                    <div key={valueOf(sku, "id")} className="info-card">
                      <strong>{valueOf(sku, "sku")} · {valueOf(sku, "title")}</strong>
                      <p>发票规则：{short(valueOf(sku, "invoicePolicy"), 120) || "-"}</p>
                      <p>保修政策：{short(valueOf(sku, "warrantyPolicy"), 120) || "-"}</p>
                    </div>
                  ))}
                </>
              ) : <EmptyState text="暂无买家咨询" />}
            </DetailPanel>
            <AssistPanel title="建议回复">
              {questions[0] ? (
                <>
                  <textarea className="reply-box" value={valueOf(questions[0], "aiDraft") || "点击重新生成后显示建议回复"} readOnly />
                  <h3>参考资料</h3>
                  <ul className="plain-list">
                    <li>商品资料</li>
                    <li>发票与保修政策</li>
                  </ul>
                  <h3>风险提醒</h3>
                  <p>{statusText(valueOf(questions[0], "riskLevel")) === "高" ? "需要人工确认后再发送" : "未发现高风险承诺"}</p>
                  <div className="button-row">
                    <button onClick={() => run("重新生成建议回复", () => requestJson(apiUrl, `/presale/questions/${valueOf(questions[0], "id")}/generate`, { method: "POST", body: JSON.stringify({ shopId: selectedShop }) }))}>重新生成</button>
                    <button>编辑回复</button>
                    <button onClick={() => run("确认发送", () => requestJson(apiUrl, `/presale/questions/${valueOf(questions[0], "id")}/send`, { method: "POST", body: JSON.stringify({ shopId: selectedShop, dryRun: true }) }))}>确认发送</button>
                    <button>转人工</button>
                  </div>
                </>
              ) : <EmptyState text="选择左侧咨询后查看建议" />}
            </AssistPanel>
          </section>
        )}

        {tab === "aftersale" && (
          <section className="workbench three">
            <QueuePanel title="售后队列" tabs={["全部", "待跟进", "高风险", "Claim", "已关闭"]}>
              {threads.map((thread) => (
                <button key={valueOf(thread, "id")} className="queue-card">
                  <strong>订单 {valueOf(thread, "orderId") || valueOf(thread, "packId")}</strong>
                  <span>{statusText(valueOf(thread, "category"))}</span>
                  <em>{statusText(valueOf(thread, "riskLevel"))}风险</em>
                </button>
              ))}
            </QueuePanel>
            <DetailPanel title="买家消息与订单状态">
              {threads[0] ? (
                <>
                  <LabelBlock label="订单编号" value={valueOf(threads[0], "orderId")} />
                  <LabelBlock label="包裹编号" value={valueOf(threads[0], "packId")} />
                  <LabelBlock label="售后状态" value={statusText(valueOf(threads[0], "status"))} />
                  <h3>买家消息</h3>
                  {Array.isArray(threads[0].messages) && threads[0].messages.length ? (threads[0].messages as AnyRecord[]).map((item) => (
                    <div key={valueOf(item, "id")} className="message-card">{valueOf(item, "text")}</div>
                  )) : <p>-</p>}
                </>
              ) : <EmptyState text="暂无售后消息" />}
            </DetailPanel>
            <AssistPanel title="识别结果与推荐回复">
              {threads[0] ? (
                <>
                  <LabelBlock label="问题类型" value={statusText(valueOf(threads[0], "category"))} />
                  <LabelBlock label="推荐处理方式" value={valueOf(threads[0], "suggestedAction") || "点击识别问题后生成"} />
                  <textarea className="reply-box" value={valueOf(threads[0], "suggestedReply") || "识别问题后匹配预设回复"} readOnly />
                  <h3>可选回复模板</h3>
                  <ul className="plain-list">
                    {templates.slice(0, 4).map((template) => <li key={valueOf(template, "id")}>{valueOf(template, "name")}</li>)}
                  </ul>
                  <div className="button-row">
                    <button onClick={() => run("识别问题", () => requestJson(apiUrl, `/aftersale/threads/${valueOf(threads[0], "id")}/analyze`, { method: "POST", body: JSON.stringify({ shopId: selectedShop }) }))}>识别问题</button>
                    <button>使用推荐回复</button>
                    <button>换一个模板</button>
                    <button>编辑后发送</button>
                    <button>转人工处理</button>
                  </div>
                </>
              ) : <EmptyState text="选择左侧售后记录后查看处理建议" />}
            </AssistPanel>
          </section>
        )}

        {tab === "reviews" && (
          <section className="table-wrap">
            <table>
              <thead><tr><th>来源</th><th>买家问题</th><th>系统推荐回复</th><th>参考资料 / 预设回复</th><th>风险提醒</th><th>状态</th></tr></thead>
              <tbody>
                {reviews.map((review) => (
                  <tr key={`${valueOf(review, "source")}-${valueOf(review, "id")}`}>
                    <td>{valueOf(review, "source")}</td>
                    <td>{short(valueOf(review, "buyerQuestion"), 180)}</td>
                    <td>{short(valueOf(review, "recommendedReply"), 220)}</td>
                    <td>{Array.isArray(review.references) ? (review.references as unknown[]).join(" / ") : "-"}</td>
                    <td><span className={`pill ${valueOf(review, "riskLevel")}`}>{statusText(valueOf(review, "riskLevel"))}</span></td>
                    <td>{statusText(valueOf(review, "status"))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {tab === "knowledge" && (
          <section className="knowledge-layout">
            <article className="panel">
              <h2>上传商品资料</h2>
              <p className="muted">支持 CSV/TXT 粘贴或上传。字段可包含 SKU、商品名称、发票规则、保修政策、物流说明、退换货规则。</p>
              <div className="toolbar">
                <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (file) setProductText(await decodeFile(file));
                }} />
                <button className="button" disabled={busy} onClick={() => run("商品资料更新", saveProductKnowledge)}>保存并更新知识库</button>
              </div>
              <textarea value={productText} onChange={(event) => setProductText(event.target.value)} />
            </article>
            <article className="panel">
              <h2>文本录入</h2>
              <div className="form-grid">
                <input value={docTitle} onChange={(event) => setDocTitle(event.target.value)} placeholder="资料名称" />
                <select value={docType} onChange={(event) => setDocType(event.target.value)}>
                  <option value="product">商品说明</option>
                  <option value="invoice">发票规则</option>
                  <option value="warranty">保修政策</option>
                  <option value="shipping">物流说明</option>
                  <option value="return">退换货规则</option>
                  <option value="faq">常见问题</option>
                  <option value="presale">售前话术</option>
                  <option value="aftersale">售后规则</option>
                </select>
                <input value={docSku} onChange={(event) => setDocSku(event.target.value)} placeholder="关联商品 / SKU" />
              </div>
              <textarea value={docContent} onChange={(event) => setDocContent(event.target.value)} />
              <div className="toolbar">
                <button className="button" disabled={busy} onClick={() => run("资料更新", saveDocument)}>保存并更新知识库</button>
              </div>
            </article>
            <article className="panel">
              <h2>参考资料测试</h2>
              <textarea value={referenceQuery} onChange={(event) => setReferenceQuery(event.target.value)} />
              <div className="toolbar">
                <button className="button secondary" disabled={busy} onClick={() => run("参考资料测试", searchReferences)}>查看匹配资料</button>
              </div>
              <div className="hit-list">
                {referenceHits.map((hit) => (
                  <div key={valueOf(hit, "id") || valueOf(hit, "title")} className="hit">
                    <strong>{valueOf(hit, "title")} · 匹配度：{matchText(valueOf(hit, "score"))}</strong>
                    <p>{short(valueOf(hit, "content"), 260)}</p>
                  </div>
                ))}
              </div>
            </article>
            <section className="table-wrap full">
              <table>
                <thead><tr><th>资料名称</th><th>资料类型</th><th>状态</th><th>引用次数</th><th>最近更新</th></tr></thead>
                <tbody>
                  {documents.map((doc) => (
                    <tr key={valueOf(doc, "id")}>
                      <td>{valueOf(doc, "title")}</td>
                      <td>{docTypeText(valueOf(doc, "docType"))}</td>
                      <td>{statusText(valueOf(doc, "status"))}</td>
                      <td>-</td>
                      <td>{new Date(valueOf(doc, "updatedAt")).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </section>
        )}

        {tab === "templates" && (
          <section className="split">
            <article className="panel">
              <h2>新增预设回复</h2>
              <div className="form-grid compact">
                <input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="回复名称" />
                <select value={templateIntent} onChange={(event) => setTemplateIntent(event.target.value)}>
                  <option value="not_received">物流未收到</option>
                  <option value="shipping_delay">物流延迟</option>
                  <option value="invoice_request">发票问题</option>
                  <option value="warranty_question">保修问题</option>
                  <option value="return_request">退货流程</option>
                  <option value="refund_request">退款问题</option>
                  <option value="damaged_item">商品损坏</option>
                  <option value="claim_opened">平台 Claim</option>
                </select>
              </div>
              <textarea value={templateContent} onChange={(event) => setTemplateContent(event.target.value)} />
              <button className="button" disabled={busy} onClick={() => run("预设回复保存", saveTemplate)}>保存预设回复</button>
            </article>
            <section className="table-wrap">
              <table>
                <thead><tr><th>回复名称</th><th>问题类型</th><th>适用语言</th><th>是否启用</th><th>是否需要审核</th><th>回复内容</th><th>操作</th></tr></thead>
                <tbody>
                  {templates.map((template) => (
                    <tr key={valueOf(template, "id")}>
                      <td>{valueOf(template, "name")}</td>
                      <td>{statusText(valueOf(template, "intentCode"))}</td>
                      <td>{valueOf(template, "language")}</td>
                      <td>{valueOf(template, "active") === "true" ? "启用" : "停用"}</td>
                      <td>{valueOf(template, "requiresReview") === "true" ? "需要" : "不需要"}</td>
                      <td>{short(valueOf(template, "content"), 180)}</td>
                      <td><button onClick={() => run("预设回复状态更新", () => requestJson(apiUrl, `/reply-templates/${valueOf(template, "id")}/toggle`, { method: "POST", body: JSON.stringify({ shopId: selectedShop }) }))}>{valueOf(template, "active") === "true" ? "停用" : "恢复"}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </section>
        )}

        {tab === "stats" && (
          <section className="columns">
            <article>
              <h2>处理统计</h2>
              <div className="stat-list">
                <LabelBlock label="今日已回复" value={String(metrics.todayReplied ?? 0)} />
                <LabelBlock label="建议采纳率" value={`${String(metrics.adoptionRate ?? 0)}%`} />
                <LabelBlock label="高风险数量" value={String(metrics.highRisk ?? 0)} />
                <LabelBlock label="预设回复数量" value={String(metrics.templateCount ?? templates.length)} />
              </div>
            </article>
            <article>
              <h2>更新记录</h2>
              <div className="timeline">
                {logs.slice(0, 12).map((log) => (
                  <div key={valueOf(log, "id")}>
                    <strong>{valueOf(log, "action")}</strong>
                    <span>{new Date(valueOf(log, "createdAt")).toLocaleString()}</span>
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
              <p className="muted">授权后系统会接收平台消息，并在人工确认后回写回复。</p>
              <button className="button" onClick={() => window.location.assign(`${apiUrl}/auth/meli/start`)}>授权 Mercado Libre 店铺</button>
              <div className="settings-list">
                <LabelBlock label="当前店铺" value={valueOf(currentShop, "nickname") || "本地演示店铺"} />
                <LabelBlock label="平台连接" value={systemStatus.platformConnected ? "正常" : "待授权"} />
                <LabelBlock label="消息同步" value={systemStatus.messageSync ? "正常" : "需检查"} />
                <LabelBlock label="客服助手" value={systemStatus.assistant ? "正常" : "需配置"} />
              </div>
            </article>
            <article>
              <h2>成员权限与安全</h2>
              <p className="muted">不同成员只能访问被分配的店铺。发送、审核、模板维护都由后端记录操作日志。</p>
              <div className="settings-list">
                <LabelBlock label="发送回复" value="人工确认后执行" />
                <LabelBlock label="店铺资料" value="按店铺隔离" />
                <LabelBlock label="安全策略" value="后端校验权限与操作记录" />
              </div>
            </article>
          </section>
        )}
      </section>
    </main>
  );
}

function StatusItem({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="status-item">
      <span className={ok ? "dot ok" : "dot warn"} />
      <strong>{label}</strong>
      <em>{ok ? "正常" : "需检查"}</em>
    </div>
  );
}

function QueuePanel({ title, tabs, children }: { title: string; tabs: string[]; children: ReactNode }) {
  return (
    <aside className="queue-panel">
      <h2>{title}</h2>
      <div className="mini-tabs">{tabs.map((item) => <button key={item}>{item}</button>)}</div>
      <div className="queue-list">{children}</div>
    </aside>
  );
}

function DetailPanel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="detail-panel"><h2>{title}</h2>{children}</section>;
}

function AssistPanel({ title, children }: { title: string; children: ReactNode }) {
  return <aside className="assist-panel"><h2>{title}</h2>{children}</aside>;
}

function LabelBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="label-block">
      <span>{label}</span>
      <strong>{value || "-"}</strong>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}
