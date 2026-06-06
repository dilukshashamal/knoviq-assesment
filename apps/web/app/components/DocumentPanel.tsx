"use client";

import type { ChangeEvent, FormEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { DocumentSummary } from "../types";
import { formatDocumentStatus, formatSectionCount } from "../ui-utils";

// ── Status badge ──────────────────────────────────────────────────────────────

function DocumentStatusBadge({ status }: { status: string }) {
  const label = formatDocumentStatus(status);

  if (label === "Ready") {
    return (
      <Badge variant="success" className="gap-1 px-1.5 py-0 text-[10px]">
        <CheckCircle2 className="h-2.5 w-2.5" />
        Ready
      </Badge>
    );
  }

  if (label === "Needs attention") {
    return (
      <Badge variant="destructive" className="gap-1 px-1.5 py-0 text-[10px]">
        <AlertCircle className="h-2.5 w-2.5" />
        Error
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
      <Clock className="h-2.5 w-2.5" />
      Preparing
    </Badge>
  );
}

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
      {/* Header */}
      <div className="drawer-header">
        <div>
          <p className="eyebrow">Documents</p>
          <h2>Sources</h2>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={!props.accessToken || props.documentsLoading}
                onClick={props.onRefresh}
                aria-label="Refresh documents"
              >
                <RefreshCw
                  className={props.documentsLoading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh document list</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Upload form */}
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

      <Separator className="my-1" />

      {/* Document list */}
      <ScrollArea className="flex-1">
        <div className="source-list py-1">
          {props.documents.length === 0 ? (
            <p className="muted-copy px-1 py-3 text-center">
              {props.accessToken ? "No documents yet." : "Sign in to view documents."}
            </p>
          ) : (
            props.documents.map((document) => (
              <div className="source-row" key={document.documentId}>
                <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{document.title}</p>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <DocumentStatusBadge status={document.status} />
                    <span className="text-xs text-muted-foreground">
                      {formatSectionCount(document.chunkCount)}
                    </span>
                  </div>
                </div>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        disabled={props.documentsLoading}
                        onClick={() => void props.onDelete(document)}
                        aria-label={`Delete ${document.title}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete document</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
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
  const isError =
    props.uploadStatus !== null &&
    !props.uploadStatus.toLowerCase().startsWith("uploaded");

  return (
    <form
      className={props.variant === "hero" ? "source-upload hero-upload" : "source-upload"}
      onSubmit={props.onUpload}
    >
      {/* Title */}
      <div className="auth-field">
        <Label className="text-xs font-bold uppercase text-muted-foreground">Title</Label>
        <Input
          onChange={(e) => props.onTitleChange(e.target.value)}
          placeholder="Document title (optional)"
          value={props.documentTitle}
          className="h-8 text-sm"
        />
      </div>

      {/* File picker */}
      <label className="file-drop">
        <Upload className="h-4 w-4 flex-shrink-0" />
        <span className="truncate text-sm">
          {props.selectedFile ? props.selectedFile.name : "Choose PDF or TXT"}
        </span>
        <input
          accept=".txt,.text,.pdf,text/plain,application/pdf"
          className="sr-only"
          onChange={props.onFileChange}
          type="file"
        />
      </label>

      <Button
        className="w-full"
        disabled={!props.accessToken || props.documentsLoading || !props.selectedFile}
        size="sm"
        type="submit"
      >
        {props.documentsLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Upload className="h-4 w-4" />
        )}
        Upload document
      </Button>

      {props.uploadStatus ? (
        <Badge
          variant={isError ? "destructive" : "success"}
          className="w-full justify-center py-1 text-xs"
        >
          {props.uploadStatus}
        </Badge>
      ) : null}
    </form>
  );
}
