
// The decisions only the viewer can make (REQ-41 BC-1, BC-2), as core's needs-me read answers them:
// each with its question, what it changes and its impact (REQ-68 BC-1), the recommended answer and
// why, and the buttons that answer it. A button
// posts its own body to the route the record's page calls, as the person who presses it (BC-9);
// nothing is decided here. Flat rows under hairlines, one heading per group; the project home and
// the chat draw the same list.

import {
  capDecisions,
  type DecisionAnswer,
  NEEDS_YOU_DECISION_GROUP_LABELS,
  NEEDS_YOU_DECISION_GROUPS,
  type NeedsYouDecision,
  type NeedsYouDecisions,
} from "@forge/contracts/needs-you-decisions";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/navigation/router";
import { useState } from "react";
import { Button, Icon, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { needsYouApi, prefillOf, pressBody, wordsAsItStands } from "../api";
import { NEEDS_YOU_ROOT } from "../hooks";
import { decisionHref } from "../routes";

/** What a press came to, for a surface that answers it: the chat posts the item read back (REQ-41 BC-24). */
export interface DecisionSettled {
  decision: NeedsYouDecision;
  ok: boolean;
}

function OwedDecision({
  d,
  slug,
  onSettled,
}: {
  d: NeedsYouDecision;
  slug: string | undefined;
  onSettled: ((s: DecisionSettled) => void) | undefined;
}) {
  const t = useCopy();
  const qc = useQueryClient();
  const [typing, setTyping] = useState<DecisionAnswer | null>(null);
  const [typed, setTyped] = useState("");
  const press = useMutation({
    mutationFn: ({ answer, text }: { answer: DecisionAnswer; text: string | null }) =>
      needsYouApi.press(answer.path, pressBody(answer, text)),
    onSuccess: () => {
      setTyping(null);
      void qc.invalidateQueries({ queryKey: NEEDS_YOU_ROOT });
      onSettled?.({ decision: d, ok: true });
    },
    onError: () => onSettled?.({ decision: d, ok: false }),
  });
  const href = slug ? decisionHref(slug, d.opens) : null;
  const recommended = d.recommended ? d.answers.find((a) => a.id === d.recommended?.answerId) : undefined;
  const sent = press.isSuccess ? press.variables?.answer : undefined;
  return (
    <li className="flex flex-col gap-1.5 py-3" data-testid="needs-you-decision" data-group={d.group} data-key={d.key}>
      <p className="fg-caption text-muted">
        {href ? (
          <Link href={href} className="font-mono text-fg underline-offset-2 hover:underline">
            {d.opens?.key ?? d.key}
          </Link>
        ) : (
          <span className="font-mono text-fg">{d.opens?.key ?? d.key}</span>
        )}
        {d.title && <span> · {d.title}</span>}
      </p>
      <p className="fg-body-sm whitespace-pre-wrap text-fg" data-testid="needs-you-decision-question">
        {d.question}
      </p>
      <dl className="fg-caption flex flex-col gap-0.5 text-muted" data-testid="needs-you-decision-stakes">
        <div className="flex gap-2">
          <dt className="flex-none">{t("needsYou.decisions.changes")}</dt>
          <dd className="min-w-0 text-fg">{d.changes}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="flex-none">{t("needsYou.decisions.impact")}</dt>
          <dd className="min-w-0 text-fg">{d.impact}</dd>
        </div>
      </dl>
      {d.recommended && recommended ? (
        <p className="fg-caption text-muted" data-testid="needs-you-decision-recommended">
          {d.recommended.by === "assistant" ? (
            <>
              <span className="font-semibold text-fg">{t("needsYou.decisions.suggested")}:</span> {d.recommended.why}
            </>
          ) : (
            <>
              <span className="font-semibold text-fg">{t("needsYou.decisions.recommended")}:</span> {recommended.label}. {d.recommended.why}
            </>
          )}
        </p>
      ) : (
        <p className="fg-caption text-subtle" data-testid="needs-you-decision-no-recommendation">
          {t("needsYou.decisions.noRecommendation")}: {d.noRecommendation}
        </p>
      )}
      {sent ? (
        <p className="fg-caption flex items-center gap-1 text-fg" role="status">
          <Icon name="check" size={12} />
          {t("needsYou.decisions.sent", { label: sent.label })}
        </p>
      ) : typing ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) press.mutate({ answer: typing, text: typed.trim() });
          }}
        >
          <label className="fg-caption text-muted" htmlFor={`decision-${d.key}-${typing.id}`}>
            {t(typing.act === "question.answer" ? "needsYou.decisions.answerLabel" : "needsYou.decisions.reasonLabel")}
          </label>
          <Textarea
            id={`decision-${d.key}-${typing.id}`}
            rows={2}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            data-testid="needs-you-decision-typed"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" type="submit" loading={press.isPending} disabled={!typed.trim()}>
              {t("needsYou.decisions.send")}
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setTyping(null)}>
              {t("needsYou.decisions.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {d.answers.map((a) => (
            <Button
              key={a.id}
              size="sm"
              variant={a.recommended ? "primary" : "secondary"}
              title={a.effect ?? undefined}
              loading={press.isPending && press.variables?.answer.id === a.id}
              data-testid="needs-you-decision-answer"
              data-answer={a.id}
              onClick={() => {
                const asItStands = wordsAsItStands(a);
                if (!a.needsReason) press.mutate({ answer: a, text: null });
                else if (asItStands !== null) press.mutate({ answer: a, text: asItStands });
                else {
                  setTyped(prefillOf(a));
                  setTyping(a);
                }
              }}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
      {!sent && !typing && d.answers.some((a) => a.effect) && (
        <ul className="fg-caption flex flex-col gap-0.5 text-muted" data-testid="needs-you-decision-effects">
          {d.answers.flatMap((a) =>
            a.effect ? [
              <li key={a.id}>
                <span className="font-semibold text-fg">{a.label}:</span> {a.effect}
              </li>,
            ] : [],
          )}
        </ul>
      )}
      {press.isError && (
        <p className="fg-caption text-danger" role="alert">
          {formatApiError(press.error)}
        </p>
      )}
    </li>
  );
}

/**
 * The decisions, one heading per group in the contract's order, and one line naming what was left out.
 * `cap` shows the first decisions in core's order (a stuck item's first, then the soonest due) and counts
 * the rest as "+n more", linked to `moreHref`, never dropping one (REQ-48 BC-11).
 */
export function DecisionList({
  read,
  slug,
  cap,
  moreHref,
  onSettled,
}: {
  read: Pick<NeedsYouDecisions, "decisions" | "total" | "notDecisions">;
  slug?: string | undefined;
  cap?: number;
  moreHref?: string;
  /** Told when a press settles, either way. */
  onSettled?: ((s: DecisionSettled) => void) | undefined;
}) {
  const t = useCopy();
  // the rest are counted from the read's total, which holds every decision however many it carries
  const shown = cap === undefined ? read.decisions : capDecisions(read.decisions, cap).shown;
  const more = cap === undefined ? 0 : Math.max(0, read.total - shown.length);
  const groups = NEEDS_YOU_DECISION_GROUPS.map((g) => ({ g, rows: shown.filter((d) => d.group === g) }))
    .filter((x) => x.rows.length > 0);
  const leftOut = read.notDecisions.map((n) => t(`needsYou.decisions.reason.${n.reason}`, { n: n.count }));
  return (
    <section aria-label={t("needsYou.decisions.aria")} className="flex flex-col gap-3" data-testid="needs-you-decisions">
      {groups.length === 0 && <p className="fg-body-sm text-muted">{t("needsYou.decisions.none")}</p>}
      {groups.map(({ g, rows }) => (
        <div key={g}>
          <h3 className="fg-caption border-b border-line pb-1 font-semibold text-fg">
            {NEEDS_YOU_DECISION_GROUP_LABELS[g]} <span className="font-normal text-muted">· {rows.length}</span>
          </h3>
          <ul className="flex flex-col divide-y divide-line-subtle">
            {rows.map((d) => (
              <OwedDecision key={d.id} d={d} slug={slug} onSettled={onSettled} />
            ))}
          </ul>
        </div>
      ))}
      {more > 0 &&
        (moreHref ? (
          <Link href={moreHref} className="fg-caption text-fg underline-offset-2 hover:underline" data-testid="needs-you-more">
            {t("needsYou.decisions.capMore", { n: more })}
          </Link>
        ) : (
          <p className="fg-caption text-subtle" data-testid="needs-you-more">
            {t("needsYou.decisions.capMore", { n: more })}
          </p>
        ))}
      {cap === undefined && read.total > read.decisions.length && (
        <p className="fg-caption text-subtle">{t("needsYou.decisions.more", { shown: read.decisions.length, total: read.total })}</p>
      )}
      {leftOut.length > 0 && (
        <p className="fg-caption text-subtle" data-testid="needs-you-left-out">
          {t("needsYou.decisions.leftOut", { list: leftOut.join(", ") })}
        </p>
      )}
    </section>
  );
}
