"use client";

import type { ChangeEvent, FormEvent } from "react";
import { FileText, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";

import type { DocumentSummary } from "../types";
import { formatDocumentStatus, formatSectionCount } from "../ui-utils";

// ── DocumentPanel ─────────────────────────────────────────────────────────────

export function DocumentPanel(props: {
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
                  {formatDocumentStatus(document.status)} –{" "}
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

// ── UploadForm ────────────────────────────────────────────────────────────────

export function UploadForm(props: {
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
