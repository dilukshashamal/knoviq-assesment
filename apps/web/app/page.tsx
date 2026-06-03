"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  FileText,
  Loader2,
  LogIn,
  Receipt,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Upload,
  UserPlus,
  Workflow,
} from "lucide-react";

interface AuthUser {
  email: string;
  fullName: string | null;
  role: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  userId: string;
}

interface AuthResponse {
  tokens: {
    accessToken: string;
    refreshToken: string;
  };
  user: AuthUser;
}

interface DocumentSummary {
  chunkCount: number;
  createdAt: string;
  documentId: string;
  filename: string;
  status: string;
  title: string;
  visibility: string;
}

interface HealthCheck {
  key: string;
  label: string;
  latencyMs: number;
  ok: boolean;
  status: number;
}

interface ToolCall {
  error?: {
    code: string;
    message: string;
  };
  latencyMs?: number;
  output?: unknown;
  reason: string;
  status: "succeeded" | "failed";
  toolName: string;
}

interface ChatResponse {
  answer: string;
  conversationId: string;
  toolCalls: ToolCall[];
  validation: {
    confidence: number;
    issues: string[];
    requiredCaveats: string[];
    status: "grounded" | "partially_grounded" | "unsupported";
    supportedToolNames: string[];
  };
}

interface InvoiceItem {
  amount: number;
  approvalStatus?: string;
  category?: string;
  chunkId?: string;
  department?: string;
  description?: string;
  documentId?: string;
  documentTitle?: string;
  evidence?: string;
  invoiceDate?: string;
  invoiceNumber?: string;
  vendor?: string;
}

interface InvoiceExtractionOutput {
  currency: string;
  expression?: string;
  invoiceCount: number;
  invoices: InvoiceItem[];
  period: string | null;
  skippedChunkCount?: number;
  totalAmount: number;
}

interface ApiErrorBody {
  code?: string;
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
}

const SESSION_STORAGE_KEY = "knoviq.session";
const defaultQuestion = "Summarize uploaded invoices and calculate total expenses for April 2026.";

export default function HomePage() {
  const [mode, setMode] = useState<"register" | "login">("register");
  const [email, setEmail] = useState("operator@example.com");
  const [password, setPassword] = useState("Password12345!");
  const [fullName, setFullName] = useState("Knoviq Operator");
  const [tenantName, setTenantName] = useState("Knoviq Workspace");
  const [session, setSession] = useState<AuthResponse | null>(null);
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [documentTitle, setDocumentTitle] = useState("April invoice");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [chatInput, setChatInput] = useState(defaultQuestion);
  const [chatResponse, setChatResponse] = useState<ChatResponse | null>(null);
  const [chatStatus, setChatStatus] = useState<string | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [healthChecks, setHealthChecks] = useState<HealthCheck[]>([]);
  const [healthLoading, setHealthLoading] = useState(false);

  const accessToken = session?.tokens.accessToken;
  const healthReadyCount = healthChecks.filter((check) => check.ok).length;
  const invoiceExtraction = useMemo(
    () =>
      chatResponse?.toolCalls.find((call) => call.toolName === "document.extract_invoice_fields"),
    [chatResponse],
  );

  useEffect(() => {
    const stored = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!stored) {
      return;
    }

    try {
      const parsed = JSON.parse(stored) as AuthResponse;
      setSession(parsed);
      setEmail(parsed.user.email);
    } catch {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    const interval = window.setInterval(() => {
      void refreshHealth();
    }, 15000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (accessToken) {
      void refreshDocuments(accessToken);
    }
  }, [accessToken]);

  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthLoading(true);
    setAuthStatus(null);

    try {
      const body =
        mode === "register"
          ? { email, fullName, password, tenantName }
          : {
              email,
              password,
            };
      const response = await requestJson<AuthResponse>(`/api/auth/${mode}`, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      });

      setSession(response);
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(response));
      setAuthStatus(`Signed in to ${response.user.tenantName}`);
    } catch (error) {
      setAuthStatus(getErrorMessage(error));
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken) {
      setUploadStatus("Sign in before uploading documents.");
      return;
    }

    if (!selectedFile) {
      setUploadStatus("Choose a TXT or PDF file first.");
      return;
    }

    setDocumentsLoading(true);
    setUploadStatus(null);

    try {
      const formData = new FormData();
      formData.append("title", documentTitle || selectedFile.name);
      formData.append("visibility", "tenant");
      formData.append("metadata", JSON.stringify({ source: "web-ui" }));
      formData.append("file", selectedFile);

      await requestJson<unknown>("/api/documents", {
        body: formData,
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        method: "POST",
      });
      setUploadStatus(`Uploaded ${selectedFile.name}`);
      setSelectedFile(null);
      await refreshDocuments(accessToken);
    } catch (error) {
      setUploadStatus(getErrorMessage(error));
    } finally {
      setDocumentsLoading(false);
    }
  }

  async function handleChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken) {
      setChatStatus("Sign in before asking the agent.");
      return;
    }

    setChatLoading(true);
    setChatStatus(null);

    try {
      const response = await requestJson<ChatResponse>("/api/chat", {
        body: JSON.stringify({ message: chatInput }),
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        method: "POST",
      });

      setChatResponse(response);
      setChatStatus("Agent run completed.");
    } catch (error) {
      setChatStatus(getErrorMessage(error));
    } finally {
      setChatLoading(false);
    }
  }

  async function handleDeleteDocument(document: DocumentSummary) {
    if (!accessToken) {
      setUploadStatus("Sign in before deleting documents.");
      return;
    }

    const confirmed = window.confirm(`Delete "${document.title}" from this tenant?`);

    if (!confirmed) {
      return;
    }

    setDocumentsLoading(true);
    setUploadStatus(null);

    try {
      await requestJson<void>(`/api/documents/${document.documentId}`, {
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        method: "DELETE",
      });
      setUploadStatus(`Deleted ${document.title}`);
      await refreshDocuments(accessToken);
    } catch (error) {
      setUploadStatus(getErrorMessage(error));
    } finally {
      setDocumentsLoading(false);
    }
  }

  function handleSignOut() {
    setSession(null);
    setDocuments([]);
    setChatResponse(null);
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  }

  async function refreshDocuments(token = accessToken) {
    if (!token) {
      return;
    }

    setDocumentsLoading(true);
    try {
      const response = await requestJson<{ documents: DocumentSummary[] }>("/api/documents", {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      setDocuments(response.documents);
    } catch (error) {
      setUploadStatus(getErrorMessage(error));
    } finally {
      setDocumentsLoading(false);
    }
  }

  async function refreshHealth() {
    setHealthLoading(true);
    try {
      const response = await requestJson<{ checks: HealthCheck[] }>("/api/health", {
        cache: "no-store",
      });
      setHealthChecks(response.checks);
    } catch {
      setHealthChecks([]);
    } finally {
      setHealthLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)_360px]">
        <aside className="border-b border-border bg-surface px-5 py-5 lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-muted-foreground">Knoviq</p>
              <h1 className="mt-1 text-2xl font-semibold">Agent Console</h1>
            </div>
            <button
              className="icon-button"
              onClick={() => void refreshHealth()}
              title="Refresh service health"
              type="button"
            >
              <RefreshCw className={healthLoading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            </button>
          </div>

          <section className="mt-6">
            <div className="flex items-center justify-between">
              <h2 className="section-title">Services</h2>
              <span className="text-sm text-muted-foreground">
                {healthReadyCount}/{healthChecks.length || 4} ready
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {(healthChecks.length > 0 ? healthChecks : fallbackHealthChecks()).map((check) => (
                <div className="status-row" key={check.key}>
                  <span className={check.ok ? "status-dot bg-success" : "status-dot bg-danger"} />
                  <span className="min-w-0 flex-1 truncate">{check.label}</span>
                  <span className="text-muted-foreground">
                    {check.status > 0 ? `${check.latencyMs}ms` : "down"}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-8">
            <div className="segmented-control">
              <button
                className={mode === "register" ? "active" : ""}
                onClick={() => setMode("register")}
                type="button"
              >
                <UserPlus className="h-4 w-4" />
                Register
              </button>
              <button
                className={mode === "login" ? "active" : ""}
                onClick={() => setMode("login")}
                type="button"
              >
                <LogIn className="h-4 w-4" />
                Login
              </button>
            </div>

            <form className="mt-4 space-y-3" onSubmit={(event) => void handleAuth(event)}>
              <label className="field-label">
                Email
                <input
                  className="field-input"
                  onChange={(event) => setEmail(event.target.value)}
                  type="email"
                  value={email}
                />
              </label>
              <label className="field-label">
                Password
                <input
                  className="field-input"
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  value={password}
                />
              </label>
              {mode === "register" ? (
                <>
                  <label className="field-label">
                    Full name
                    <input
                      className="field-input"
                      onChange={(event) => setFullName(event.target.value)}
                      value={fullName}
                    />
                  </label>
                  <label className="field-label">
                    Tenant
                    <input
                      className="field-input"
                      onChange={(event) => setTenantName(event.target.value)}
                      value={tenantName}
                    />
                  </label>
                </>
              ) : null}
              <button className="primary-button w-full" disabled={authLoading} type="submit">
                {authLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4" />
                )}
                {mode === "register" ? "Create session" : "Start session"}
              </button>
            </form>

            {authStatus ? <p className="mt-3 text-sm text-muted-foreground">{authStatus}</p> : null}
            {session ? (
              <div className="mt-4 border-t border-border pt-4">
                <p className="text-sm font-medium">{session.user.tenantName}</p>
                <p className="mt-1 truncate text-sm text-muted-foreground">{session.user.email}</p>
                <p className="mt-2 text-sm text-muted-foreground">Role: {session.user.role}</p>
                <button className="ghost-button mt-3 w-full" onClick={handleSignOut} type="button">
                  Sign out
                </button>
              </div>
            ) : null}
          </section>
        </aside>

        <section className="flex min-h-[720px] flex-col px-5 py-5 md:px-8">
          <div className="flex flex-col gap-4 border-b border-border pb-5 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-semibold text-muted-foreground">Workspace</p>
              <h2 className="mt-1 text-3xl font-semibold">Documents and chat</h2>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Activity className="h-4 w-4 text-primary" />
              {session ? "Authenticated workspace" : "Waiting for session"}
            </div>
          </div>

          <div className="grid flex-1 grid-cols-1 gap-6 py-6 xl:grid-cols-[360px_minmax(0,1fr)]">
            <section className="min-w-0">
              <div className="flex items-center justify-between">
                <h3 className="section-title">Document Intake</h3>
                <button
                  className="icon-button"
                  disabled={!accessToken || documentsLoading}
                  onClick={() => void refreshDocuments()}
                  title="Refresh documents"
                  type="button"
                >
                  <RefreshCw className={documentsLoading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                </button>
              </div>

              <form className="mt-4 space-y-3" onSubmit={(event) => void handleUpload(event)}>
                <label className="field-label">
                  Title
                  <input
                    className="field-input"
                    onChange={(event) => setDocumentTitle(event.target.value)}
                    value={documentTitle}
                  />
                </label>
                <label className="file-drop">
                  <Upload className="h-5 w-5 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {selectedFile ? selectedFile.name : "Choose invoice or knowledge file"}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      TXT and PDF are supported
                    </span>
                  </span>
                  <input
                    accept=".txt,.text,.pdf,text/plain,application/pdf"
                    className="sr-only"
                    onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                    type="file"
                  />
                </label>
                <button
                  className="primary-button w-full"
                  disabled={!accessToken || documentsLoading}
                  type="submit"
                >
                  {documentsLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  Upload document
                </button>
              </form>
              {uploadStatus ? (
                <p className="mt-3 text-sm text-muted-foreground">{uploadStatus}</p>
              ) : null}

              <div className="mt-6 space-y-2">
                {documents.length === 0 ? (
                  <div className="empty-state">
                    <FileText className="h-5 w-5" />
                    <span>No documents loaded for this tenant.</span>
                  </div>
                ) : (
                  documents.map((document) => (
                    <div className="document-row" key={document.documentId}>
                      <FileText className="h-4 w-4 shrink-0 text-primary" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{document.title}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {document.status} · {document.chunkCount} chunks · {document.visibility}
                        </p>
                      </div>
                      <button
                        className="icon-button h-9 w-9"
                        disabled={documentsLoading}
                        onClick={() => void handleDeleteDocument(document)}
                        title={`Delete ${document.title}`}
                        type="button"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="flex min-h-[620px] min-w-0 flex-col">
              <div className="flex items-center justify-between">
                <h3 className="section-title">Agent Chat</h3>
                <span className="text-sm text-muted-foreground">
                  {chatResponse ? chatResponse.validation.status.replace("_", " ") : "No run yet"}
                </span>
              </div>

              <div className="answer-surface mt-4">
                {chatResponse ? (
                  <div>
                    <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="h-4 w-4 text-success" />
                      Conversation {chatResponse.conversationId.slice(0, 8)}
                    </div>
                    <p className="whitespace-pre-wrap leading-7">{chatResponse.answer}</p>
                  </div>
                ) : (
                  <div className="flex h-full min-h-[360px] items-center justify-center text-center text-muted-foreground">
                    <div>
                      <Workflow className="mx-auto h-8 w-8 text-primary" />
                      <p className="mt-3 max-w-md">
                        Upload invoices or knowledge files, then ask the agent to retrieve, reason,
                        calculate, and validate.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <form
                className="mt-4 flex flex-col gap-3 md:flex-row"
                onSubmit={(event) => void handleChat(event)}
              >
                <textarea
                  className="chat-input"
                  onChange={(event) => setChatInput(event.target.value)}
                  rows={3}
                  value={chatInput}
                />
                <button
                  className="primary-button md:w-36"
                  disabled={!accessToken || chatLoading}
                  type="submit"
                >
                  {chatLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  Ask
                </button>
              </form>
              {chatStatus ? (
                <p className="mt-3 text-sm text-muted-foreground">{chatStatus}</p>
              ) : null}
            </section>
          </div>
        </section>

        <aside className="border-t border-border bg-surface px-5 py-5 lg:border-l lg:border-t-0">
          <h2 className="section-title">Agent Trace</h2>
          <div className="mt-4 space-y-3">
            {chatResponse?.toolCalls.length ? (
              chatResponse.toolCalls.map((call, index) => (
                <div className="trace-row" key={`${call.toolName}-${index}`}>
                  <span
                    className={
                      call.status === "succeeded" ? "status-dot bg-success" : "status-dot bg-danger"
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{call.toolName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {call.status} {call.latencyMs ? `· ${call.latencyMs}ms` : ""}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-state">
                <Workflow className="h-5 w-5" />
                <span>Tool calls appear after a chat run.</span>
              </div>
            )}
          </div>

          <section className="mt-8">
            <h3 className="section-title">Validation</h3>
            <div className="mt-4 validation-panel">
              {chatResponse ? (
                <>
                  <div className="flex items-center gap-2">
                    {chatResponse.validation.status === "grounded" ? (
                      <CheckCircle2 className="h-5 w-5 text-success" />
                    ) : (
                      <CircleAlert className="h-5 w-5 text-warning" />
                    )}
                    <span className="font-medium">
                      {chatResponse.validation.status.replace("_", " ")}
                    </span>
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">
                    Confidence {Math.round(chatResponse.validation.confidence * 100)}%
                  </p>
                  <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${Math.round(chatResponse.validation.confidence * 100)}%` }}
                    />
                  </div>
                  {chatResponse.validation.issues.length > 0 ? (
                    <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                      {chatResponse.validation.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  The validator checks hallucination risk after each run.
                </p>
              )}
            </div>
          </section>

          <section className="mt-8">
            <h3 className="section-title">Invoice Output</h3>
            <div className="mt-4">
              <InvoicePanel
                data={invoiceExtraction?.output}
                toolCalls={chatResponse?.toolCalls ?? []}
              />
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}

async function requestJson<TResponse>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<TResponse> {
  const response = await fetch(input, init);
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;

  if (!response.ok) {
    throw new Error(extractApiMessage(data, response.status));
  }

  return data as TResponse;
}

function extractApiMessage(data: unknown, status: number): string {
  if (isApiErrorBody(data)) {
    return (
      data.error?.message ??
      data.message ??
      data.error?.code ??
      data.code ??
      `Request failed: ${status}`
    );
  }

  return `Request failed: ${status}`;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === "object" && value !== null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function InvoicePanel({ data, toolCalls }: { data: unknown; toolCalls?: ToolCall[] }) {
  if (data === undefined || data === null) {
    return (
      <div className="empty-state">
        <Receipt className="h-5 w-5" />
        <span>No invoice extraction yet. Ask about uploaded invoices to see results here.</span>
      </div>
    );
  }

  const parsed = parseInvoiceOutput(data);

  if (!parsed) {
    return (
      <div className="empty-state">
        <Receipt className="h-5 w-5" />
        <span>Extraction ran but returned an unexpected format.</span>
      </div>
    );
  }

  const { currency, invoiceCount, invoices, period, totalAmount } = parsed;

  const calcTool = toolCalls?.find(
    (tc) => tc.toolName === "calculator.evaluate" && tc.status === "succeeded",
  );
  const calcResult = (calcTool?.output as { result?: number } | undefined)?.result;
  const calcMatches = calcResult !== undefined && Math.abs(calcResult - totalAmount) < 0.01;

  if (invoiceCount === 0) {
    return (
      <div className="empty-state">
        <Receipt className="h-5 w-5" />
        <span>
          No invoices found{period ? ` for ${period}` : ""}. Upload an invoice file and ask again.
        </span>
      </div>
    );
  }

  // Show all invoices the LLM returned — they are clean structured data,
  // not regex-scraped fragments.
  const lineItems = invoices.filter((inv) => inv.amount > 0);

  const fmt = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const fmtDate = (d: string) => {
    try {
      return new Date(d).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return d;
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background">
      {/* ── Header ── */}
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
        <div className="flex items-center gap-2">
          <Receipt className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Expense Report</span>
        </div>
        {period ? (
          <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
            {period}
          </span>
        ) : null}
      </div>

      {/* ── Invoice table ── */}
      {lineItems.length > 0 ? (
        <div className="divide-y divide-border">
          {/* Column headers */}
          <div className="grid grid-cols-[1fr_auto] gap-2 px-4 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Invoice
            </span>
            <span className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Amount
            </span>
          </div>

          {/* Rows */}
          {lineItems.map((inv, i) => (
            <div key={inv.invoiceNumber ?? i} className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3">
              <div className="min-w-0">
                {/* Invoice number + vendor */}
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {inv.invoiceNumber ? (
                    <span className="font-mono text-xs font-semibold text-primary">
                      {inv.invoiceNumber}
                    </span>
                  ) : null}
                  {inv.vendor ? (
                    <span className="truncate text-sm font-medium">{inv.vendor}</span>
                  ) : null}
                </div>

                {/* Date + description + approval */}
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  {inv.invoiceDate ? (
                    <span className="text-xs text-muted-foreground">
                      {fmtDate(inv.invoiceDate)}
                    </span>
                  ) : null}
                  {inv.description ? (
                    <span className="text-xs text-muted-foreground">· {inv.description}</span>
                  ) : (inv as InvoiceItem & { category?: string }).category ? (
                    <span className="text-xs text-muted-foreground">
                      · {(inv as InvoiceItem & { category?: string }).category}
                    </span>
                  ) : null}
                  {(inv as InvoiceItem & { approvalStatus?: string }).approvalStatus ? (
                    <span
                      className={`text-xs font-medium ${
                        (inv as InvoiceItem & { approvalStatus?: string }).approvalStatus
                          ?.toLowerCase()
                          .includes("manager")
                          ? "text-warning"
                          : "text-success"
                      }`}
                    >
                      · {(inv as InvoiceItem & { approvalStatus?: string }).approvalStatus}
                    </span>
                  ) : null}
                </div>
              </div>

              {/* Amount */}
              <span className="shrink-0 self-center text-right text-sm font-semibold tabular-nums">
                {fmt(inv.amount)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        /* No clean line items — show a simple note */
        <div className="px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {invoiceCount} invoice{invoiceCount !== 1 ? "s" : ""} identified in the document.
            Line-by-line breakdown is not available for this document format.
          </p>
        </div>
      )}

      {/* ── Divider ── */}
      <div className="border-t border-border" />

      {/* ── Total row ── */}
      <div className="flex items-center justify-between bg-primary/5 px-4 py-3">
        <div>
          <p className="text-sm font-semibold">Total</p>
          <p className="text-xs text-muted-foreground">
            {invoiceCount} invoice{invoiceCount !== 1 ? "s" : ""}
            {period ? ` · ${period}` : ""}
            {" · "}from document
          </p>
        </div>
        <span className="text-lg font-bold text-primary tabular-nums">
          {currency} {fmt(totalAmount)}
        </span>
      </div>

      {/* ── Calculator confirmation ── */}
      {calcResult !== undefined ? (
        <div className="flex items-center gap-3 border-t border-border px-4 py-2.5">
          {calcMatches ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
          ) : (
            <CircleAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
          )}
          <p className="text-xs text-muted-foreground">
            Calculator{" "}
            {calcMatches ? (
              <span className="font-medium text-success">confirmed</span>
            ) : (
              <span className="font-medium text-warning">returned a different value</span>
            )}
            {" — "}
            {currency} {fmt(calcResult)}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function parseInvoiceOutput(data: unknown): InvoiceExtractionOutput | null {
  if (typeof data !== "object" || data === null) return null;

  const d = data as Record<string, unknown>;
  if (
    typeof d.currency !== "string" ||
    typeof d.invoiceCount !== "number" ||
    typeof d.totalAmount !== "number" ||
    !Array.isArray(d.invoices)
  ) {
    return null;
  }

  const invoices: InvoiceItem[] = (d.invoices as unknown[]).map((item) => {
    const inv = item as Record<string, unknown>;
    const base: InvoiceItem = {
      amount: typeof inv.amount === "number" ? inv.amount : 0,
    };
    if (typeof inv.approvalStatus === "string") base.approvalStatus = inv.approvalStatus;
    if (typeof inv.category === "string") base.category = inv.category;
    if (typeof inv.chunkId === "string") base.chunkId = inv.chunkId;
    if (typeof inv.department === "string") base.department = inv.department;
    if (typeof inv.description === "string") base.description = inv.description;
    if (typeof inv.documentId === "string") base.documentId = inv.documentId;
    if (typeof inv.documentTitle === "string") base.documentTitle = inv.documentTitle;
    if (typeof inv.evidence === "string") base.evidence = inv.evidence;
    if (typeof inv.invoiceDate === "string") base.invoiceDate = inv.invoiceDate;
    if (typeof inv.invoiceNumber === "string") base.invoiceNumber = inv.invoiceNumber;
    if (typeof inv.vendor === "string") base.vendor = inv.vendor;
    return base;
  });

  const result: InvoiceExtractionOutput = {
    currency: d.currency,
    invoiceCount: d.invoiceCount,
    invoices,
    period: typeof d.period === "string" ? d.period : null,
    totalAmount: d.totalAmount,
  };
  if (typeof d.expression === "string") result.expression = d.expression;
  if (typeof d.skippedChunkCount === "number") result.skippedChunkCount = d.skippedChunkCount;

  return result;
}

function fallbackHealthChecks(): HealthCheck[] {
  return [
    { key: "auth", label: "Auth", latencyMs: 0, ok: false, status: 0 },
    { key: "ai", label: "AI Gateway", latencyMs: 0, ok: false, status: 0 },
    { key: "knowledge", label: "Knowledge", latencyMs: 0, ok: false, status: 0 },
    { key: "tools", label: "Tools", latencyMs: 0, ok: false, status: 0 },
  ];
}
