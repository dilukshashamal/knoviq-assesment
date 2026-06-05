"use client";

import { type ChangeEvent, type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  CircleAlert,
  FileText,
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
} from "lucide-react";

import {
  type AuthResponse,
  isAdminRole,
  readStoredSession,
  SESSION_STORAGE_KEY,
  threadStorageKey,
} from "@/lib/session";

interface DocumentSummary {
  chunkCount: number;
  createdAt: string;
  documentId: string;
  filename: string;
  status: string;
  title: string;
  visibility: string;
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

interface SourceReference {
  chunkId: string;
  documentTitle: string;
  excerpt?: string;
  pageLabel: string;
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
  const [storageReady, setStorageReady] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const accessToken = session?.tokens.accessToken;
  const activeThread = useMemo(
    () =>
      threadState.threads.find((thread) => thread.id === threadState.activeThreadId) ??
      threadState.threads[0],
    [threadState.activeThreadId, threadState.threads],
  );

  useEffect(() => {
    const storedSession = readStoredSession();

    if (storedSession) {
      setSession(storedSession);
      setEmail(storedSession.user.email);
      restoreThreads(storedSession.user.userId);
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
    if (accessToken) {
      void refreshDocuments(accessToken);
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
      restoreThreads(response.user.userId);
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
      setDocumentTitle("");
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
      setChatStatus("Answer ready.");
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

    const confirmed = window.confirm(`Delete "${document.title}"?`);

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

    if (file && !documentTitle) {
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
      const remaining = current.threads.filter((thread) => thread.id !== threadId);

      if (remaining.length === 0) {
        const fresh = createThread();
        return { activeThreadId: fresh.id, threads: [fresh] };
      }

      const nextActiveId =
        current.activeThreadId === threadId ? (remaining[0]?.id ?? "") : current.activeThreadId;

      return { activeThreadId: nextActiveId, threads: remaining };
    });
  }

  function handleSignOut() {
    const freshThread = createThread();
    setThreadState({ activeThreadId: freshThread.id, threads: [freshThread] });
    setSession(null);
    setDocuments([]);
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  }

  function restoreThreads(userId: string) {
    const freshThread = createThread();
    const defaultState = { activeThreadId: freshThread.id, threads: [freshThread] };
    const storedThreads = window.localStorage.getItem(threadStorageKey(userId));

    if (!storedThreads) {
      setThreadState(defaultState);
      return;
    }

    try {
      const parsed = JSON.parse(storedThreads) as {
        activeThreadId: string;
        threads: ChatThread[];
      };
      setThreadState(parsed.threads.length > 0 ? parsed : defaultState);
    } catch {
      window.localStorage.removeItem(threadStorageKey(userId));
      setThreadState(defaultState);
    }
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
            <p className="brand-subtitle">Document chat</p>
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

        <section className="rail-section rail-auth">
          {session ? (
            <div className="session-box">
              <p className="session-name">{session.user.fullName || session.user.email}</p>
              <p className="status-copy">Workspace: {session.user.tenantName}</p>
              {isAdminRole(session.user.role) ? (
                <a className="secondary-button w-full" href="/admin/monitoring">
                  <ShieldCheck className="h-4 w-4" />
                  Admin console
                </a>
              ) : null}
              <button className="secondary-button w-full" onClick={handleSignOut} type="button">
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
            <p className="eyebrow">Workspace</p>
            <h1>{activeThread?.title ?? "New document chat"}</h1>
          </div>
          <div className="service-strip">
            <span className={documents.length > 0 ? "service-pill ok" : "service-pill"}>
              {formatSourceCount(documents.length)}
            </span>
          </div>
        </header>

        <div className="message-scroll">
          {activeThread?.messages.length ? (
            activeThread.messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))
          ) : (
            <StartWorkspace accessToken={accessToken} documents={documents} />
          )}
          {chatLoading ? (
            <article className="message-row assistant">
              <div className="message-avatar">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="message-bubble typing">
                <Loader2 className="h-4 w-4 animate-spin" />
                Reading your documents
              </div>
            </article>
          ) : null}
          <div ref={messagesEndRef} />
        </div>

        <form className="composer" onSubmit={(event) => void handleChat(event)}>
          <textarea
            onChange={(event) => setChatInput(event.target.value)}
            placeholder="Ask about your documents..."
            rows={1}
            value={chatInput}
          />
          <button disabled={chatLoading || !chatInput.trim()} title="Send message" type="submit">
            {chatLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </form>
        {chatStatus ? <p className="composer-status">{chatStatus}</p> : null}
      </section>

      <aside className="document-drawer">
        <DocumentPanel
          accessToken={accessToken}
          documentTitle={documentTitle}
          documents={documents}
          documentsLoading={documentsLoading}
          onDelete={handleDeleteDocument}
          onFileChange={handleFileChange}
          onRefresh={() => void refreshDocuments()}
          onTitleChange={setDocumentTitle}
          onUpload={handleUpload}
          selectedFile={selectedFile}
          uploadStatus={uploadStatus}
        />
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

function StartWorkspace(props: { accessToken: string | undefined; documents: DocumentSummary[] }) {
  const docCount = props.documents.length;

  return (
    <div className="empty-chat">
      <div className="empty-chat-mark">
        <Sparkles className="h-8 w-8" />
      </div>
      <div className="empty-chat-copy">
        <p className="eyebrow">Enterprise AI Knowledge Assistant</p>
        <h2>Ask anything about your knowledge base.</h2>
      </div>
      <p className="empty-chat-desc">
        {!props.accessToken
          ? "Sign in using the panel on the left to get started."
          : docCount > 0
            ? `${docCount} document${docCount !== 1 ? "s" : ""} ready. Type a question below — answers are grounded in your documents with citations.`
            : "Upload a PDF or TXT in the Sources panel on the right, then ask a question here."}
      </p>
    </div>
  );
}

function DocumentPanel(props: {
  accessToken: string | undefined;
  documentTitle: string;
  documents: DocumentSummary[];
  documentsLoading: boolean;
  onDelete: (document: DocumentSummary) => Promise<void>;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onRefresh: () => void;
  onTitleChange: (value: string) => void;
  onUpload: (event: FormEvent<HTMLFormElement>) => void;
  selectedFile: File | null;
  uploadStatus: string | null;
}) {
  return (
    <>
      <div className="drawer-header">
        <div>
          <p className="eyebrow">Documents</p>
          <h2>Sources</h2>
        </div>
        <button
          className="mini-icon-button"
          disabled={!props.accessToken || props.documentsLoading}
          onClick={props.onRefresh}
          title="Refresh documents"
          type="button"
        >
          <RefreshCw className={props.documentsLoading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        </button>
      </div>
      <UploadForm
        accessToken={props.accessToken}
        documentTitle={props.documentTitle}
        documentsLoading={props.documentsLoading}
        onFileChange={props.onFileChange}
        onTitleChange={props.onTitleChange}
        onUpload={props.onUpload}
        selectedFile={props.selectedFile}
        uploadStatus={props.uploadStatus}
        variant="compact"
      />
      <div className="source-list">
        {props.documents.length === 0 ? (
          <p className="muted-copy">No documents yet.</p>
        ) : (
          props.documents.map((document) => (
            <div className="source-row" key={document.documentId}>
              <FileText className="h-4 w-4 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{document.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {formatDocumentStatus(document.status)} -{" "}
                  {formatSectionCount(document.chunkCount)}
                </p>
              </div>
              <button
                className="mini-icon-button"
                disabled={props.documentsLoading}
                onClick={() => void props.onDelete(document)}
                title={`Delete ${document.title}`}
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function UploadForm(props: {
  accessToken: string | undefined;
  documentTitle: string;
  documentsLoading: boolean;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onTitleChange: (value: string) => void;
  onUpload: (event: FormEvent<HTMLFormElement>) => void;
  selectedFile: File | null;
  uploadStatus: string | null;
  variant: "compact" | "hero";
}) {
  return (
    <form
      className={props.variant === "hero" ? "source-upload hero-upload" : "source-upload"}
      onSubmit={props.onUpload}
    >
      <label>
        Title
        <input
          onChange={(event) => props.onTitleChange(event.target.value)}
          placeholder="Document title"
          value={props.documentTitle}
        />
      </label>
      <label className="file-drop">
        <Upload className="h-4 w-4" />
        <span className="truncate">
          {props.selectedFile ? props.selectedFile.name : "Choose PDF or TXT"}
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
        Upload document
      </button>
      {props.uploadStatus ? <p className="status-copy">{props.uploadStatus}</p> : null}
    </form>
  );
}

function MessageBubble(props: { message: ChatMessage }) {
  const sources = extractSources(props.message.toolCalls ?? []);

  return (
    <article
      className={props.message.role === "user" ? "message-row user" : "message-row assistant"}
    >
      <div className="message-avatar">
        {props.message.role === "user" ? "You" : <Sparkles className="h-4 w-4" />}
      </div>
      <div className="message-bubble">
        <div className="message-meta">
          <span>{props.message.role === "user" ? "You" : "Knoviq"}</span>
          <span>{formatTime(props.message.createdAt)}</span>
        </div>
        <p>{props.message.content}</p>
        {props.message.role === "assistant" ? (
          <>
            <EvidenceChip sourcesCount={sources.length} validation={props.message.validation} />
            <MessageSources sources={sources} />
            <InvoiceSummary toolCalls={props.message.toolCalls ?? []} />
          </>
        ) : null}
      </div>
    </article>
  );
}

function EvidenceChip(props: {
  sourcesCount: number;
  validation: ChatResponse["validation"] | undefined;
}) {
  if (!props.validation) {
    return null;
  }

  if (props.validation.status === "unsupported") {
    return (
      <div className="validation-chip warning">
        <CircleAlert className="h-3.5 w-3.5" />
        Not enough document evidence
      </div>
    );
  }

  return (
    <div className="validation-chip">
      <CheckCircle2 className="h-3.5 w-3.5" />
      {props.sourcesCount > 0
        ? `Answered from ${props.sourcesCount} source${props.sourcesCount === 1 ? "" : "s"}`
        : "Answer checked"}
    </div>
  );
}

function MessageSources(props: { sources: SourceReference[] }) {
  if (props.sources.length === 0) {
    return null;
  }

  return (
    <details className="message-sources">
      <summary>
        <BookOpen className="h-3.5 w-3.5" />
        Sources
      </summary>
      <div className="source-excerpts">
        {props.sources.map((source) => (
          <div className="source-excerpt" key={source.chunkId}>
            <strong>{source.documentTitle}</strong>
            <span>{source.pageLabel}</span>
            {source.excerpt ? <p>{source.excerpt}</p> : null}
          </div>
        ))}
      </div>
    </details>
  );
}

function InvoiceSummary(props: { toolCalls: ToolCall[] }) {
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
        <span className="font-semibold">Extracted expenses</span>
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

function extractSources(toolCalls: ToolCall[]): SourceReference[] {
  const sources: SourceReference[] = [];
  const seen = new Set<string>();

  for (const call of toolCalls) {
    if (call.toolName !== "knowledge.retrieve" || call.status !== "succeeded") {
      continue;
    }

    const results = parseRetrievalResults(call.output);

    for (const result of results) {
      if (seen.has(result.chunkId)) {
        continue;
      }

      seen.add(result.chunkId);
      sources.push(result);
    }
  }

  return sources.slice(0, 5);
}

function parseRetrievalResults(output: unknown): SourceReference[] {
  if (!output || typeof output !== "object") {
    return [];
  }

  const results = (output as { results?: unknown[] }).results;

  if (!Array.isArray(results)) {
    return [];
  }

  return results.flatMap((result) => {
    if (!result || typeof result !== "object") {
      return [];
    }

    const record = result as Record<string, unknown>;
    const chunkId = typeof record.chunkId === "string" ? record.chunkId : crypto.randomUUID();
    const documentTitle =
      typeof record.documentTitle === "string" ? record.documentTitle : "Uploaded document";
    const pageStart = typeof record.sourcePageStart === "number" ? record.sourcePageStart : null;
    const excerpt =
      typeof record.chunkContent === "string" ? truncateText(record.chunkContent, 220) : undefined;

    return [
      {
        chunkId,
        documentTitle,
        ...(excerpt ? { excerpt } : {}),
        pageLabel: pageStart ? `Page ${pageStart}` : "Matched section",
      },
    ];
  });
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

function formatSourceCount(count: number): string {
  if (count === 0) {
    return "No sources yet";
  }

  return `${count} source${count === 1 ? "" : "s"} ready`;
}

function formatSectionCount(count: number): string {
  return `${count} section${count === 1 ? "" : "s"}`;
}

function formatDocumentStatus(status: string): string {
  switch (status.toLowerCase()) {
    case "completed":
    case "processed":
    case "ready":
      return "Ready";
    case "failed":
    case "error":
      return "Needs attention";
    case "processing":
    case "queued":
    case "uploaded":
      return "Preparing";
    default:
      return titleCase(status);
  }
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function truncateText(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}...` : collapsed;
}
