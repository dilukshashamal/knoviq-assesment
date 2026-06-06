"use client";

import { BookOpen, MessageSquare, Search, Sparkles, Upload } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import type { DocumentSummary } from "../types";

// ── Suggestion prompts shown when docs are available ──────────────────────────

const SUGGESTIONS = [
  "Summarise the key points from my documents",
  "What are the main findings?",
  "List all action items or next steps",
  "Compare the documents I've uploaded",
];

// ── Feature tiles ─────────────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: Search,
    title: "Grounded answers",
    desc: "Every response cites the exact source sections it drew from.",
  },
  {
    icon: Upload,
    title: "Upload PDFs & text",
    desc: "Drop in any PDF or text file and ask questions about it instantly.",
  },
  {
    icon: BookOpen,
    title: "Multi-document search",
    desc: "Ask across all your documents at once — no copy-pasting required.",
  },
  {
    icon: MessageSquare,
    title: "Conversation memory",
    desc: "Follow-up questions remember your previous messages in the thread.",
  },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function StartWorkspace(props: {
  accessToken: string | undefined;
  documents: DocumentSummary[];
  onSuggestion?: (text: string) => void;
}) {
  const docCount = props.documents.length;

  return (
    <div className="empty-chat">
      {/* Brand mark */}
      <div className="empty-chat-mark">
        <Sparkles className="h-8 w-8" />
      </div>

      {/* Headline */}
      <div className="empty-chat-copy">
        <p className="eyebrow">Enterprise AI Knowledge Assistant</p>
        <h2>Ask anything about your knowledge base.</h2>
      </div>

      {/* Status copy */}
      <p className="empty-chat-desc">
        {!props.accessToken
          ? "Sign in using the panel on the left to get started."
          : docCount > 0
            ? `${docCount} document${docCount !== 1 ? "s" : ""} ready. Type a question below - answers are grounded in your documents with citations.`
            : "Upload a PDF or TXT in the Sources panel on the right, then ask a question here."}
      </p>

      {/* Suggestion chips — shown when docs are available */}
      {props.accessToken && docCount > 0 && props.onSuggestion ? (
        <div className="suggestion-list">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => props.onSuggestion?.(s)} type="button">
              {s}
            </button>
          ))}
        </div>
      ) : null}

      {/* Feature tiles — shown when no docs yet */}
      {!props.accessToken || docCount === 0 ? (
        <div className="mt-8 grid w-full max-w-2xl grid-cols-2 gap-3">
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <Card key={title} className="border-border/60 bg-surface text-left shadow-none">
              <CardContent className="flex gap-3 p-4">
                <span className="mt-0.5 flex-shrink-0 rounded-lg bg-primary/10 p-2 text-primary">
                  <Icon className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-semibold">{title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}
