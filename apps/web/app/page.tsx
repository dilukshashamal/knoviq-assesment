"use client";

import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MessageSquarePlus, Send, ShieldCheck, Sparkles, Trash2 } from "lucide-react";

import {
  type AuthResponse,
  deletedConversationStorageKey,
  isAdminRole,
  readStoredSession,
  SESSION_STORAGE_KEY,
  threadStorageKey,
} from "@/lib/session";

import type { ApiErrorBody, ChatMessage, ChatResponse, ChatThread, DocumentSummary } from "./types";
import { extractApiMessage, formatSourceCount, getErrorMessage, isChatResponse } from "./ui-utils";
import { AuthForm } from "./components/AuthForm";
import { MessageBubble, TypingIndicator } from "./components/MessageBubble";
import { RightDrawer } from "./components/RightDrawer";
import { StartWorkspace } from "./components/StartWorkspace";

// ── Thread helpers ─────────────────────────────────────────────────────────────

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

function readDeletedConversationIds(userId: string): Set<string> {
  const stored = window.localStorage.getItem(deletedConversationStorageKey(userId));
  if (!stored) return new Set();
  try {
    const parsed = JSON.parse(stored) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    window.localStorage.removeItem(deletedConversationStorageKey(userId));
    return new Set();
  }
}

function rememberDeletedConversationId(userId: string, conversationId: string): void {
  const deletedIds = readDeletedConversationIds(userId);
  deletedIds.add(conversationId);
  window.localStorage.setItem(
    deletedConversationStorageKey(userId),
    JSON.stringify([...deletedIds]),
  );
}

function isVisibleChatMessage(message: ChatMessage): boolean {
  if (message.role !== "user" && message.role !== "assistant") {
    return false;
  }

  if (message.role === "assistant" && looksLikeToolPayload(message.content)) {
    return false;
  }

  return true;
}

function looksLikeToolPayload(content: string): boolean {
  const trimmed = content.trim();
  return (
    (trimmed.startsWith("[{") || trimmed.startsWith("{")) &&
    trimmed.includes('"toolName"') &&
    trimmed.includes('"arguments"')
  );
}

function sanitizeThread(thread: ChatThread): ChatThread {
  return {
    ...thread,
    messages: thread.messages.filter(isVisibleChatMessage),
  };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) throw new Error(extractApiMessage(data, response.status));
  return data as T;
}

// ── Token refresh helper ──────────────────────────────────────────────────────

async function tryRefreshToken(session: AuthResponse): Promise<AuthResponse | null> {
  try {
    const refreshed = await requestJson<AuthResponse>("/api/auth/refresh", {
      body: JSON.stringify({ refreshToken: session.tokens.refreshToken }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(refreshed));
    return refreshed;
  } catch {
    return null;
  }
}

// ── Authenticated fetch with automatic token refresh on 401 ──────────────────
//
// Returns { data, newSession } where newSession is non-null only when a token
// refresh occurred and callers should update their session state.
// Throws if the request fails after a retry, or if the user is not signed in.

async function fetchWithAuth<T>(
  url: string,
  init: RequestInit,
  session: AuthResponse | null,
): Promise<{ data: T; newSession: AuthResponse | null }> {
  const response = await fetch(url, init);

  if (response.status !== 401 || !session) {
    const text = await response.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) throw new Error(extractApiMessage(data, response.status));
    return { data: data as T, newSession: null };
  }

  // 401 — try a silent token refresh then retry once
  const refreshed = await tryRefreshToken(session);
  if (!refreshed) {
    throw new Error("Session expired. Please sign in again.");
  }

  const retryHeaders = {
    ...(init.headers as Record<string, string>),
    authorization: `Bearer ${refreshed.tokens.accessToken}`,
  };
  const retryResponse = await fetch(url, { ...init, headers: retryHeaders });
  const retryText = await retryResponse.text();
  const retryData = retryText ? (JSON.parse(retryText) as unknown) : undefined;
  if (!retryResponse.ok) throw new Error(extractApiMessage(retryData, retryResponse.status));
  return { data: retryData as T, newSession: refreshed };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HomePage() {
  // Auth state
  const [mode, setMode] = useState<"register" | "login">("register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [session, setSession] = useState<AuthResponse | null>(null);
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  // Document state
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [documentTitle, setDocumentTitle] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [documentsLoading, setDocumentsLoading] = useState(false);

  // Chat / thread state
  const [threadState, setThreadState] = useState(() => {
    const thread = createThread();
    return { activeThreadId: thread.id, threads: [thread] };
  });
  const [chatInput, setChatInput] = useState("");
  const [chatStatus, setChatStatus] = useState<string | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  // Inspector: id of the assistant message shown in the right-panel AI Inspector tab
  const [inspectedMessageId, setInspectedMessageId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const accessToken = session?.tokens.accessToken;
  const activeThread = useMemo(
    () =>
      threadState.threads.find((t) => t.id === threadState.activeThreadId) ??
      threadState.threads[0],
    [threadState.activeThreadId, threadState.threads],
  );

  // The message currently shown in the AI Inspector panel.
  // Defaults to the latest assistant message in the active thread.
  const inspectedMessage = useMemo<ChatMessage | null>(() => {
    if (!activeThread) return null;
    const msgs = activeThread.messages;
    // If user has explicitly clicked a message, use that
    if (inspectedMessageId) {
      const found = msgs.find((m) => m.id === inspectedMessageId && m.role === "assistant");
      if (found) return found;
    }
    // Otherwise auto-select the latest assistant message that has data
    const latest = [...msgs].reverse().find((m) => m.role === "assistant" && m.content !== "");
    return latest ?? null;
  }, [activeThread, inspectedMessageId]);

  // Restore session + threads from localStorage on mount
  useEffect(() => {
    const stored = readStoredSession();
    if (stored) {
      setSession(stored);
      setEmail(stored.user.email);
      restoreThreads(stored.user.userId);
    }
    setStorageReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist threads to localStorage whenever they change
  useEffect(() => {
    if (storageReady && session) {
      window.localStorage.setItem(
        threadStorageKey(session.user.userId),
        JSON.stringify(threadState),
      );
    }
  }, [storageReady, session, threadState]);

  // Refresh documents whenever the access token changes (login / page load)
  useEffect(() => {
    if (accessToken) void refreshDocuments(accessToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  // Auto-scroll to the latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeThread?.messages.length, chatLoading]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [chatInput]);

  // ── Auth ────────────────────────────────────────────────────────────────────

  async function handleAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthLoading(true);
    setAuthStatus(null);
    try {
      const body =
        mode === "register" ? { email, fullName, password, tenantName } : { email, password };
      const response = await requestJson<AuthResponse>(`/api/auth/${mode}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      setSession(response);
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(response));
      await restoreConversationHistory(response.tokens.accessToken, response.user.userId);
      setAuthStatus(`Signed in to ${response.user.tenantName}`);
    } catch (error) {
      setAuthStatus(getErrorMessage(error));
    } finally {
      setAuthLoading(false);
    }
  }

  function handleSignOut() {
    // Clear the persisted thread history for this user before wiping the session,
    // otherwise stale threads survive in localStorage and reappear on next login.
    if (session?.user.userId) {
      window.localStorage.removeItem(threadStorageKey(session.user.userId));
    }
    const fresh = createThread();
    setThreadState({ activeThreadId: fresh.id, threads: [fresh] });
    setSession(null);
    setDocuments([]);
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  }

  // ── Documents ───────────────────────────────────────────────────────────────

  async function handleUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || !selectedFile) {
      setUploadStatus(!accessToken ? "Sign in before uploading." : "Choose a file first.");
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
      const { newSession } = await fetchWithAuth<unknown>(
        "/api/documents",
        {
          body: formData,
          headers: { authorization: `Bearer ${accessToken}` },
          method: "POST",
        },
        session,
      );
      if (newSession) setSession(newSession);
      setUploadStatus(`Uploaded ${selectedFile.name}`);
      setDocumentTitle("");
      setSelectedFile(null);
      await refreshDocuments(newSession?.tokens.accessToken ?? accessToken);
    } catch (error) {
      setUploadStatus(getErrorMessage(error));
    } finally {
      setDocumentsLoading(false);
    }
  }

  async function handleDeleteDocument(document: DocumentSummary) {
    if (!accessToken) {
      setUploadStatus("Sign in before deleting.");
      return;
    }
    if (!window.confirm(`Delete "${document.title}"?`)) return;
    setDocumentsLoading(true);
    setUploadStatus(null);
    try {
      const { newSession } = await fetchWithAuth<void>(
        `/api/documents/${document.documentId}`,
        {
          headers: { authorization: `Bearer ${accessToken}` },
          method: "DELETE",
        },
        session,
      );
      if (newSession) setSession(newSession);
      setUploadStatus(`Deleted ${document.title}`);
      await refreshDocuments(newSession?.tokens.accessToken ?? accessToken);
    } catch (error) {
      setUploadStatus(getErrorMessage(error));
    } finally {
      setDocumentsLoading(false);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    if (file && !documentTitle) setDocumentTitle(file.name.replace(/\.[^.]+$/, ""));
  }

  async function refreshDocuments(token = accessToken) {
    if (!token) return;
    setDocumentsLoading(true);
    try {
      const { data, newSession } = await fetchWithAuth<{ documents: DocumentSummary[] }>(
        "/api/documents",
        { headers: { authorization: `Bearer ${token}` } },
        session,
      );
      if (newSession) setSession(newSession);
      setDocuments(data.documents);
    } catch (error) {
      const msg = getErrorMessage(error);
      // If both tokens are expired, clear the session so the user sees the login form
      // instead of a confusing error message.
      if (
        msg.toLowerCase().includes("session expired") ||
        msg.toLowerCase().includes("sign in again")
      ) {
        const fresh = createThread();
        setThreadState({ activeThreadId: fresh.id, threads: [fresh] });
        setSession(null);
        setDocuments([]);
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
        setAuthStatus("Your session expired. Please sign in again.");
      }
      // Other errors (network down, etc.) can be silently ignored for document loading —
      // the documents panel will just stay empty and show "No documents yet."
    } finally {
      setDocumentsLoading(false);
    }
  }

  // ── Conversation history ────────────────────────────────────────────────────

  async function restoreConversationHistory(token: string, userId: string) {
    try {
      const result = await requestJson<{
        conversations: Array<{
          id: string;
          title: string | null;
          lastMessageAt: string;
          createdAt: string;
        }>;
      }>("/api/conversations", {
        headers: { authorization: `Bearer ${token}` },
      });

      const deletedIds = readDeletedConversationIds(userId);
      const visibleConversations = result.conversations.filter((conv) => !deletedIds.has(conv.id));

      if (visibleConversations.length === 0) {
        const fresh = createThread();
        setThreadState({ activeThreadId: fresh.id, threads: [fresh] });
        return;
      }

      const backendThreads: ChatThread[] = visibleConversations.map((conv) => ({
        conversationId: conv.id,
        createdAt: conv.createdAt,
        id: conv.id,
        messages: [],
        title: conv.title ?? "Conversation",
        updatedAt: conv.lastMessageAt,
      }));

      const fresh = createThread();
      setThreadState({
        activeThreadId: fresh.id,
        threads: [fresh, ...backendThreads],
      });
    } catch {
      restoreThreads(userId);
    }
  }

  function restoreThreads(userId: string) {
    const fresh = createThread();
    const defaultState = { activeThreadId: fresh.id, threads: [fresh] };
    const stored = window.localStorage.getItem(threadStorageKey(userId));
    if (!stored) {
      setThreadState(defaultState);
      return;
    }
    try {
      const parsed = JSON.parse(stored) as { activeThreadId: string; threads: ChatThread[] };
      const threads = parsed.threads
        .map(sanitizeThread)
        .filter((thread) => thread.messages.length > 0);
      setThreadState(
        threads.length > 0
          ? {
              activeThreadId: threads.some((thread) => thread.id === parsed.activeThreadId)
                ? parsed.activeThreadId
                : (threads[0]?.id ?? fresh.id),
              threads,
            }
          : defaultState,
      );
    } catch {
      window.localStorage.removeItem(threadStorageKey(userId));
      setThreadState(defaultState);
    }
  }

  // ── Lazy-load conversation messages from backend ───────────────────────────

  const handleSelectThread = useCallback(
    async (threadId: string) => {
      setThreadState((c) => ({ ...c, activeThreadId: threadId }));
      const thread = threadState.threads.find((t) => t.id === threadId);

      // Only fetch if this is a backend-persisted conversation with no messages yet
      if (!thread?.conversationId || thread.messages.length > 0 || !accessToken) return;

      setLoadingConversationId(thread.conversationId);
      try {
        const { data, newSession } = await fetchWithAuth<{
          messages: Array<{
            id: string;
            role: "user" | "assistant";
            content: string;
            createdAt: string;
            toolCalls?: ChatMessage["toolCalls"];
            validation?: ChatMessage["validation"];
          }>;
        }>(
          `/api/conversations/${thread.conversationId}/messages`,
          { headers: { authorization: `Bearer ${accessToken}` } },
          session,
        );
        if (newSession) setSession(newSession);

        setThreadState((current) => ({
          ...current,
          threads: current.threads.map((t) =>
            t.id !== threadId
              ? t
              : {
                  ...t,
                  messages: data.messages
                    .map((m) => ({
                      content: m.content,
                      createdAt: m.createdAt,
                      id: m.id,
                      role: m.role,
                      ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
                      ...(m.validation ? { validation: m.validation } : {}),
                    }))
                    .filter(isVisibleChatMessage) as ChatMessage[],
                },
          ),
        }));
      } catch {
        // Silently ignore — thread will just stay empty
      } finally {
        setLoadingConversationId(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accessToken, threadState.threads],
  );

  // ── Thread management ────────────────────────────────────────────────────────

  function handleNewChat() {
    const thread = createThread();
    setThreadState((current) => ({
      activeThreadId: thread.id,
      threads: [thread, ...current.threads],
    }));
    setChatInput("");
    setChatStatus(null);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  function handleDeleteThread(threadId: string) {
    const thread = threadState.threads.find((t) => t.id === threadId);

    setThreadState((current) => {
      const remaining = current.threads.filter((t) => t.id !== threadId);
      if (remaining.length === 0) {
        const fresh = createThread();
        return { activeThreadId: fresh.id, threads: [fresh] };
      }
      const nextId =
        current.activeThreadId === threadId ? (remaining[0]?.id ?? "") : current.activeThreadId;
      return { activeThreadId: nextId, threads: remaining };
    });

    if (thread?.conversationId && accessToken) {
      if (session?.user.userId) {
        rememberDeletedConversationId(session.user.userId, thread.conversationId);
      }

      // Also delete from the backend. Keeping the local tombstone above makes
      // the UI resilient if this request fails or the dev server is stale.
      void deleteConversationFromBackend(thread.conversationId, accessToken);
    }
  }

  async function deleteConversationFromBackend(
    conversationId: string,
    token: string,
  ): Promise<void> {
    try {
      const { newSession } = await fetchWithAuth<void>(
        `/api/conversations/${conversationId}`,
        { headers: { authorization: `Bearer ${token}` }, method: "DELETE" },
        session,
      );
      if (newSession) setSession(newSession);
    } catch (error) {
      // The thread is already removed from the UI, but the backend delete failed.
      // Warn the user so they know the conversation may reappear on next login.
      setChatStatus(
        `Could not delete conversation from server: ${getErrorMessage(error)}. It may reappear after you sign in again.`,
      );
    }
  }

  function upsertThread(next: ChatThread | ((current: ChatThread) => ChatThread)) {
    setThreadState((current) => {
      const existing =
        current.threads.find((t) => t.id === current.activeThreadId) ??
        current.threads[0] ??
        createThread();
      const nextThread = typeof next === "function" ? next(existing) : next;
      const remaining = current.threads.filter((t) => t.id !== nextThread.id);
      return { activeThreadId: nextThread.id, threads: [nextThread, ...remaining] };
    });
  }

  // ── Keyboard shortcut: Shift+Enter = newline, Enter alone = submit ───────────

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!chatLoading && chatInput.trim()) {
        void handleChat(event as unknown as React.FormEvent<HTMLFormElement>);
      }
    }
  }

  // ── Chat ──────────────────────────────────────────────────────────────────────

  async function handleChat(event: React.FormEvent<HTMLFormElement> | React.FormEvent) {
    event.preventDefault();
    if (!accessToken) {
      setChatStatus("Sign in before asking the assistant.");
      return;
    }
    const trimmed = chatInput.trim();
    if (!trimmed || !activeThread) return;

    const threadBeforeRun = activeThread;
    const now = new Date().toISOString();
    const assistantId = crypto.randomUUID();

    setThreadState((current) => {
      const existing =
        current.threads.find((t) => t.id === current.activeThreadId) ??
        current.threads[0] ??
        createThread();
      const updated: ChatThread = {
        ...existing,
        ...(threadBeforeRun.conversationId
          ? { conversationId: threadBeforeRun.conversationId }
          : {}),
        messages: [
          ...existing.messages,
          { content: trimmed, createdAt: now, id: crypto.randomUUID(), role: "user" as const },
          { content: "", createdAt: now, id: assistantId, role: "assistant" as const },
        ],
        title: existing.messages.length === 0 ? titleFromMessage(trimmed) : existing.title,
        updatedAt: now,
      };
      const remaining = current.threads.filter((t) => t.id !== updated.id);
      return { activeThreadId: updated.id, threads: [updated, ...remaining] };
    });

    setChatInput("");
    setChatLoading(true);
    setChatStatus(null);

    let timeoutId: number | undefined;
    let currentToken = accessToken;

    try {
      const body = JSON.stringify({
        ...(threadBeforeRun.conversationId
          ? { conversationId: threadBeforeRun.conversationId }
          : {}),
        message: trimmed,
      });

      const controller = new AbortController();
      timeoutId = window.setTimeout(() => controller.abort(), 120_000);

      let response = await fetch("/api/chat/stream", {
        body,
        headers: { authorization: `Bearer ${currentToken}`, "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });

      // ── Auto-refresh token on 401 ────────────────────────────────────────────
      if (response.status === 401 && session) {
        const refreshed = await tryRefreshToken(session);
        if (refreshed) {
          setSession(refreshed);
          currentToken = refreshed.tokens.accessToken;
          response = await fetch("/api/chat/stream", {
            body,
            headers: {
              authorization: `Bearer ${currentToken}`,
              "content-type": "application/json",
            },
            method: "POST",
            signal: controller.signal,
          });
        }
      }

      if (!response.ok) {
        let errorMsg = `Request failed (${response.status.toString()})`;
        try {
          errorMsg = extractApiMessage(
            JSON.parse(await response.text()) as ApiErrorBody,
            response.status,
          );
        } catch {
          /* ignore */
        }
        throw new Error(errorMsg);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult: ChatResponse | null = null;

      const processSseBlock = (block: string): void => {
        if (!block.trim()) return;
        const lines = block.replace(/\r\n/g, "\n").split("\n");
        const dataLines: string[] = [];
        let eventType = "message";
        for (const line of lines) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (dataLines.length === 0) return;
        const rawData = dataLines.join("\n");
        if (eventType === "done") return;
        if (eventType === "error") {
          let msg = "Streaming chat failed";
          try {
            msg = extractApiMessage(JSON.parse(rawData) as ApiErrorBody, 500);
          } catch {
            /* ignore */
          }
          throw new Error(msg);
        }
        if (eventType !== "final") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawData);
        } catch {
          return;
        }
        if (!isChatResponse(parsed)) return;
        finalResult = parsed;
        setThreadState((current) => ({
          ...current,
          threads: current.threads.map((thread) =>
            thread.id !== current.activeThreadId
              ? thread
              : {
                  ...thread,
                  conversationId: finalResult!.conversationId,
                  messages: thread.messages.map((msg) =>
                    msg.id === assistantId
                      ? {
                          ...msg,
                          content: finalResult!.answer,
                          toolCalls: finalResult!.toolCalls,
                          validation: finalResult!.validation,
                        }
                      : msg,
                  ),
                },
          ),
        }));
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const tail = decoder.decode();
          if (tail) buffer += tail;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) processSseBlock(block);
      }
      if (buffer.trim()) processSseBlock(buffer);
      if (!finalResult) throw new Error("No answer received from the assistant. Please retry.");
      // Auto-select the completed response in the inspector panel
      setInspectedMessageId(assistantId);
      setChatStatus("Answer ready.");
    } catch (error) {
      upsertThread((current) => ({
        ...current,
        messages: current.messages.filter((m) => m.id !== assistantId),
      }));
      setChatStatus(getErrorMessage(error));
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      setChatLoading(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <main className="app-shell">
      {/* Left rail — navigation + auth */}
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
                  onClick={() => void handleSelectThread(thread.id)}
                  type="button"
                >
                  <MessageSquarePlus className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {loadingConversationId === thread.conversationId ? (
                      <span className="italic text-muted-foreground">Loading…</span>
                    ) : (
                      thread.title
                    )}
                  </span>
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
              onSubmit={(e) => void handleAuth(e)}
              onTenantNameChange={setTenantName}
              password={password}
              tenantName={tenantName}
            />
          )}
        </section>
      </aside>

      {/* Centre — chat messages + composer */}
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
              <MessageBubble
                key={message.id}
                message={message}
                isInspected={
                  inspectedMessageId === message.id ||
                  (inspectedMessageId === null && message === inspectedMessage)
                }
                onInspect={
                  message.role === "assistant" ? () => setInspectedMessageId(message.id) : undefined
                }
              />
            ))
          ) : (
            <StartWorkspace
              accessToken={accessToken}
              documents={documents}
              onSuggestion={(text) => {
                setChatInput(text);
                setTimeout(() => textareaRef.current?.focus(), 50);
              }}
            />
          )}
          {chatLoading &&
          !activeThread?.messages.some((m) => m.role === "assistant" && m.content === "") ? (
            <TypingIndicator />
          ) : null}
          <div ref={messagesEndRef} />
        </div>

        <form className="composer" onSubmit={(e) => void handleChat(e)}>
          <textarea
            ref={textareaRef}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your documents… (Enter to send, Shift+Enter for newline)"
            rows={1}
            value={chatInput}
            aria-label="Chat message"
          />
          <button
            disabled={chatLoading || !chatInput.trim()}
            title="Send message (Enter)"
            type="submit"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
        {chatStatus ? <p className="composer-status">{chatStatus}</p> : null}
      </section>

      {/* Right drawer — documents + AI Inspector */}
      <aside className="document-drawer">
        <RightDrawer
          accessToken={accessToken}
          documentTitle={documentTitle}
          documents={documents}
          documentsLoading={documentsLoading}
          onDelete={handleDeleteDocument}
          onFileChange={handleFileChange}
          onRefresh={() => void refreshDocuments()}
          onTitleChange={setDocumentTitle}
          onUpload={(e) => void handleUpload(e)}
          selectedFile={selectedFile}
          uploadStatus={uploadStatus}
          activeMessage={inspectedMessage}
        />
      </aside>
    </main>
  );
}
