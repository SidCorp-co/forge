"use client";

// The comment thread of a requirement (or a workflow or feedback item): every comment newest first,
// a decision drawn apart from the talk with an accent bar and its badge, and one composer that
// says what the comment is — a question the agent working it owes a reply to, a note for the
// record, or a decision with its reason. Core refuses a wrong comment by name.

import { useState } from "react";
import { ActorChip, Badge, BodyView, Button, ErrorState, ProjectLoader, SegmentedControl, Textarea } from "@/design";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { WrittenMark } from "@/lib/i18n/written";
import { useEntityComments, usePostEntityComment } from "../hooks";
import type { EntityCommentScope, EntityCommentView } from "../types";
import { DecisionComposer, DecisionRow } from "./decisions-panel";

export type ComposerIntent = "question" | "note" | "decision";

/** The three things a comment can be, said once for every composer that asks. */
export function IntentPicker({ value, onChange }: { value: ComposerIntent; onChange: (v: ComposerIntent) => void }) {
  const t = useCopy();
  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      options={[
        { value: "question", label: t("common.intent.question"), title: t("common.intent.questionTitle") },
        { value: "note", label: t("common.intent.note"), title: t("common.intent.noteTitle") },
        { value: "decision", label: t("common.decisions.decision"), title: t("common.intent.decisionTitle") },
      ]}
    />
  );
}

/** A decision in a thread: the same row the decision logs draw, behind an accent bar so it reads apart. */
export function DecisionInThread({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-l-[3px] pl-3" style={{ borderColor: "var(--green-500)" }} data-testid="thread-decision">
      {children}
    </div>
  );
}

function CommentRow({ c }: { c: EntityCommentView }) {
  const t = useCopy();
  const time = useTimeFormat();
  if (c.intent === "decision") {
    return (
      <li className="border-t border-line-subtle py-3 first:border-t-0 first:pt-0">
        <DecisionInThread>
          <span className="mb-1 inline-flex">
            <Badge tone="green">{t("common.decisions.decision")}</Badge>
          </span>
          <ul className="grid">
            <DecisionRow c={c} />
          </ul>
        </DecisionInThread>
      </li>
    );
  }
  return (
    <li className="grid gap-1 border-t border-line-subtle py-3 first:border-t-0 first:pt-0" data-testid="entity-comment" lang={c.writtenLang ?? undefined}>
      <span className="inline-flex flex-wrap items-center gap-2 text-12 text-subtle">
        <ActorChip name={c.author.name ?? t("common.decisions.unknownAuthor")} kind={c.author.agency} size={16} />
        {c.intent === "question" ? <Badge tone="accent">{t("common.intent.question")}</Badge> : null}
        <span title={time.dateTime(c.createdAt)}>{time.relative(c.createdAt)}</span>
        <WrittenMark lang={c.writtenLang} />
      </span>
      {c.body ? (
        <BodyView body={c.body} format={c.format} className="text-14" />
      ) : (
        <p className="text-13 text-subtle">{t("common.decisions.withheld")}</p>
      )}
    </li>
  );
}

function TalkComposer({ projectId, scope, targetRef, intent }: { projectId: string; scope: EntityCommentScope; targetRef: string; intent: "question" | "note" }) {
  const t = useCopy();
  const post = usePostEntityComment(projectId, scope, targetRef);
  const [body, setBody] = useState("");
  return (
    <form
      className="grid gap-2"
      data-testid="entity-comment-composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (body.trim()) post.mutate({ intent, body: body.trim() }, { onSuccess: () => setBody("") });
      }}
    >
      <Textarea
        aria-label={t(intent === "question" ? "common.intent.question" : "common.intent.note")}
        placeholder={t(intent === "question" ? "common.intent.questionPlaceholder" : "common.intent.notePlaceholder")}
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <RefusalLine error={post.error} testid="entity-comment-refusal" />
      <span className="flex justify-end">
        <Button type="submit" size="sm" variant="primary" loading={post.isPending} disabled={!body.trim()}>
          {t(intent === "question" ? "common.intent.ask" : "common.intent.post")}
        </Button>
      </span>
    </form>
  );
}

export function EntityCommentThread({ projectId, scope, targetRef }: { projectId: string; scope: EntityCommentScope; targetRef: string }) {
  const t = useCopy();
  const q = useEntityComments(projectId, scope, targetRef);
  const [intent, setIntent] = useState<ComposerIntent>("note");
  const rows = [...(q.data?.comments ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="grid gap-5" data-testid="entity-comment-thread">
      <div className="grid gap-2">
        <IntentPicker value={intent} onChange={setIntent} />
        {intent === "decision" ? (
          <DecisionComposer projectId={projectId} scope={scope} targetRef={targetRef} />
        ) : (
          <TalkComposer projectId={projectId} scope={scope} targetRef={targetRef} intent={intent} />
        )}
      </div>
      {q.isLoading ? (
        <ProjectLoader label={t("common.intent.loading")} />
      ) : q.isError ? (
        <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />
      ) : rows.length === 0 ? (
        <p className="text-13 text-subtle">{t("common.intent.none")}</p>
      ) : (
        <ul className="grid">
          {rows.map((c) => (
            <CommentRow key={c.id} c={c} />
          ))}
        </ul>
      )}
    </div>
  );
}
