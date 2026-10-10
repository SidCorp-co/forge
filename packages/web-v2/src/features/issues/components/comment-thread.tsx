"use client";

// Comment thread for the issue detail. Renders the nested comment tree with a
// derived lifecycle-kind badge (`deriveCommentKind`), the body through
// `<BodyView>` (markdown or a `forge-*` component tree), author initials
// resolved against the project members, and reply/add boxes.

import { WrittenMark } from "@/lib/i18n/written";
import { Avatar, Badge, BodyView, Button, EmptyState, Field, Icon, Textarea } from "@/design";
import { type ComposerIntent, DecisionInThread, IntentPicker } from "@/features/comments/components/entity-comment-thread";
import { formatApiError } from "@/lib/api/error";
import { refusalsOf } from "@/lib/api/refusals";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useEffect, useState } from "react";
import {
  COMMENT_KIND_TONE,
  deriveCommentKind,
  initials,
  memberLabel,
} from "../derive";
import { useIssueQuestions } from "@/features/questions/hooks";
import { useCreateComment, useRecordDecision } from "../detail-hooks";
import type { CommentNode, ProjectMember } from "../types";
import { AttachmentList } from "@/features/attachments/components/attachment-list";
import { BodyEditor } from "./body-editor";
import { StagedFileList, useStagedFiles } from "@/features/attachments/components/staged-files";

function AddCommentBox({
  issueId,
  parentId,
  intent = "question",
  placeholder,
  onDone,
}: {
  issueId: string;
  parentId?: string;
  /** What the comment is: a question owed a reply (a reply's default, as it always was), or a note. */
  intent?: "question" | "note";
  placeholder: string;
  onDone?: () => void;
}) {
  const [body, setBody] = useState("");
  const staged = useStagedFiles({ unit: "comment", video: false, uniqueNames: false });
  const create = useCreateComment(issueId);
  const t = useCopy();

  const submit = () => {
    const text = body.trim();
    if (!text) return;
    create.mutate(
      { body: text, intent, parentId, files: staged.files },
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
          label={parentId ? t("issues.thread.reply") : t("issues.thread.comment")}
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
          {t("issues.thread.attach")}
        </Button>
        {staged.input}
        <div className="flex gap-2">
          {onDone && (
            <Button variant="ghost" size="sm" onClick={onDone}>
              {t("common.cancel")}
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
            {parentId ? t("issues.thread.reply") : t(intent === "note" ? "common.intent.post" : "common.intent.ask")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** While `pending`, leaving the page asks first: the browser's own prompt, so the write is not abandoned unread. */
function useHoldPageWhile(pending: boolean) {
  useEffect(() => {
    if (!pending) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [pending]);
}

/**
 * A ruling the owner records on the issue unprompted: what was decided and why, kept as a decision
 * (comment intent decision) so it reads apart from the thread's chatter and every agent reads it.
 */
function RecordDecisionBox({ issueId, onDone }: { issueId: string; onDone: () => void }) {
  const [decision, setDecision] = useState("");
  const [reason, setReason] = useState("");
  const record = useRecordDecision(issueId);
  const t = useCopy();
  // the issue read carries every round as `steps` and the open one's number as `round`, never
  // `currentStep` (the project page's shape): reading that hid this choice on live dev.227 (FB-80)
  const open = (useIssueQuestions(issueId).data?.questions ?? []).filter(
    (q) => q.status === "open" && q.answerShape === "free_text" && q.round > 0,
  );
  // one open question is settled unless the person unticks it; with several, nothing is chosen
  // until the person names the one the decision answers, or none (FB-80)
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const several = open.length > 1;
  const settles = picked === undefined ? (several ? undefined : open[0]) : open.find((q) => q.id === picked);
  useHoldPageWhile(record.isPending);
  const ready = decision.trim().length > 0 && reason.trim().length > 0 && !(several && picked === undefined);
  const refused = record.error ? (refusalsOf(record.error)[0]?.detail ?? formatApiError(record.error)) : null;
  const submit = () => {
    if (!ready) return;
    record.mutate(
      {
        decision: decision.trim(),
        reason: reason.trim(),
        ...(settles ? { settles: { questionId: settles.id, round: settles.round } } : {}),
      },
      {
        onSuccess: () => {
          setDecision("");
          setReason("");
          onDone();
        },
      },
    );
  };
  return (
    <div className="grid gap-3" data-testid="record-decision">
      <Field label={t("common.decisions.decision")}>
        <Textarea rows={2} value={decision} onChange={(e) => setDecision(e.target.value)} maxLength={4000} disabled={record.isPending} />
      </Field>
      <Field label={t("common.decisions.reason")}>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={4000} disabled={record.isPending} />
      </Field>
      {open.length === 1 && open[0] ? (
        <label className="flex items-start gap-2 text-13">
          <input type="checkbox" className="mt-0.5" checked={Boolean(settles)} onChange={(e) => setPicked(e.target.checked ? (open[0]?.id ?? null) : null)} disabled={record.isPending} />
          <span className="grid gap-0.5">
            {t("issues.thread.settlesQuestion")}
            <span className="text-muted">{open[0].prompt}</span>
          </span>
        </label>
      ) : several ? (
        // several open: the person names which one the decision answers, so none is settled by guess
        <fieldset className="grid gap-1.5 text-13" data-testid="settles-which">
          <legend className="mb-1 font-medium">{t("issues.thread.settlesWhich")}</legend>
          {open.map((q) => (
            <label key={q.id} className="flex items-start gap-2">
              <input type="radio" name="settles" className="mt-0.5" checked={settles?.id === q.id} onChange={() => setPicked(q.id)} disabled={record.isPending} />
              {q.prompt}
            </label>
          ))}
          <label className="flex items-start gap-2 text-muted">
            <input type="radio" name="settles" className="mt-0.5" checked={picked === null} onChange={() => setPicked(null)} disabled={record.isPending} />
            {t("issues.thread.settlesNone")}
          </label>
        </fieldset>
      ) : null}
      {refused ? (
        <p role="alert" className="fg-caption text-red">
          {refused}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button variant="primary" size="sm" loading={record.isPending} disabled={!ready} onClick={submit}>
          {t("common.decisions.submit")}
        </Button>
      </div>
    </div>
  );
}

function Composer({ issueId }: { issueId: string }) {
  const [mode, setMode] = useState<ComposerIntent>("question");
  const t = useCopy();
  return (
    <div className="space-y-2">
      <IntentPicker value={mode} onChange={setMode} />
      {mode === "decision" ? (
        <RecordDecisionBox issueId={issueId} onDone={() => setMode("question")} />
      ) : (
        <AddCommentBox
          key={mode}
          issueId={issueId}
          intent={mode}
          placeholder={t(mode === "note" ? "common.intent.notePlaceholder" : "common.intent.questionPlaceholder")}
        />
      )}
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
  const t = useCopy();
  const time = useTimeFormat();
  const { kind } = deriveCommentKind(node);
  const isAgent = node.author?.isAgent ?? false;
  const author = node.author?.displayName ?? memberLabel(node.authorId, members);
  const ownerEmail = node.author?.ownerEmail;
  const head = (
      <div className="flex items-start gap-2.5">
        <Avatar initials={initials(author)} size={26} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="fg-label text-fg"
              title={isAgent && ownerEmail ? t("issues.thread.agentOn", { author, owner: ownerEmail }) : undefined}
            >
              {author}
            </span>
            {isAgent && (
              <Badge tone="accent">
                <span className="inline-flex items-center gap-1">
                  <Icon name="agent" size={11} />
                  {t("issues.assignee.agent")}
                </span>
              </Badge>
            )}
            {node.intent === "decision" ? (
              <Badge tone="green">{t("common.decisions.decision")}</Badge>
            ) : (
              kind !== "comment" && <Badge tone={COMMENT_KIND_TONE[kind]}>{t(`issues.commentKind.${kind}`)}</Badge>
            )}
            <span className="fg-caption" title={time.dateTime(node.createdAt)}>
              {time.relative(node.createdAt)}
            </span>
            <WrittenMark lang={node.writtenLang} />
          </div>
          <div className="mt-1" lang={node.writtenLang ?? undefined}>
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
                {replying ? t("common.cancel") : t("issues.thread.reply")}
              </button>
            </div>
          )}
          {replying && (
            <div className="mt-2">
              <AddCommentBox
                issueId={issueId}
                parentId={node.id}
                placeholder={t("issues.thread.replyPlaceholder")}
                onDone={() => setReplying(false)}
              />
            </div>
          )}
        </div>
      </div>
  );
  return (
    <div className={depth > 0 ? "border-l border-line-subtle pl-3 sm:pl-4" : ""}>
      {node.intent === "decision" ? <DecisionInThread>{head}</DecisionInThread> : head}
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
  const t = useCopy();
  // Newest top-level comment first so the latest activity is reachable without
  // scrolling past a long history (ISS-347). Sort a COPY — nested `replies`
  // stay chronological since a thread reads top-down.
  const ordered = [...comments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return (
    <div className="space-y-5">
      {!readOnly && <Composer issueId={issueId} />}
      {ordered.length === 0 ? (
        <EmptyState
          message={t("issues.thread.empty")}
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
