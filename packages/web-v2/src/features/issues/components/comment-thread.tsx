"use client";

// Comment thread for the issue detail. Renders the nested comment tree with a
// derived lifecycle-kind badge (`deriveCommentKind`), the body through
// `<BodyView>` (markdown or a `forge-*` component tree), author initials
// resolved against the project members, and reply/add boxes.

import { Avatar, Badge, BodyView, Button, EmptyState, Icon } from "@/design";
import { formatRelativeTime } from "@/lib/utils/format";
import { useState } from "react";
import {
  COMMENT_KIND_META,
  deriveCommentKind,
  initials,
  memberLabel,
} from "../derive";
import { useCreateComment } from "../detail-hooks";
import type { CommentNode, ProjectMember } from "../types";
import { AttachmentList } from "./attachment-list";
import { BodyEditor } from "./body-editor";
import { StagedFileList, useStagedFiles } from "./staged-files";

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
  const staged = useStagedFiles({ unit: "comment", video: false, uniqueNames: false });
  const create = useCreateComment(issueId);

  const submit = () => {
    const text = body.trim();
    if (!text) return;
    create.mutate(
      { body: text, parentId, files: staged.files },
      {
        onSuccess: () => {
          setBody("");
          staged.reset();
          onDone?.();
        },
      },
    );
  };
  return (
    <div className="space-y-2" onPaste={staged.onPaste}>
      <div
        {...staged.dropZone}
        className={`rounded-lg transition-colors ${
          staged.dragOver ? "ring-2 ring-cobalt-400 ring-offset-1" : ""
        }`}
      >
        <BodyEditor
          label={parentId ? "Reply" : "Comment"}
          rows={parentId ? 2 : 3}
          placeholder={placeholder}
          value={body}
          onChange={setBody}
          disabled={create.isPending}
        />
      </div>

      <StagedFileList files={staged.files} warnings={staged.warnings} remove={staged.remove} />

      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" icon="plus" onClick={staged.choose}>
          Attach
        </Button>
        {staged.input}
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
  const { kind } = deriveCommentKind(node);
  const meta = COMMENT_KIND_META[kind];
  const isAgent = node.author?.isAgent ?? false;
  const author = node.author?.displayName ?? memberLabel(node.authorId, members);
  const ownerEmail = node.author?.ownerEmail;
  return (
    <div
      className={depth > 0 ? "border-l border-line-subtle pl-3 sm:pl-4" : ""}
    >
      <div className="flex items-start gap-2.5">
        <Avatar initials={initials(author)} size={26} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="fg-label text-fg">{author}</span>
            {isAgent && (
              <Badge tone="accent">
                <span className="inline-flex items-center gap-1">
                  <Icon name="agent" size={11} />
                  Agent
                </span>
              </Badge>
            )}
            {kind !== "comment" && <Badge tone={meta.tone}>{meta.label}</Badge>}
            <span className="fg-caption">
              {formatRelativeTime(node.createdAt)}
            </span>
          </div>
          {isAgent && ownerEmail && (
            <div className="fg-caption">via {ownerEmail}</div>
          )}
          <div className="mt-1">
            <BodyView
              body={node.body}
              format={node.format}
              nodes={node.nodes}
              record={node.record}
              recordLens={node.record?.lens ?? "product"}
              renderArtifact={(id) => {
                const row = node.attachments.find((a) => a.id === id);
                return row ? <AttachmentList rows={[row]} /> : null;
              }}
            />
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
      {!readOnly && (
        <AddCommentBox issueId={issueId} placeholder="Add a comment…" />
      )}
      {ordered.length === 0 ? (
        <EmptyState
          title="No comments yet"
          message="Start the conversation."
          mascot={false}
        />
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
