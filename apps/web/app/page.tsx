"use client";

import { type ChangeEvent, type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileText,
  FolderOpen,
  Gauge,
  Loader2,
  LogIn,
  MessageSquarePlus,
  Receipt,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
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
  requiresGroundedEvidence?: boolean;
  toolCalls: ToolCall[];
  validation: {
    confidence: number;
    issues: string[];
    requiredCaveats: string[];
    status: "grounded" | "partially_grounded" | "unsupported";
    supportedToolNames: string[];
  };
}

interface ChatMessage {
  content: string;
  createdAt: string;
  id: string;
  role: "assistant" | "user";
  toolCalls?: ToolCall[];
  validation?: ChatResponse["validation"];
}

interface ChatThread {
  conversationId?: string;
  createdAt: string;
  id: string;
  messages: ChatMessage[];
  title: string;
  updatedAt: string;
}

interface ToolExecutionResponse {
  error?: {
    code: string;
    message: string;
  };
  latencyMs: number;
  output?: {
    rows?: Record<string, unknown>[];
  };
  status: "succeeded" | "failed";
  toolName: string;
}

interface ObservabilityResponse {
  llm_usage_summary?: ToolExecutionResponse;
  recent_tool_executions?: ToolExecutionResponse;
  service_metric_summary?: ToolExecutionResponse;
  tool_execution_summary?: ToolExecutionResponse;
}

interface ApiErrorBody {
  code?: string;
  details?: string;
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
}

const SESSION_STORAGE_KEY = "knoviq.session";

/** Returns a localStorage key scoped to the specific user so chat threads
 *  from one account are never visible to another account on the same device. */
function threadStorageKey(userId: string): string {
  return `knoviq.chatThreads.${userId}`;
}
const defaultQuestion = "";

export default function HomePage() {
  const [mode, setMode] = useState<"register" | "login">("register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [session, setSession] = useState<AuthResponse | null>(null);
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [documentTitle, setDocumentTitle] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [threadState, setThreadState] = useState(() => {
    const thread = createThread();
    return {
      activeThreadId: thread.id,
      threads: [thread],
    };
  });
  const [chatInput, setChatInput] = useState(defaultQuestion);
  const [chatStatus, setChatStatus] = useState<string | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [healthChecks, setHealthChecks] = useState<HealthCheck[]>([]);
  const [healthLoading, setHealthLoading] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"monitor" | "sources" | "trace">("sources");
  const [observability, setObservability] = useState<ObservabilityResponse | null>(null);
  const [observabilityLoading, setObservabilityLoading] = useState(false);
  const [observabilityStatus, setObservabilityStatus] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const accessToken = session?.tokens.accessToken;
  const activeThread = useMemo(
    () =>
      threadState.threads.find((thread) => thread.id === threadState.activeThreadId) ??
      threadState.threads[0],
    [threadState.activeThreadId, threadState.threads],
  );
  const latestAssistant = useMemo(() => findLatestAssistant(activeThread), [activeThread]);
  const latestToolCalls = latestAssistant?.toolCalls ?? [];
  const monitor = useMemo(() => buildMonitorSummary(observability), [observability]);

  useEffect(() => {
    const storedSession = window.localStorage.getItem(SESSION_STORAGE_KEY);

    if (storedSession) {
      try {
        const parsed = JSON.parse(storedSession) as AuthResponse;
        setSession(parsed);
        setEmail(parsed.user.email);

        // Load this user's threads from their scoped key
        const storedThreads = window.localStorage.getItem(threadStorageKey(parsed.user.userId));
        if (storedThreads) {
          try {
            const parsedThreads = JSON.parse(storedThreads) as {
              activeThreadId: string;
              threads: ChatThread[];
            };
            if (parsedThreads.threads.length > 0) {
              setThreadState(parsedThreads);
            }
          } catch {
            window.localStorage.removeItem(threadStorageKey(parsed.user.userId));
          }
        }
      } catch {
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
      }
    }

    setStorageReady(true);
  }, []);

  useEffect(() => {
    if (storageReady && session) {
      window.localStorage.setItem(
        threadStorageKey(session.user.userId),
        JSON.stringify(threadState),
      );
    }
  }, [storageReady, session, threadState]);

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
      void refreshObservability(accessToken);
    }
  }, [accessToken]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeThread?.messages.length, chatLoading]);

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

      // Reset threads to a blank slate, then load this user's saved threads
      const freshThread = createThread();
      const defaultState = { activeThreadId: freshThread.id, threads: [freshThread] };
      const savedThreads = window.localStorage.getItem(threadStorageKey(response.user.userId));
      if (savedThreads) {
        try {
          const parsed = JSON.parse(savedThreads) as {
            activeThreadId: string;
            threads: ChatThread[];
          };
          setThreadState(parsed.threads.length > 0 ? parsed : defaultState);
        } catch {
          setThreadState(defaultState);
        }
      } else {
        setThreadState(defaultState);
      }

      setAuthStatus(`Signed in to ${response.user.tenantName}`);
    } catch (error) {
      setAuthStatus(getErrorMessage(error));
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await uploadSelectedFile();
  }

  async function uploadSelectedFile() {
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
      setChatStatus("Sign in before asking the assistant.");
      return;
    }

    const trimmed = chatInput.trim();

    if (!trimmed || !activeThread) {
      return;
    }

    const userMessage: ChatMessage = {
      content: trimmed,
      createdAt: new Date().toISOString(),
      id: crypto.randomUUID(),
      role: "user",
    };

    const threadBeforeRun = activeThread;
    upsertThread({
      ...threadBeforeRun,
      messages: [...threadBeforeRun.messages, userMessage],
      title:
        threadBeforeRun.messages.length === 0 ? titleFromMessage(trimmed) : threadBeforeRun.title,
      updatedAt: userMessage.createdAt,
    });
    setChatInput("");
    setChatLoading(true);
    setChatStatus(null);

    try {
      const response = await requestJson<ChatResponse>("/api/chat", {
        body: JSON.stringify({
          ...(threadBeforeRun.conversationId
            ? { conversationId: threadBeforeRun.conversationId }
            : {}),
          message: trimmed,
        }),
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const assistantMessage: ChatMessage = {
        content: response.answer,
        createdAt: new Date().toISOString(),
        id: crypto.randomUUID(),
        role: "assistant",
        toolCalls: response.toolCalls,
        validation: response.validation,
      };

      upsertThread((current) => ({
        ...current,
        conversationId: response.conversationId,
        messages: [...current.messages, assistantMessage],
        updatedAt: assistantMessage.createdAt,
      }));
      setInspectorTab(response.toolCalls.length > 0 ? "trace" : "sources");
      setChatStatus("Answer generated.");
      void refreshObservability(accessToken);
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

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);

    if (file && (!documentTitle || documentTitle === "Knowledge Assistant Policy")) {
      setDocumentTitle(file.name.replace(/\.[^.]+$/, ""));
    }
  }

  function handleNewChat() {
    const thread = createThread();
    setThreadState((current) => ({
      activeThreadId: thread.id,
      threads: [thread, ...current.threads],
    }));
    setChatInput(defaultQuestion);
    setChatStatus(null);
  }

  function handleDeleteThread(threadId: string) {
    setThreadState((current) => {
      const remaining = current.threads.filter((t) => t.id !== threadId);

      // Always keep at least one thread
      if (remaining.length === 0) {
        const fresh = createThread();
        return { activeThreadId: fresh.id, threads: [fresh] };
      }

      // If we deleted the active thread, activate the first remaining one
      const nextActiveId =
        current.activeThreadId === threadId ? (remaining[0]?.id ?? "") : current.activeThreadId;

      return { activeThreadId: nextActiveId, threads: remaining };
    });
  }

  function handleSignOut() {
    // Clear this user's threads from state before wiping the session
    const freshThread = createThread();
    setThreadState({ activeThreadId: freshThread.id, threads: [freshThread] });
    setSession(null);
    setDocuments([]);
    setObservability(null);
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

  async function refreshObservability(token = accessToken) {
    if (!token) {
      return;
    }

    setObservabilityLoading(true);
    setObservabilityStatus(null);
    try {
      const response = await requestJson<ObservabilityResponse>("/api/observability", {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      setObservability(response);
    } catch (error) {
      setObservabilityStatus(getErrorMessage(error));
    } finally {
      setObservabilityLoading(false);
    }
  }

  function upsertThread(next: ChatThread | ((current: ChatThread) => ChatThread)) {
    setThreadState((current) => {
      const existing =
        current.threads.find((thread) => thread.id === current.activeThreadId) ??
        current.threads[0] ??
        createThread();
      const nextThread = typeof next === "function" ? next(existing) : next;
      const remaining = current.threads.filter((thread) => thread.id !== nextThread.id);

      return {
        activeThreadId: nextThread.id,
        threads: [nextThread, ...remaining],
      };
    });
  }

  return (
    <main className="app-shell">
      <aside className="chat-rail">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="brand-name">Knoviq</p>
            <p className="brand-subtitle">Document intelligence</p>
          </div>
        </div>

        <button className="new-chat-button" onClick={handleNewChat} type="button">
          <MessageSquarePlus className="h-4 w-4" />
          New chat
        </button>

        <section className="rail-section">
          <div className="section-heading">
            <span>Chats</span>
            <span>{threadState.threads.length}</span>
          </div>
          <div className="thread-list">
            {threadState.threads.map((thread) => (
              <div
                className={
                  thread.id === threadState.activeThreadId ? "thread-item active" : "thread-item"
                }
                key={thread.id}
              >
                <button
                  className="thread-select"
                  onClick={() =>
                    setThreadState((current) => ({
                      ...current,
                      activeThreadId: thread.id,
                    }))
                  }
                  type="button"
                >
                  <MessageSquarePlus className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left">{thread.title}</span>
                </button>
                <button
                  className="thread-delete"
                  onClick={() => handleDeleteThread(thread.id)}
                  title="Delete chat"
                  type="button"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="rail-section">
          <div className="section-heading">
            <span>Files</span>
            <button
              className="mini-icon-button"
              disabled={!accessToken || documentsLoading}
              onClick={() => void refreshDocuments()}
              title="Refresh files"
              type="button"
            >
              <RefreshCw
                className={documentsLoading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
              />
            </button>
          </div>
          <div className="file-list">
            {documents.length === 0 ? (
              <p className="muted-copy">Upload a PDF or TXT to start grounded chat.</p>
            ) : (
              documents.map((document) => (
                <div className="file-item" key={document.documentId}>
                  <FileText className="h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{document.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {document.chunkCount} chunks | {document.visibility}
                    </p>
                  </div>
                  <button
                    className="mini-icon-button"
                    disabled={documentsLoading}
                    onClick={() => void handleDeleteDocument(document)}
                    title={`Delete ${document.title}`}
                    type="button"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="rail-section rail-auth">
          <div className="section-heading">
            <span>Session</span>
            <span>{session ? session.user.role : "off"}</span>
          </div>
          {session ? (
            <div className="session-box">
              <p className="truncate text-sm font-semibold">{session.user.tenantName}</p>
              <p className="truncate text-xs text-muted-foreground">{session.user.email}</p>
              <button
                className="secondary-button mt-3 w-full"
                onClick={handleSignOut}
                type="button"
              >
                Sign out
              </button>
            </div>
          ) : (
            <AuthForm
              authLoading={authLoading}
              authStatus={authStatus}
              email={email}
              fullName={fullName}
              mode={mode}
              onEmailChange={setEmail}
              onFullNameChange={setFullName}
              onModeChange={setMode}
              onPasswordChange={setPassword}
              onSubmit={handleAuth}
              onTenantNameChange={setTenantName}
              password={password}
              tenantName={tenantName}
            />
          )}
        </section>
      </aside>

      <section className="chat-main">
        <header className="top-bar">
          <div>
            <p className="eyebrow">Ask your files</p>
            <h1>{activeThread?.title ?? "New chat"}</h1>
          </div>
          <div className="service-strip">
            {(healthChecks.length > 0 ? healthChecks : fallbackHealthChecks()).map((check) => (
              <span className={check.ok ? "service-pill ok" : "service-pill"} key={check.key}>
                {check.label}
              </span>
            ))}
            <button className="mini-icon-button" onClick={() => void refreshHealth()} type="button">
              <RefreshCw className={healthLoading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            </button>
          </div>
        </header>

        <div className="message-scroll">
          {activeThread && activeThread.messages.length > 0 ? (
            activeThread.messages.map((message) => (
              <article className={`message-row ${message.role}`} key={message.id}>
                <div className="message-avatar">
                  {message.role === "user" ? "U" : <Sparkles className="h-4 w-4" />}
                </div>
                <div className="message-bubble">
                  <div className="message-meta">
                    <span>{message.role === "user" ? "You" : "Knoviq"}</span>
                    <span>{formatTime(message.createdAt)}</span>
                  </div>
                  <p>{message.content}</p>
                  {message.validation ? (
                    <div className="validation-chip">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      {message.validation.status.replace("_", " ")} |{" "}
                      {Math.round(message.validation.confidence * 100)}%
                    </div>
                  ) : null}
                </div>
              </article>
            ))
          ) : (
            <EmptyChat onSuggestion={(text) => setChatInput(text)} />
          )}
          {chatLoading ? (
            <article className="message-row assistant">
              <div className="message-avatar">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="message-bubble typing">
                <Loader2 className="h-4 w-4 animate-spin" />
                Running retrieval, tools, synthesis, and validation
              </div>
            </article>
          ) : null}
          <div ref={messagesEndRef} />
        </div>

        <form className="composer" onSubmit={(event) => void handleChat(event)}>
          <textarea
            onChange={(event) => setChatInput(event.target.value)}
            placeholder="Ask anything about the uploaded files..."
            rows={1}
            value={chatInput}
          />
          <button
            disabled={!accessToken || chatLoading || !chatInput.trim()}
            title="Send"
            type="submit"
          >
            {chatLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </form>
        {chatStatus ? <p className="status-copy">{chatStatus}</p> : null}
      </section>

      <aside className="inspector">
        <div className="inspector-tabs">
          <button
            className={inspectorTab === "sources" ? "active" : ""}
            onClick={() => setInspectorTab("sources")}
            type="button"
          >
            <FolderOpen className="h-4 w-4" />
            Sources
          </button>
          <button
            className={inspectorTab === "trace" ? "active" : ""}
            onClick={() => setInspectorTab("trace")}
            type="button"
          >
            <Workflow className="h-4 w-4" />
            Trace
          </button>
          <button
            className={inspectorTab === "monitor" ? "active" : ""}
            onClick={() => {
              setInspectorTab("monitor");
              void refreshObservability();
            }}
            type="button"
          >
            <BarChart3 className="h-4 w-4" />
            Monitor
          </button>
        </div>

        {inspectorTab === "sources" ? (
          <SourcesPanel
            accessToken={accessToken}
            documentTitle={documentTitle}
            documents={documents}
            documentsLoading={documentsLoading}
            onDelete={handleDeleteDocument}
            onFileChange={handleFileChange}
            onTitleChange={setDocumentTitle}
            onUpload={handleUpload}
            selectedFile={selectedFile}
            uploadStatus={uploadStatus}
          />
        ) : null}

        {inspectorTab === "trace" ? (
          <TracePanel latestAssistant={latestAssistant} toolCalls={latestToolCalls} />
        ) : null}

        {inspectorTab === "monitor" ? (
          <MonitorPanel
            loading={observabilityLoading}
            monitor={monitor}
            onRefresh={() => void refreshObservability()}
            status={observabilityStatus}
          />
        ) : null}
      </aside>
    </main>
  );
}

function AuthForm(props: {
  authLoading: boolean;
  authStatus: string | null;
  email: string;
  fullName: string;
  mode: "register" | "login";
  onEmailChange: (value: string) => void;
  onFullNameChange: (value: string) => void;
  onModeChange: (value: "register" | "login") => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTenantNameChange: (value: string) => void;
  password: string;
  tenantName: string;
}) {
  return (
    <form className="auth-form" onSubmit={props.onSubmit}>
      <div className="mode-switch">
        <button
          className={props.mode === "register" ? "active" : ""}
          onClick={() => props.onModeChange("register")}
          type="button"
        >
          <UserPlus className="h-4 w-4" />
          Register
        </button>
        <button
          className={props.mode === "login" ? "active" : ""}
          onClick={() => props.onModeChange("login")}
          type="button"
        >
          <LogIn className="h-4 w-4" />
          Login
        </button>
      </div>
      <input
        autoComplete="email"
        onChange={(event) => props.onEmailChange(event.target.value)}
        placeholder="Email address"
        required
        type="email"
        value={props.email}
      />
      <div className="auth-field">
        <input
          autoComplete={props.mode === "register" ? "new-password" : "current-password"}
          minLength={12}
          onChange={(event) => props.onPasswordChange(event.target.value)}
          placeholder="Password"
          required
          type="password"
          value={props.password}
        />
        {props.mode === "register" ? <p className="field-hint">Minimum 12 characters</p> : null}
      </div>
      {props.mode === "register" ? (
        <>
          <input
            autoComplete="name"
            onChange={(event) => props.onFullNameChange(event.target.value)}
            placeholder="Full name"
            value={props.fullName}
          />
          <input
            onChange={(event) => props.onTenantNameChange(event.target.value)}
            placeholder="Workspace name"
            value={props.tenantName}
          />
        </>
      ) : null}
      <button className="primary-button w-full" disabled={props.authLoading} type="submit">
        {props.authLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ShieldCheck className="h-4 w-4" />
        )}
        {props.mode === "register" ? "Create account" : "Sign in"}
      </button>
      {props.authStatus ? <p className="status-copy">{props.authStatus}</p> : null}
    </form>
  );
}

function EmptyChat(_props: { onSuggestion: (text: string) => void }) {
  return (
    <div className="empty-chat">
      <div className="empty-chat-mark">
        <Sparkles className="h-8 w-8" />
      </div>
      <p className="eyebrow">Knoviq · Document Intelligence</p>
      <h2>Ask anything about your files.</h2>
      <p>
        Upload a PDF or TXT in the <strong style={{ color: "var(--primary)" }}>Sources</strong>{" "}
        panel on the right, then ask questions here. Answers are grounded in your documents with
        citations.
      </p>
    </div>
  );
}

function SourcesPanel(props: {
  accessToken: string | undefined;
  documentTitle: string;
  documents: DocumentSummary[];
  documentsLoading: boolean;
  onDelete: (document: DocumentSummary) => Promise<void>;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onTitleChange: (value: string) => void;
  onUpload: (event: FormEvent<HTMLFormElement>) => void;
  selectedFile: File | null;
  uploadStatus: string | null;
}) {
  return (
    <div className="inspector-content">
      <form className="source-upload" onSubmit={props.onUpload}>
        <label>
          Title
          <input
            onChange={(event) => props.onTitleChange(event.target.value)}
            value={props.documentTitle}
          />
        </label>
        <label className="compact-upload">
          <Upload className="h-4 w-4" />
          <span className="truncate">
            {props.selectedFile ? props.selectedFile.name : "PDF or TXT"}
          </span>
          <input
            accept=".txt,.text,.pdf,text/plain,application/pdf"
            className="sr-only"
            onChange={props.onFileChange}
            type="file"
          />
        </label>
        <button
          className="primary-button w-full"
          disabled={!props.accessToken || props.documentsLoading}
          type="submit"
        >
          {props.documentsLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          Upload
        </button>
        {props.uploadStatus ? <p className="status-copy">{props.uploadStatus}</p> : null}
      </form>

      <div className="source-list">
        {props.documents.length === 0 ? (
          <p className="muted-copy">No documents in this tenant.</p>
        ) : (
          props.documents.map((document) => (
            <div className="source-row" key={document.documentId}>
              <FileText className="h-4 w-4 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{document.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {document.status} | {document.chunkCount} chunks
                </p>
              </div>
              <button
                className="mini-icon-button"
                disabled={props.documentsLoading}
                onClick={() => void props.onDelete(document)}
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TracePanel(props: { latestAssistant: ChatMessage | undefined; toolCalls: ToolCall[] }) {
  return (
    <div className="inspector-content">
      {props.latestAssistant?.validation ? (
        <div className="validation-panel">
          <div className="flex items-center gap-2">
            {props.latestAssistant.validation.status === "grounded" ? (
              <CheckCircle2 className="h-5 w-5 text-success" />
            ) : (
              <CircleAlert className="h-5 w-5 text-warning" />
            )}
            <span>{props.latestAssistant.validation.status.replace("_", " ")}</span>
          </div>
          <div className="meter mt-4">
            <span
              style={{ width: `${Math.round(props.latestAssistant.validation.confidence * 100)}%` }}
            />
          </div>
          <p className="status-copy">
            Confidence {Math.round(props.latestAssistant.validation.confidence * 100)}%
          </p>
        </div>
      ) : (
        <p className="muted-copy">Run a chat to see validation and tool calls.</p>
      )}

      <div className="trace-list">
        {props.toolCalls.length === 0 ? (
          <p className="muted-copy">No tools used yet.</p>
        ) : (
          props.toolCalls.map((call, index) => (
            <div className="trace-row" key={`${call.toolName}-${index}`}>
              <span className={call.status === "succeeded" ? "status-dot ok" : "status-dot"} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{call.toolName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {call.reason} | {call.latencyMs ?? 0}ms
                </p>
              </div>
            </div>
          ))
        )}
      </div>
      <InvoicePanel toolCalls={props.toolCalls} />
    </div>
  );
}

function MonitorPanel(props: {
  loading: boolean;
  monitor: ReturnType<typeof buildMonitorSummary>;
  onRefresh: () => void;
  status: string | null;
}) {
  return (
    <div className="inspector-content">
      <div className="monitor-header">
        <div>
          <p className="eyebrow">Observability</p>
          <h2>Runtime monitor</h2>
        </div>
        <button className="mini-icon-button" onClick={props.onRefresh} type="button">
          <RefreshCw className={props.loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        </button>
      </div>
      {props.status ? <p className="status-copy">{props.status}</p> : null}
      <div className="metric-grid">
        <MetricTile
          icon={<Clock3 className="h-4 w-4" />}
          label="Avg latency"
          value={`${props.monitor.averageLatencyMs}ms`}
        />
        <MetricTile
          icon={<Gauge className="h-4 w-4" />}
          label="Throughput"
          value={`${props.monitor.requestCount}`}
        />
        <MetricTile
          icon={<Activity className="h-4 w-4" />}
          label="LLM requests"
          value={`${props.monitor.llmRequests}`}
        />
        <MetricTile
          icon={<Receipt className="h-4 w-4" />}
          label="LLM cost"
          value={`$${props.monitor.llmCostUsd}`}
        />
      </div>
      <section className="monitor-section">
        <h3>Service latency</h3>
        {props.monitor.serviceLatency.length === 0 ? (
          <p className="muted-copy">No latency samples yet.</p>
        ) : (
          props.monitor.serviceLatency.map((metric, index) => (
            <div className="metric-row" key={`${metric.service}-${metric.metric}-${index}`}>
              <span>{metric.service}</span>
              <strong>{metric.average}ms</strong>
            </div>
          ))
        )}
      </section>
      <section className="monitor-section">
        <h3>Tool health</h3>
        {props.monitor.toolRows.length === 0 ? (
          <p className="muted-copy">No tool executions yet.</p>
        ) : (
          props.monitor.toolRows.map((row) => (
            <div className="metric-row" key={`${row.toolName}-${row.status}`}>
              <span>
                {row.toolName} | {row.status}
              </span>
              <strong>{row.count}</strong>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function MetricTile(props: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="metric-tile">
      {props.icon}
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function InvoicePanel(props: { toolCalls: ToolCall[] }) {
  const invoiceTool = props.toolCalls.find(
    (call) => call.toolName === "document.extract_invoice_fields",
  );
  const output = parseInvoiceOutput(invoiceTool?.output);

  if (!output) {
    return null;
  }

  return (
    <div className="invoice-panel">
      <div className="flex items-center gap-2">
        <Receipt className="h-4 w-4 text-primary" />
        <span className="font-semibold">Invoice extraction</span>
      </div>
      <div className="mt-3 space-y-2">
        {output.invoices.map((invoice, index) => (
          <div className="invoice-row" key={`${invoice.invoiceNumber ?? "invoice"}-${index}`}>
            <span>{invoice.vendor ?? invoice.invoiceNumber ?? `Invoice ${index + 1}`}</span>
            <strong>
              {output.currency} {invoice.amount.toFixed(2)}
            </strong>
          </div>
        ))}
      </div>
      <div className="invoice-total">
        <span>Total</span>
        <strong>
          {output.currency} {output.totalAmount.toFixed(2)}
        </strong>
      </div>
    </div>
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

function buildMonitorSummary(data: ObservabilityResponse | null) {
  const serviceRows = data?.service_metric_summary?.output?.rows ?? [];
  const llmRows = data?.llm_usage_summary?.output?.rows ?? [];
  const toolRowsRaw = data?.tool_execution_summary?.output?.rows ?? [];
  const requestMetrics = serviceRows.filter(
    (row) => asString(row.metric_name) === "http.server.requests",
  );
  const latencyMetrics = serviceRows.filter(
    (row) => asString(row.metric_name) === "http.server.duration",
  );
  const requestCount = requestMetrics.reduce((sum, row) => sum + asNumber(row.sample_count), 0);
  const averageLatencyMs =
    latencyMetrics.length === 0
      ? 0
      : Math.round(
          latencyMetrics.reduce((sum, row) => sum + asNumber(row.average_value), 0) /
            latencyMetrics.length,
        );
  const llmRequests = llmRows.reduce((sum, row) => sum + asNumber(row.request_count), 0);
  const llmCostUsd = llmRows
    .reduce((sum, row) => sum + asNumber(row.estimated_cost_usd), 0)
    .toFixed(4);

  return {
    averageLatencyMs,
    llmCostUsd,
    llmRequests,
    requestCount,
    // Group by (service, metric) and average across multiple DB rows for the same pair.
    // Multiple rows for the same service+metric arise when the query returns one row
    // per route or time bucket. The panel shows one representative average per pair.
    serviceLatency: (() => {
      const grouped = new Map<
        string,
        { sum: number; count: number; service: string; metric: string }
      >();
      for (const row of latencyMetrics) {
        const svc = asString(row.service_name);
        const met = asString(row.metric_name);
        const key = `${svc}||${met}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.sum += asNumber(row.average_value);
          existing.count += 1;
        } else {
          grouped.set(key, {
            sum: asNumber(row.average_value),
            count: 1,
            service: svc,
            metric: met,
          });
        }
      }
      return [...grouped.values()].slice(0, 6).map((entry) => ({
        average: Math.round(entry.sum / entry.count),
        metric: entry.metric,
        service: entry.service,
      }));
    })(),
    toolRows: toolRowsRaw.slice(0, 8).map((row) => ({
      count: asNumber(row.count),
      status: asString(row.status),
      toolName: asString(row.tool_name),
    })),
  };
}

function parseInvoiceOutput(data: unknown): {
  currency: string;
  invoices: Array<{ amount: number; invoiceNumber?: string; vendor?: string }>;
  totalAmount: number;
} | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const record = data as Record<string, unknown>;

  if (
    typeof record.currency !== "string" ||
    typeof record.totalAmount !== "number" ||
    !Array.isArray(record.invoices)
  ) {
    return null;
  }

  return {
    currency: record.currency,
    invoices: record.invoices.map((item) => {
      const invoice = item as Record<string, unknown>;
      return {
        amount: typeof invoice.amount === "number" ? invoice.amount : 0,
        ...(typeof invoice.invoiceNumber === "string"
          ? { invoiceNumber: invoice.invoiceNumber }
          : {}),
        ...(typeof invoice.vendor === "string" ? { vendor: invoice.vendor } : {}),
      };
    }),
    totalAmount: record.totalAmount,
  };
}

function createThread(): ChatThread {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    id: crypto.randomUUID(),
    messages: [],
    title: "New document chat",
    updatedAt: now,
  };
}

function findLatestAssistant(thread: ChatThread | undefined): ChatMessage | undefined {
  if (!thread) {
    return undefined;
  }

  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.role === "assistant") {
      return message;
    }
  }

  return undefined;
}

function titleFromMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 52) || "Document chat";
}

function extractApiMessage(data: unknown, status: number): string {
  if (isApiErrorBody(data)) {
    return (
      data.error?.message ??
      data.message ??
      data.details ??
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

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fallbackHealthChecks(): HealthCheck[] {
  return [
    { key: "auth", label: "Auth", latencyMs: 0, ok: false, status: 0 },
    { key: "ai", label: "AI Gateway", latencyMs: 0, ok: false, status: 0 },
    { key: "knowledge", label: "Knowledge", latencyMs: 0, ok: false, status: 0 },
    { key: "tools", label: "Tools", latencyMs: 0, ok: false, status: 0 },
  ];
}
