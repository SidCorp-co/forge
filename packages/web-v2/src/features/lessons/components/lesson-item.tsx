// One lesson on the Lessons page (REQ-50 BC-2, BC-7): its sentence, scope and provenance, its use
// (applied count, last applied, repeats, the check it became), and the acts its `can` grants: approve,
// edit or reject a proposal; edit, retire or keep one in use. A retire proposal is a line with its
// two answers; nothing is ever deleted.

import type { LessonView } from "@forge/contracts/lessons";
import { type ReactNode, useState } from "react";
import { Button, RowItem } from "@/design";
import { RejectStep } from "@/features/suggestions";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { formatRelativeTime } from "@/lib/utils/format";
import type { LessonAct } from "../api";
import { useLessonAct } from "../hooks";
import { personWords, scopeWords } from "../words";
import { LessonSources } from "./lesson-sources";
import { SentenceEditor } from "./sentence-editor";

type Open = "edit" | "reject" | "retire" | "sources" | null;

function useFacts(lesson: LessonView): ReactNode[] {
  const t = useCopy();
  const counted = (key: "lessons.from" | "lessons.appliedCount" | "lessons.repeats", count: number) =>
    count === 1 ? t(`${key}.one`) : t(key, { count });
  const facts: ReactNode[] = [scopeWords(t, lesson.scope), counted("lessons.from", lesson.corrections.length - lesson.repeats)];
  if (lesson.status === "proposed") {
    facts.push(t("lessons.proposedBy", { name: personWords(t, lesson.proposedBy, "agent") }));
  } else {
    facts.push(counted("lessons.appliedCount", lesson.appliedCount));
    facts.push(lesson.lastAppliedAt ? t("lessons.lastApplied", { when: formatRelativeTime(lesson.lastAppliedAt) }) : t("lessons.neverApplied"));
  }
  if (lesson.repeats > 0) facts.push(counted("lessons.repeats", lesson.repeats));
  if (lesson.supersedes) facts.push(t("lessons.supersedes", { key: lesson.supersedes }));
  if (lesson.checkIssueKey) facts.push(t("lessons.check", { key: lesson.checkIssueKey }));
  return facts;
}

function noteOf(t: ReturnType<typeof useCopy>, lesson: LessonView): ReactNode {
  if (lesson.status === "held") return <span className="text-warn-11">{t("lessons.held")}</span>;
  if (lesson.retire) {
    return (
      <span className="text-warn-11" data-testid="lesson-retire-proposal">
        {t(`lessons.retirePropose.${lesson.retire.reason}`)}
      </span>
    );
  }
  return lesson.reason ? t("lessons.why", { reason: lesson.reason }) : null;
}

function Acts({ lesson, open, setOpen, send, busy }: { lesson: LessonView; open: Open; setOpen: (o: Open) => void; send: (a: LessonAct) => void; busy: boolean }) {
  const t = useCopy();
  const toggle = (o: Open) => setOpen(open === o ? null : o);
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => toggle("sources")} aria-expanded={open === "sources"} data-testid="lesson-sources-toggle">
        {open === "sources" ? t("lessons.act.hideSources") : t("lessons.act.sources")}
      </Button>
      {lesson.can.edit ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => toggle("edit")} data-testid="lesson-edit">
          {t("lessons.act.edit")}
        </Button>
      ) : null}
      {lesson.can.reject ? (
        <Button type="button" size="sm" onClick={() => toggle("reject")} data-testid="lesson-reject">
          {t("lessons.act.reject")}
        </Button>
      ) : null}
      {lesson.can.keep ? (
        <Button type="button" size="sm" loading={busy} onClick={() => send({ kind: "keep", key: lesson.key })} data-testid="lesson-keep">
          {t("lessons.act.keep")}
        </Button>
      ) : null}
      {lesson.can.retire ? (
        <Button type="button" size="sm" onClick={() => toggle("retire")} data-testid="lesson-retire">
          {t("lessons.act.retire")}
        </Button>
      ) : null}
      {lesson.can.approve ? (
        <Button type="button" size="sm" variant="primary" loading={busy} onClick={() => send({ kind: "approve", key: lesson.key })} data-testid="lesson-approve">
          {t("lessons.act.approve")}
        </Button>
      ) : null}
    </>
  );
}

export function LessonItem({ projectId, lesson }: { projectId: string; lesson: LessonView }) {
  const t = useCopy();
  const [open, setOpen] = useState<Open>(null);
  const write = useLessonAct(projectId);
  const send = (a: LessonAct) => write.mutate(a, { onSuccess: () => setOpen(null) });
  const closed = lesson.status === "rejected" || lesson.status === "retired";
  return (
    <RowItem
      testId="lesson"
      rowKey={lesson.key}
      lead={lesson.key}
      title={lesson.sentence}
      wrap
      dim={closed}
      facts={useFacts(lesson)}
      note={noteOf(t, lesson)}
      trailing={<Acts lesson={lesson} open={open} setOpen={setOpen} send={send} busy={write.isPending} />}
    >
      {open === "sources" ? <LessonSources projectId={projectId} lesson={lesson} /> : null}
      {open === "edit" ? (
        <SentenceEditor
          initial={lesson.sentence}
          label={lesson.status === "proposed" ? t("lessons.act.saveApprove") : t("lessons.act.save")}
          loading={write.isPending}
          onCancel={() => setOpen(null)}
          onSave={(sentence) => send(lesson.status === "proposed" ? { kind: "approve", key: lesson.key, sentence } : { kind: "edit", key: lesson.key, sentence })}
        />
      ) : null}
      {open === "reject" || open === "retire" ? (
        <RejectStep
          label={t(open === "reject" ? "lessons.act.reject" : "lessons.act.retire")}
          reasonLabel={t(open === "reject" ? "lessons.rejectWhy" : "lessons.retireWhy")}
          loading={write.isPending}
          onCancel={() => setOpen(null)}
          onConfirm={(reason) => send({ kind: open, key: lesson.key, reason })}
        />
      ) : null}
      {write.isError ? (
        <p className="mt-2 text-12 text-danger" role="alert">
          {formatApiError(write.error)}
        </p>
      ) : null}
    </RowItem>
  );
}
