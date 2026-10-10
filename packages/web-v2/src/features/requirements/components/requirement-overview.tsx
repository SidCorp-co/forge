"use client";

// A requirement's Overview tab: its summary, its checklists' answers and gaps (REQ-34 r2 BC-5, BC-26),
// what is still unclear, what it assumes and the intake assistant's draft of it, whom it serves and
// its scope, and the suggestions waiting on it.

import { FieldLabel, ViewHeading } from "@/design";
import { RequirementChecklists } from "@/features/checklists/components/item-checklists";
import { IntakeDraft } from "@/features/intake/components/intake-draft";
import { RequirementSuggestions } from "@/features/suggestions/components/suggestion-list";
import { useWaitingSuggestions } from "@/features/suggestions/hooks";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { Written } from "@/lib/i18n/written";
import type { RequirementDetail } from "../types";
import { Assumptions, OpenQuestions } from "./requirement-unclear";

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="grid list-disc gap-1 pl-4.5 text-14 leading-relaxed marker:text-[var(--paper-400)]">
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

const NoneNamed = ({ t }: { t: Copy }) => <p className="text-13 text-subtle">{t("requirements.overview.noneNamed")}</p>;

export function RequirementOverview({ d, projectId, slug, onRevise }: { d: RequirementDetail; projectId: string; slug: string; onRevise?: (() => void) | undefined }) {
  const t = useCopy();
  const shown = d.revisions.find((r) => r.state === "current") ?? d.revisions[0];
  const spec = shown?.spec ?? {};
  const summary = shown?.tldr ?? spec.goal;
  const goalBeyond = shown?.tldr && spec.goal && spec.goal !== shown.tldr ? spec.goal : null;
  const sug = useWaitingSuggestions(projectId, { requirement: d.key });
  const waiting = d.canSignOff && (sug.data?.suggestions.length ?? 0) > 0;
  return (
    <div className="grid gap-8" data-testid="view-overview">
      <section>
        <ViewHeading right={shown ? <span className="text-12 text-subtle">{t("requirements.overview.fromR", { r: shown.revision })}</span> : undefined}>
          {t("requirements.overview.summary")}
        </ViewHeading>
        {summary ? <Written className="block max-w-2xl text-15 leading-relaxed text-fg" text={summary} lang={shown?.writtenLang} /> : <p className="text-13 text-subtle">{t("requirements.overview.noSummary")}</p>}
        {goalBeyond ? (
          <details className="mt-2 max-w-xl">
            <summary className="cursor-pointer select-none text-13 font-medium text-muted hover:text-fg">{t("requirements.overview.fullGoal")}</summary>
            <p className="mt-1.5 text-14 leading-relaxed">{goalBeyond}</p>
          </details>
        ) : null}
      </section>
      <RequirementChecklists projectId={projectId} reqKey={d.key} onRevise={d.standing.attentionGroup !== "done" ? onRevise : undefined} />
      <OpenQuestions questions={d.questions} unclear={d.unclear} projectId={projectId} reqKey={d.key} slug={slug} />
      {spec.assumptions?.length ? <Assumptions assumptions={spec.assumptions} revision={shown?.revision ?? null} slug={slug} /> : null}
      <IntakeDraft projectId={projectId} slug={slug} itemKey={d.key} assumptions={false} />
      {spec.personas?.length || spec.scopeIn?.length || spec.scopeOut?.length ? (
        <section>
          <ViewHeading>{t("requirements.overview.servesAndScope")}</ViewHeading>
          <div className="grid gap-x-10 gap-y-5 md:grid-cols-2">
            <div>
              <FieldLabel>{t("requirements.overview.persona")}</FieldLabel>
              {spec.personas?.length ? <Bullets items={spec.personas} /> : <NoneNamed t={t} />}
            </div>
            <div className="grid content-start gap-5">
              <div>
                <FieldLabel>{t("requirements.overview.inScope")}</FieldLabel>
                {spec.scopeIn?.length ? <Bullets items={spec.scopeIn} /> : <NoneNamed t={t} />}
              </div>
              <div>
                <FieldLabel>{t("requirements.overview.outOfScope")}</FieldLabel>
                {spec.scopeOut?.length ? <Bullets items={spec.scopeOut} /> : <NoneNamed t={t} />}
              </div>
            </div>
          </div>
        </section>
      ) : null}
      {waiting ? (
        <section>
          <ViewHeading>{t("requirements.overview.suggestionsWaiting")}</ViewHeading>
          <RequirementSuggestions projectId={projectId} reqKey={d.key} />
        </section>
      ) : null}
    </div>
  );
}
