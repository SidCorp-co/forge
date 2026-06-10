"use client";

// Comment thread for the issue detail. Renders the nested comment tree with a
// derived lifecycle-kind badge (`deriveCommentKind`), markdown body (inline
// images resolve via the design Markdown's `coreFileUrl` mapping), author
// initials resolved against the project members, and reply/add boxes.

import { type ClipboardEvent, type DragEvent, useCallback, useRef, useState } from "react";
import { formatRelativeTime } from "@/lib/utils/format";
import { Avatar, Badge, Banner, Button, EmptyState, Icon, IconButton, Markdown, Textarea } from "@/design";
import { COMMENT_KIND_META, deriveCommentKind, initials, memberLabel } from "../derive";
import { useCreateComment } from "../detail-hooks";
import type { CommentNode, ProjectMember } from "../types";
import { AttachmentList } from "./attachment-list";

// Comment attachment staging limits — mirror core's comment allow-list
// (`attachment-service.ts` ALLOWED_MIMES). NOTE: narrower than issue
// attachments — NO video for comments — so the server never 400s what we
// staged client-side.
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
const ALLOWED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
]);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AddCommentBox({
  issueId,
  parentId,
  placeholder,
  onDone,
}: {
  issueId: string;
  parentId?: string;
  placeholder: string;
  onDone?: () => void;
}) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const create = useCreateComment(issueId);

  // Validate + stage picked/dropped/pasted files against the comment allow-list
  // (size/mime/count caps) so the server never rejects what we accepted.
  const acceptFiles = useCallback((picked: FileList | File[]) => {
    const accepted: File[] = [];
    const errs: string[] = [];
    for (const f of Array.from(picked)) {
      if (f.size <= 0) {
        errs.push(`Empty file skipped: ${f.name || "(unnamed)"}`);
        continue;
      }
      if (f.size > MAX_BYTES) {
        errs.push(`Too large (max 10 MB): ${f.name || "(unnamed)"}`);
        continue;
      }
      const mime = f.type || "application/octet-stream";
      if (!ALLOWED_MIMES.has(mime)) {
        errs.push(`File type not allowed: ${f.name || mime}`);
        continue;
      }
      accepted.push(f);
    }
    setFiles((prev) => {
      const room = MAX_FILES - prev.length;
      if (accepted.length > room) {
        errs.push(`Max ${MAX_FILES} attachments per comment. Extras skipped.`);
      }
      return [...prev, ...accepted.slice(0, Math.max(0, room))];
    });
    setWarnings(errs);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files?.length) acceptFiles(e.dataTransfer.files);
    },
    [acceptFiles],
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files?.length) acceptFiles(e.target.files);
      e.target.value = "";
    },
    [acceptFiles],
  );

  // Clipboard paste of a copied/screenshotted image. Only image file blobs are
  // pulled in; pasted text falls through to the Textarea so we never
  // double-insert. Clipboard images often have an empty name → supply one.
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const blobs: File[] = [];
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (!file) continue;
          if (file.name) {
            blobs.push(file);
          } else {
            const ext = item.type.split("/")[1] ?? "png";
            blobs.push(new File([file], `pasted-${blobs.length + 1}.${ext}`, { type: item.type }));
          }
        }
      }
      if (blobs.length) {
        e.preventDefault();
        acceptFiles(blobs);
      }
    },
    [acceptFiles],
  );

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setWarnings([]);
  };

  const submit = () => {
    const text = body.trim();
    if (!text) return;
    create.mutate(
      { body: text, parentId, files },
      {
        onSuccess: () => {
          setBody("");
          setFiles([]);
          setWarnings([]);
          onDone?.();
        },
      },
    );
  };
  return (
    <div className="space-y-2" onPaste={onPaste}>
      <div
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        className={`rounded-lg transition-colors ${
          dragOver ? "ring-2 ring-cobalt-400 ring-offset-1" : ""
        }`}
      >
        <Textarea
          rows={parentId ? 2 : 3}
          placeholder={placeholder}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>

      {warnings.length > 0 && (
        <Banner tone="attention">
          <ul className="space-y-0.5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Banner>
      )}

      {files.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="flex items-center gap-2.5 rounded-md border border-line-subtle bg-surface px-2.5 py-1.5"
            >
              <Icon
                name={f.type.startsWith("image/") ? "grid" : "folder"}
                size={15}
                className="flex-none text-subtle"
              />
              <span className="fg-body-sm min-w-0 flex-1 truncate text-fg" title={f.name}>
                {f.name}
              </span>
              <span className="fg-caption flex-none">{formatSize(f.size)}</span>
              <IconButton
                type="button"
                icon="x"
                size="sm"
                aria-label={`Remove ${f.name}`}
                onClick={() => removeFile(i)}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon="plus"
          onClick={() => fileInputRef.current?.click()}
        >
          Attach
        </Button>
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onPick} />
        <div className="flex gap-2">
          {onDone && (
            <Button variant="ghost" size="sm" onClick={onDone}>
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            icon="mail"
            loading={create.isPending}
            disabled={!body.trim()}
            onClick={submit}
          >
            {parentId ? "Reply" : "Comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CommentItem({
  node,
  issueId,
  members,
  depth,
  readOnly = false,
}: {
  node: CommentNode;
  issueId: string;
  members: ProjectMember[] | undefined;
  depth: number;
  readOnly?: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const kind = deriveCommentKind(node.body);
  const meta = COMMENT_KIND_META[kind];
  const author = memberLabel(node.authorId, members);
  return (
    <div className={depth > 0 ? "border-l border-line-subtle pl-3 sm:pl-4" : ""}>
      <div className="flex items-start gap-2.5">
        <Avatar initials={initials(author)} size={26} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="fg-label text-fg">{author}</span>
            {kind !== "comment" && <Badge tone={meta.tone}>{meta.label}</Badge>}
            <span className="fg-caption">{formatRelativeTime(node.createdAt)}</span>
          </div>
          <div className="mt-1">
            <Markdown>{node.body}</Markdown>
          </div>
          {node.attachments.length > 0 && (
            <div className="mt-2">
              <AttachmentList rows={node.attachments} />
            </div>
          )}
          {!readOnly && (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setReplying((r) => !r)}
                className="fg-caption hover:text-fg"
              >
                {replying ? "Cancel" : "Reply"}
              </button>
            </div>
          )}
          {replying && (
            <div className="mt-2">
              <AddCommentBox
                issueId={issueId}
                parentId={node.id}
                placeholder="Write a reply…"
                onDone={() => setReplying(false)}
              />
            </div>
          )}
        </div>
      </div>
      {node.replies.length > 0 && (
        <div className="mt-3 space-y-3">
          {node.replies.map((child) => (
            <CommentItem
              key={child.id}
              node={child}
              issueId={issueId}
              members={members}
              depth={depth + 1}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function CommentThread({
  issueId,
  comments,
  members,
  readOnly = false,
}: {
  issueId: string;
  comments: CommentNode[];
  members: ProjectMember[] | undefined;
  /** Viewer role: render the thread without composer/reply affordances. */
  readOnly?: boolean;
}) {
  // Newest top-level comment first so the latest activity is reachable without
  // scrolling past a long history (ISS-347). Sort a COPY — nested `replies`
  // stay chronological since a thread reads top-down.
  const ordered = [...comments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return (
    <div className="space-y-5">
      {!readOnly && <AddCommentBox issueId={issueId} placeholder="Add a comment…" />}
      {ordered.length === 0 ? (
        <EmptyState title="No comments yet" message="Start the conversation." mascot={false} />
      ) : (
        <div className="space-y-5">
          {ordered.map((node) => (
            <CommentItem
              key={node.id}
              node={node}
              issueId={issueId}
              members={members}
              depth={0}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </div>
  );
}
