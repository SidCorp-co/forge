// A requirement's Overview tab, read top down under its picture (REQ-65 BC-7, ISS-691): Problem,
// Value and Measured by as short properties, then the criteria as short rows, then its summary where
// it has one, its value check (REQ-65), its checklists' answers and gaps (REQ-34 r2 BC-5, BC-26), what
// is still unclear, what it assumes, whom it serves and its scope, and the suggestions waiting on it.
// The revision each is read from, where an answer came from and the intake assistant's draft are agent
// text, drawn in the developer view (REQ-43 BC-7).

import { FieldLabel, ViewHeading } from "@/design";
import { RequirementChecklists } from "@/features/checklists";
import { IntakeDraft, ValueCheck } from "@/features/intake";
import { RequirementSuggestions } from "@/features/suggestions";
import { useWaitingSuggestions } from "@/features/suggestions";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { Written } from "@/lib/i18n/written";
import type { RequirementDetail, RequirementRevision } from "../types";
import { RequirementCriteria } from "./requirement-criteria";
import { RequirementGoal } from "./requirement-goal";
import { Assumptions, OpenQuestions } from "./requirement-unclear";

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="grid list-disc gap-1 pl-4.5 text-14 leading-relaxed marker:text-neutral-8">
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

const NoneNamed = ({ t }: { t: Copy }) => <p className="text-13 text-subtle">{t("requirements.overview.noneNamed")}</p>;

/** What the requirement says first: the shown revision's TL;DR, else its goal, in the language it was
 *  written in. The Overview's summary and the peek read it here, so both say the same words. */
export function requirementSummary(d: RequirementDetail): { text: string; lang: RequirementRevision["writtenLang"] } | null {
  const shown = d.revisions.find((r) => r.state === "current") ?? d.revisions[0];
  const text = shown?.tldr ?? shown?.spec?.goal;
  return text ? { text, lang: shown?.writtenLang } : null;
}

export function RequirementOverview({
  d,
  projectId,
  slug,
  onRevise,
  developer = false,
}: {
  d: RequirementDetail;
  projectId: string;
  slug: string;
  onRevise?: (() => void) | undefined;
  developer?: boolean;
}) {
  const t = useCopy();
  const shown = d.revisions.find((r) => r.state === "current") ?? d.revisions[0];
  const spec = shown?.spec ?? {};
  const sug = useWaitingSuggestions(projectId, { requirement: d.key });
  const waiting = d.canSignOff && (sug.data?.suggestions.length ?? 0) > 0;
  return (
    <div className="grid grid-cols-1 gap-8" data-testid="view-overview">
      <div className="grid gap-2">
        <RequirementGoal d={d} developer={developer} />
        {spec.goal ? (
          <details className="max-w-xl" data-testid="goal-full">
            <summary className="cursor-pointer select-none text-13 font-medium text-muted hover:text-fg">{t("requirements.overview.fullGoal")}</summary>
            <Written className="mt-1.5 block whitespace-pre-line text-14 leading-relaxed" text={spec.goal} lang={shown?.writtenLang} />
          </details>
        ) : null}
      </div>
      <RequirementCriteria d={d} projectId={projectId} slug={slug} developer={developer} />
      {shown?.tldr ? (
        <section>
          <ViewHeading>{t("requirements.overview.summary")}</ViewHeading>
          <Written className="block max-w-2xl text-14 leading-relaxed text-fg" text={shown.tldr} lang={shown.writtenLang} />
        </section>
      ) : null}
      <ValueCheck projectId={projectId} slug={slug} itemKey={d.key} />
      <RequirementChecklists projectId={projectId} reqKey={d.key} onRevise={d.standing.attentionGroup !== "done" ? onRevise : undefined} developer={developer} />
      <OpenQuestions questions={d.questions} unclear={d.unclear} projectId={projectId} reqKey={d.key} slug={slug} />
      {spec.assumptions?.length ? <Assumptions assumptions={spec.assumptions} revision={developer ? (shown?.revision ?? null) : null} slug={slug} /> : null}
      {developer ? <IntakeDraft projectId={projectId} slug={slug} itemKey={d.key} assumptions={false} /> : null}
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
