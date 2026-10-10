"use client";

// One checklist as an item's page reads it (REQ-34 r2 BC-5, BC-9, BC-26), drawn from core's read and
// never restating a question: each answer is a property under its question, with where it came from;
// each gap is the question still to answer, in core's words, beside where it is answered. Once a move
// passed, the page shows the answers that move was judged by, so an assumed one stays visible as an
// assumption; a later revision that answers it reads as the correction, never an edit in place.

import type { ChecklistMove, ChecklistRead } from "@forge/contracts/checklist-read";
import type { ChecklistAnswer, ChecklistFormField, ChecklistGap } from "@forge/contracts/checklists";
import type { ReactNode } from "react";
import { ToneBadge, ViewHeading } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";

type Row =
  | { kind: "answer"; field: ChecklistFormField; answer: ChecklistAnswer; now: ChecklistAnswer | null }
  | { kind: "gap"; field: ChecklistFormField; gap: ChecklistGap };

/** The move whose answers stand: the newest that passed with its answers kept. */
const standingMove = (read: ChecklistRead): ChecklistMove | null =>
  read.moves.find((m) => m.countsAsPassed && m.answers !== null) ?? null;

/** Each question in the form's order: its answer, or its gap; one not asked is left out. */
function rowsOf(read: ChecklistRead, move: ChecklistMove | null): Row[] {
  const answers = move?.answers ?? read.now?.answers ?? [];
  const gaps = move ? [] : (read.now?.gaps ?? []);
  return read.form.fields.flatMap((field): Row[] => {
    const answer = answers.find((a) => a.question === field.name);
    if (answer) {
      const now = move ? (read.now?.answers.find((a) => a.question === field.name) ?? null) : null;
      return [{ kind: "answer", field, answer, now }];
    }
    const gap = gaps.find((g) => g.question === field.name);
    return gap ? [{ kind: "gap", field, gap }] : [];
  });
}

/** A choice answer reads by its option's label, core's own words for it; text reads as written. */
const shownValue = (field: ChecklistFormField, value: string) => field.options.find((o) => o.value === value)?.label ?? value;

/** What a gap still lacks, without the question it repeats. */
const gapWords = (field: ChecklistFormField, gap: ChecklistGap) =>
  gap.detail.startsWith(field.label) ? gap.detail.slice(field.label.length).trim() : gap.detail;

/** An assumed answer a later record answers otherwise: the item was corrected since the move. */
const correctedBy = (answer: ChecklistAnswer, now: ChecklistAnswer | null) =>
  answer.provenance === "assumed" && now !== null && now.provenance === "given" && now.value !== answer.value ? now : null;

function Source({ answer, field }: { answer: ChecklistAnswer; field: ChecklistFormField }) {
  const t = useCopy();
  const said =
    answer.source === "recommended"
      ? t("checklist.source.recommended")
      : answer.source === "mover"
        ? t("checklist.source.mover")
        : answer.source.startsWith("derived:")
          ? t("checklist.source.derived", { rule: answer.source.slice("derived:".length) })
          : t("checklist.source.record", { field: field.recordLabel ?? answer.source.replace(/^record:/, "") });
  return (
    <span className="text-12 text-subtle" data-testid="checklist-source">
      {said}
      {answer.open ? ` · ${t("checklist.source.open")}` : ""}
    </span>
  );
}

function AnswerRow({ row, revision }: { row: Extract<Row, { kind: "answer" }>; revision: number | null }) {
  const t = useCopy();
  const { field, answer } = row;
  const corrected = correctedBy(answer, row.now);
  const state = corrected ? "corrected" : answer.provenance;
  return (
    <div className="grid gap-x-6 gap-y-1 border-t border-line-subtle py-2.5 first:border-t-0 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" data-testid="checklist-row" data-question={field.name} data-state={state}>
      <dt className="text-13 text-muted">{field.label}</dt>
      <dd className="grid min-w-0 gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className={`whitespace-pre-wrap break-words text-14 ${corrected ? "text-muted line-through" : "text-fg"}`}>{shownValue(field, answer.value)}</span>
          {answer.provenance === "assumed" ? <ToneBadge tone={corrected ? "done" : "neutral"} label={t("checklist.assumed")} title={t("checklist.assumed")} /> : null}
        </span>
        <Source answer={answer} field={field} />
        {corrected ? (
          <span className="flex flex-wrap items-center gap-2" data-testid="checklist-correction">
            <ToneBadge tone="ready" label={t("checklist.corrected")} title={t("checklist.corrected")} />
            <span className="text-12 text-subtle">{revision !== null ? t("checklist.nowIn", { r: revision }) : null}</span>
            <span className="whitespace-pre-wrap break-words text-14 text-fg">{shownValue(field, corrected.value)}</span>
          </span>
        ) : null}
      </dd>
    </div>
  );
}

function GapRow({ row, answerAt }: { row: Extract<Row, { kind: "gap" }>; answerAt?: ((field: ChecklistFormField) => ReactNode) | undefined }) {
  const { field, gap } = row;
  return (
    <div className="grid gap-x-6 gap-y-1 border-t border-line-subtle py-2.5 first:border-t-0 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" data-testid="checklist-row" data-question={field.name} data-state="gap">
      <dt className="text-14 font-medium text-fg">{field.label}</dt>
      <dd className="grid min-w-0 gap-1.5">
        <span className="text-13 leading-relaxed text-muted" data-testid="checklist-gap">
          {gapWords(field, gap)}
        </span>
        {answerAt ? <span>{answerAt(field)}</span> : null}
      </dd>
    </div>
  );
}

/**
 * One checklist's answers and gaps. Nothing is drawn for a checklist the item has not reached (no
 * reading now, no move); a move recorded before the checklist reads "No checklist" (BC-9).
 */
export function ChecklistAnswers({
  read,
  revision = null,
  answerAt,
}: {
  read: ChecklistRead;
  /** The revision core read `now` at, named on a correction. */
  revision?: number | null;
  /** Where a gap is answered: an act or a link beside it. */
  answerAt?: ((field: ChecklistFormField) => ReactNode) | undefined;
}) {
  const t = useCopy();
  const time = useTimeFormat();
  const move = standingMove(read);
  const unrecorded = !move && read.moves.some((m) => m.standing === "no_checklist");
  if (!move && !read.now && !unrecorded) return null;
  const rows = rowsOf(read, move);
  const open = rows.filter((r) => r.kind === "gap").length;
  const state = move
    ? <span title={time.dateTime(move.at)}>{t("checklist.passed", { at: time.relative(move.at) })}</span>
    : unrecorded
      ? t("checklist.noChecklist")
      : open === 0
        ? t("checklist.complete")
        : t("checklist.open", { n: open });
  return (
    <section data-testid="checklist" data-checklist={read.id} data-standing={move ? "passed" : unrecorded ? "no_checklist" : read.now?.complete ? "complete" : "open"}>
      <ViewHeading right={<span className="text-12-5 text-muted">{state}</span>}>{read.form.title}</ViewHeading>
      {rows.length > 0 ? <dl className="grid">{rows.map((r) => (r.kind === "answer" ? <AnswerRow key={r.field.name} row={r} revision={revision} /> : <GapRow key={r.field.name} row={r} answerAt={answerAt} />))}</dl> : null}
    </section>
  );
}
