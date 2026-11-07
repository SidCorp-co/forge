// A requirement's goal as the short properties its page reads under the picture (REQ-65 BC-7,
// ISS-691): Problem, Value and Measured by, read from the shown revision's goal by the one parser
// core's ready checklist reads it with (`@forge/contracts/requirement-goal:goalAnswers`), so the page
// and the agree never disagree on what the goal states. Each reads on one line, its whole text behind
// a hover and the folded full goal. The labels the goal leaves out are named once, on one "Not stated"
// line, never a "Not stated" row each (ISS-1109, FB-567): what is missing stays visible and actionable.

import { goalAnswers } from "@forge/contracts/requirement-goal";
import { Property, PropertyList } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { Written } from "@/lib/i18n/written";
import { shownRevisionOf } from "../picture-model";
import type { RequirementDetail } from "../types";

/** The labels the page shows, in the order it shows them; the roadmap lane is the map's. */
const SHOWN = ["problem", "value", "measured"] as const;

/** A property's face is one line; the whole text is its tooltip and the full goal below. */
const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ");

export function RequirementGoal({ d, developer = false }: { d: RequirementDetail; developer?: boolean }) {
  const t = useCopy();
  const shown = shownRevisionOf(d);
  const said = goalAnswers(shown?.spec?.goal, shown?.writtenLang ?? null);
  const stated = SHOWN.filter((label) => said[label]);
  const missing = SHOWN.filter((label) => !said[label]);
  return (
    <section aria-label={t("requirements.goal.heading")} data-testid="requirement-goal">
      {developer && shown ? <p className="mb-1 text-12 text-subtle">{t("requirements.overview.fromR", { r: shown.revision })}</p> : null}
      <PropertyList>
        {stated.map((label) => (
          <Property key={label} label={t(`requirements.goal.${label}`)} testId={`goal-${label}`}>
            <span className="block min-w-0 max-w-2xl truncate text-14" title={said[label]}>
              <Written text={oneLine(said[label] ?? "")} lang={shown?.writtenLang} />
            </span>
          </Property>
        ))}
        {missing.length > 0 ? (
          <Property label={t("requirements.goal.notStated")} testId="goal-missing">
            <span className="text-13 text-subtle">{missing.map((label) => t(`requirements.goal.${label}`)).join(", ")}</span>
          </Property>
        ) : null}
      </PropertyList>
    </section>
  );
}
