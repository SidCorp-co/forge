// A requirement's Overview tab, read top down under its picture (REQ-65 BC-7, ISS-691): Problem,
// Value and Measured by as short properties, then the criteria as short rows, then its value check
// (REQ-65), its checklists' answers and gaps (REQ-34 r2 BC-5, BC-26), what is still unclear, what it
// assumes, and the suggestions waiting on it. Its long text — the whole goal, its summary, whom it
// serves and its scope — sits behind one Full text drawer, never expanded in place (REQ-43 r3 BC-17).
// The revision each is read from, where an answer came from and the intake assistant's draft are agent
// text, drawn in the developer view (REQ-43 BC-7).

import { DetailDrawer, FieldLabel, ViewHeading } from "@/design";
import { RequirementChecklists } from "@/features/checklists";
import { IntakeDraft, ValueCheck } from "@/features/intake";
import { RequirementSuggestions } from "@/features/suggestions";
import { useWaitingSuggestions } from "@/features/suggestions";
import { useCopy } from "@/lib/i18n/interface-language";
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

const SCOPE = [
  ["personas", "requirements.overview.persona"],
  ["scopeIn", "requirements.overview.inScope"],
  ["scopeOut", "requirements.overview.outOfScope"],
] as const;

/**
 * Whom it serves and its scope: each list it names, and the ones it leaves out named once on one "Not
 * stated" line, never a "None named." each (ISS-1109, FB-567); a revision naming none draws nothing.
 */
function ServesAndScope({ spec }: { spec: NonNullable<RequirementRevision["spec"]> }) {
  const t = useCopy();
  const named = SCOPE.filter(([k]) => spec[k]?.length);
  const missing = SCOPE.filter(([k]) => !spec[k]?.length);
  if (named.length === 0) return null;
  return (
    <section data-testid="requirement-scope">
      <ViewHeading>{t("requirements.overview.servesAndScope")}</ViewHeading>
      <div className="grid gap-5">
        {named.map(([k, label]) => (
          <div key={k}>
            <FieldLabel>{t(label)}</FieldLabel>
            <Bullets items={spec[k] ?? []} />
          </div>
        ))}
      </div>
      {missing.length > 0 ? (
        <p className="mt-3 text-13 text-subtle" data-testid="scope-missing">
          {t("requirements.goal.notStated")}: {missing.map(([, label]) => t(label)).join(", ")}
        </p>
      ) : null}
    </section>
  );
}

/** The long text a requirement holds, in one side drawer: its whole goal, its summary, whom it serves and its scope. */
function FullText({ shown }: { shown: RequirementRevision | undefined }) {
  const t = useCopy();
  const spec = shown?.spec ?? {};
  const scoped = SCOPE.some(([k]) => spec[k]?.length);
  if (!spec.goal && !shown?.tldr && !scoped) return null;
  return (
    <DetailDrawer label={t("requirements.overview.fullText")} icon="book" width={560} testId="requirement-text">
      <div className="grid gap-6" data-testid="requirement-text-body">
        {spec.goal ? (
          <section data-testid="goal-full">
            <ViewHeading>{t("requirements.overview.fullGoal")}</ViewHeading>
            <Written className="block whitespace-pre-line text-14 leading-relaxed" text={spec.goal} lang={shown?.writtenLang} />
          </section>
        ) : null}
        {shown?.tldr ? (
          <section>
            <ViewHeading>{t("requirements.overview.summary")}</ViewHeading>
            <Written className="block text-14 leading-relaxed text-fg" text={shown.tldr} lang={shown.writtenLang} />
          </section>
        ) : null}
        <ServesAndScope spec={spec} />
      </div>
    </DetailDrawer>
  );
}

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
      <div className="flex items-start justify-between gap-3">
        <RequirementGoal d={d} developer={developer} />
        <FullText shown={shown} />
      </div>
      <RequirementCriteria d={d} projectId={projectId} slug={slug} developer={developer} />
      <ValueCheck projectId={projectId} slug={slug} itemKey={d.key} />
      <RequirementChecklists projectId={projectId} reqKey={d.key} onRevise={d.standing.attentionGroup !== "done" ? onRevise : undefined} developer={developer} status={d.status} />
      {/* nothing asked and nothing open: no empty section (ISS-1109) */}
      {d.unclear > 0 || d.questions.length > 0 ? <OpenQuestions questions={d.questions} unclear={d.unclear} projectId={projectId} reqKey={d.key} slug={slug} /> : null}
      {spec.assumptions?.length ? <Assumptions assumptions={spec.assumptions} revision={developer ? (shown?.revision ?? null) : null} slug={slug} /> : null}
      {developer ? <IntakeDraft projectId={projectId} slug={slug} itemKey={d.key} assumptions={false} /> : null}
      {waiting ? (
        <section>
          <ViewHeading>{t("requirements.overview.suggestionsWaiting")}</ViewHeading>
          <RequirementSuggestions projectId={projectId} reqKey={d.key} />
        </section>
      ) : null}
    </div>
  );
}
