// Raise a question: what it is about, then the question. On a requirement, a feedback item or a
// workflow it is a `question` comment in that record's thread, which a project member answers; on an
// issue it is a question in the issue's thread, which the project's agent is owed and takes on its
// next pass (`core devices/comment-inbox.ts:readOwedComments`). The form says which before it is sent.

import { useState } from "react";
import { Button, Field, NativeSelect, SegmentedControl, Textarea } from "@/design";
import { type IssuePick, IssuePicker } from "@/features/issue-picker";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import type { AskScope } from "../api";
import { useAsk, useAskTargets } from "../hooks";

const SCOPES = ["requirement", "feedback", "workflow", "issue"] as const satisfies readonly AskScope[];

export function AskForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const t = useCopy();
  const ask = useAsk(projectId);
  const [scope, setScope] = useState<AskScope>("requirement");
  const [ref, setRef] = useState("");
  const [issue, setIssue] = useState<IssuePick[]>([]);
  const [body, setBody] = useState("");
  const targets = useAskTargets(projectId, scope);
  const chosen = scope === "issue" ? (issue[0]?.key ?? "") : ref;
  return (
    <form
      className="grid max-w-2xl gap-3"
      data-testid="question-ask"
      onSubmit={(e) => {
        e.preventDefault();
        if (!chosen || !body.trim()) return;
        ask.mutate({ scope, ref: chosen, body: body.trim() }, { onSuccess: onDone });
      }}
    >
      <Field label={t("questionDesk.about")}>
        <SegmentedControl
          value={scope}
          onChange={(v) => {
            setScope(v);
            setRef("");
            setIssue([]);
          }}
          options={SCOPES.map((s) => ({ value: s, label: t(`questionDesk.scope.${s}`) }))}
        />
      </Field>
      {scope === "issue" ? (
        <IssuePicker projectId={projectId} value={issue} onChange={setIssue} ariaLabel={t("questionDesk.scope.issue")} single />
      ) : (
        <NativeSelect
          aria-label={t(`questionDesk.scope.${scope}`)}
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          options={[{ value: "", label: targets.isPending ? t("questionDesk.loading") : t("questionDesk.pick") }, ...(targets.data ?? []).map((x) => ({ value: x.ref, label: x.label }))]}
          data-testid="question-ask-target"
        />
      )}
      <p className="text-13 text-muted" data-testid="question-ask-who">
        {t(scope === "issue" ? "questionDesk.whoAnswers.agent" : "questionDesk.whoAnswers.members")}
      </p>
      <Field label={t("questionDesk.question")} required>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} data-testid="question-ask-body" />
      </Field>
      <RefusalLine error={ask.error ?? targets.error} testid="question-ask-refusal" />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm" loading={ask.isPending} disabled={!chosen || !body.trim()}>
          {t("questionDesk.send")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={ask.isPending}>
          {t("questionDesk.cancel")}
        </Button>
      </div>
    </form>
  );
}
