"use client";

import { Sparkles } from "lucide-react";

import type { DocumentSummary } from "../types";

export function StartWorkspace(props: {
  accessToken: string | undefined;
  documents: DocumentSummary[];
}) {
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
