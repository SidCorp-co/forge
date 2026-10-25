// The one value check of a request (REQ-65 BC-1..BC-6, REQ-66 BC-2), on its page for everyone who
// reads it: who it is for, what improves, how that is measured and whether it already exists. Each
// is a row naming where it came from. Then how the check ended (accept, merge, a better alternative
// or refuse, with its one line), the questions holding it, and a refused requirement's keep.
// Properties and short rows, flush under hairlines.

import { useState } from "react";
import { Button, Input, ToneBadge, ViewHeading } from "@/design";
import type { LegendTone } from "@/design/vocabulary";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { isRedrafting, useIntakeDraft, useKeepRefusedRequest } from "../hooks";
import type { IntakeDraftView, ValueCheckView, ValueFactView } from "../types";
import { IntakeRefLink } from "./intake-ref-link";
import { ValueQuestions } from "./value-questions";

type BadgeState = "accept" | "merge" | "alternative" | "refuse" | "held" | "kept";
const OUTCOME_TONE: Record<BadgeState, LegendTone> = {
  accept: "ready",
  merge: "run",
  alternative: "run",
  refuse: "neutral",
  held: "you",
  // refused, then kept by a person: it goes on as a draft
  kept: "run",
};

function Row({ label, children, testid }: { label: string; children: React.ReactNode; testid: string }) {
  return (
    <div className="grid gap-0.5 border-t border-line-subtle py-2.5 first:border-t-0 first:pt-0 sm:flex sm:gap-6" data-testid={testid}>
      <dt className="shrink-0 text-12 font-medium text-muted sm:w-36 sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 flex-1 text-14 leading-snug text-fg">{children}</dd>
    </div>
  );
}

function Fact({ fact, slug }: { fact: ValueFactView | null; slug: string }) {
  const t = useCopy();
  if (!fact) return <span className="text-subtle">{t("intake.value.missing")}</span>;
  return (
    <>
      <span>{fact.value}</span>
      <span className="text-12 text-subtle">
        {" · "}
        {fact.source.kind === "recommended" ? (
          t("intake.value.fromQuestion", { n: fact.source.question })
        ) : (
          <>
            {t("intake.from")} <IntakeRefLink slug={slug} target={fact.source} />
          </>
        )}
      </span>
    </>
  );
}

function Outcome({ value, slug, redrafting }: { value: ValueCheckView; slug: string; redrafting: boolean }) {
  const t = useCopy();
  const o = value.outcome;
  if (!o) return <span className="text-muted">{t(redrafting ? "intake.value.redrafting" : "intake.value.held")}</span>;
  if (o.kind === "accept") return <span>{t("intake.value.acceptLine")}</span>;
  if (o.kind === "refuse") return <span data-testid="value-reason">{o.reason}</span>;
  if (o.kind === "merge") {
    return (
      <span>
        {t("intake.value.into")} <IntakeRefLink slug={slug} target={o.into} />
        <span className="text-muted"> · {o.why}</span>
        {value.effect?.as === "suggestion" ? <span className="text-12 text-subtle"> · {t("intake.value.mergeProposed")}</span> : null}
      </span>
    );
  }
  return (
    <span>
      {o.instead}
      {o.ref ? (
        <span className="text-12 text-subtle">
          {" · "}
          {t("intake.from")} <IntakeRefLink slug={slug} target={o.ref} />
        </span>
      ) : null}
    </span>
  );
}

function KeepForm({ projectId, itemKey }: { projectId: string; itemKey: string }) {
  const t = useCopy();
  const keep = useKeepRefusedRequest(projectId, itemKey);
  const [reason, setReason] = useState("");
  const ready = reason.trim().length > 0;
  return (
    <form
      className="mt-2 flex max-w-xl flex-wrap items-center gap-2"
      data-testid="value-keep"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) keep.mutate({ reason: reason.trim() });
      }}
    >
      <Input className="min-w-0 flex-1" aria-label={t("intake.value.keepLabel")} placeholder={t("intake.value.keepPlaceholder")} value={reason} maxLength={150} onChange={(e) => setReason(e.target.value)} />
      <Button type="submit" size="sm" variant="secondary" disabled={!ready || keep.isPending}>
        {t("intake.value.keep")}
      </Button>
      <span className="basis-full">
        <RefusalLine error={keep.error} testid="value-keep-refusal" />
      </span>
    </form>
  );
}

function ValueRows({ draft, value, projectId, slug }: { draft: IntakeDraftView; value: ValueCheckView; projectId: string; slug: string }) {
  const t = useCopy();
  const redrafting = isRedrafting(draft);
  return (
    <dl className="grid">
      <Row label={t("intake.value.who")} testid="value-who">
        <Fact fact={value.who} slug={slug} />
      </Row>
      <Row label={t("intake.value.improves")} testid="value-improves">
        <Fact fact={value.improves} slug={slug} />
      </Row>
      <Row label={t("intake.value.measured")} testid="value-measured">
        <Fact fact={value.measured} slug={slug} />
      </Row>
      <Row label={t("intake.value.exists")} testid="value-exists">
        {value.exists ? (
          <>
            <IntakeRefLink slug={slug} target={value.exists.ref} /> <span className="text-muted">{value.exists.ref.title}</span>
            <span className="text-12 text-subtle"> · {value.exists.why}</span>
          </>
        ) : (
          <span className="text-subtle">{t("intake.value.existsNone")}</span>
        )}
      </Row>
      <Row label={t(`intake.value.outcome.${value.outcome?.kind ?? "held"}`)} testid="value-outcome">
        <Outcome value={value} slug={slug} redrafting={redrafting} />
        {value.kept ? (
          <p className="mt-1 text-13 leading-snug" data-testid="value-kept">
            <span className="font-medium">{t("intake.value.kept")}</span> {value.kept.reason}
            <span className="text-12 text-subtle"> · {value.kept.by.name ?? t("intake.someone")}</span>
          </p>
        ) : null}
        {draft.can.keep ? <KeepForm projectId={projectId} itemKey={draft.item.key} /> : null}
      </Row>
    </dl>
  );
}

/** The value check of `itemKey` (REQ-n or FB-n), with its questions; nothing while no draft was made. */
export function ValueCheck({ projectId, slug, itemKey }: { projectId: string; slug: string; itemKey: string }) {
  const t = useCopy();
  const draft = useIntakeDraft(projectId, itemKey).data?.draft;
  if (!draft || draft.outcome !== "drafted") return null;
  const value = draft.value;
  const state = value ? (value.outcome?.kind ?? "held") : null;
  const badge: BadgeState | null = value?.kept ? "kept" : state;
  return (
    <section className="grid gap-4" data-testid="value-check" data-outcome={state ?? undefined}>
      <ViewHeading right={badge ? <ToneBadge tone={OUTCOME_TONE[badge]} label={t(`intake.value.state.${badge}`)} title={t(`intake.value.state.${badge}`)} value={badge} /> : undefined}>
        {t("intake.value.heading")}
      </ViewHeading>
      {value ? <ValueRows draft={draft} value={value} projectId={projectId} slug={slug} /> : <p className="text-13 text-subtle">{t("intake.value.notChecked")}</p>}
      <ValueQuestions draft={draft} projectId={projectId} />
    </section>
  );
}
