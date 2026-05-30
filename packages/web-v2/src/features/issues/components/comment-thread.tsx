"use client";

// Comment thread for the issue detail. Renders the nested comment tree with a
// derived lifecycle-kind badge (`deriveCommentKind`), markdown body (inline
// images resolve via the design Markdown's `coreFileUrl` mapping), author
// initials resolved against the project members, and reply/add boxes.

import { useState } from "react";
import { Avatar, Badge, Button, EmptyState, Markdown, Textarea } from "@/design";
import { COMMENT_KIND_META, deriveCommentKind, initials, memberLabel } from "../derive";
import { useCreateComment } from "../detail-hooks";
import type { CommentNode, ProjectMember } from "../types";

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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
  const create = useCreateComment(issueId);
  const submit = () => {
    const text = body.trim();
    if (!text) return;
    create.mutate(
      { body: text, parentId },
      {
        onSuccess: () => {
          setBody("");
          onDone?.();
        },
      },
    );
  };
  return (
    <div className="space-y-2">
      <Textarea
        rows={parentId ? 2 : 3}
        placeholder={placeholder}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex justify-end gap-2">
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
  );
}

function CommentItem({
  node,
  issueId,
  members,
  depth,
}: {
  node: CommentNode;
  issueId: string;
  members: ProjectMember[] | undefined;
  depth: number;
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
            <span className="fg-caption">{relativeTime(node.createdAt)}</span>
          </div>
          <div className="mt-1">
            <Markdown>{node.body}</Markdown>
          </div>
          <div className="mt-1">
            <button
              type="button"
              onClick={() => setReplying((r) => !r)}
              className="fg-caption hover:text-fg"
            >
              {replying ? "Cancel" : "Reply"}
            </button>
          </div>
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
}: {
  issueId: string;
  comments: CommentNode[];
  members: ProjectMember[] | undefined;
}) {
  return (
    <div className="space-y-5">
      <AddCommentBox issueId={issueId} placeholder="Add a comment…" />
      {comments.length === 0 ? (
        <EmptyState title="No comments yet" message="Start the conversation." mascot={false} />
      ) : (
        <div className="space-y-5">
          {comments.map((node) => (
            <CommentItem key={node.id} node={node} issueId={issueId} members={members} depth={0} />
          ))}
        </div>
      )}
    </div>
  );
}
