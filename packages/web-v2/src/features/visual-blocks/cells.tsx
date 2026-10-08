"use client";

import { type ReportCell, type ReportField, type ReportFieldVocabulary, stateLabel } from "@forge/contracts/report-queries";
import { cellText } from "@forge/contracts/visual-blocks";
import Link from "next/link";
import { StatusBadge, ToneBadge } from "@/design/primitives/enum-badge";
import { type StatusFamily, statusReading } from "@/design/vocabulary";
import { useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { useVisualBlockContext } from "./context";
import { refHref } from "./ref-link";

/**
 * The badge family each vocabulary a report column may name is read through; a new vocabulary
 * without one does not compile. Each family's label map is the contracts' `REPORT_VOCABULARY_LABELS`
 * entry itself, so the badge and the text fallback read one map.
 */
export const VOCABULARY_FAMILY: Record<ReportFieldVocabulary, StatusFamily> = {
  requirement: "requirement",
  releaseState: "releaseState",
  bcVerdict: "bcVerdict",
};

/**
 * A `status` cell, as every state on the product is drawn: the shared badge with a sentence-case
 * label and the stored value only in its tooltip. A column that names its vocabulary wears that
 * family's tone; one that names none reads sentence-cased and neutral.
 */
function StateCell({ field, value }: { field: ReportField; value: string }) {
  if (field.vocabulary) return <StatusBadge family={VOCABULARY_FAMILY[field.vocabulary]} value={value} />;
  return <ToneBadge tone="neutral" label={stateLabel(field, value)} title={value} value={value} />;
}

/** A state value as words, for a place that names it without its badge (a timeline's lane heading). */
export function useStateLabel(): (field: ReportField, value: string) => string {
  const language = useInterfaceLanguage();
  return (field, value) => {
    if (field.type !== "status") return value;
    return field.vocabulary ? statusReading(VOCABULARY_FAMILY[field.vocabulary], value, language).label : stateLabel(field, value);
  };
}

/** One frame cell as it is read: a `ref` links to what it names when the project is known, a `status` is a badge, everything else is its text. */
export function Cell({ field, cell }: { field: ReportField; cell: ReportCell | undefined }) {
  const { projectSlug } = useVisualBlockContext();
  const text = cellText(field, cell);
  if (field.type === "status" && typeof cell === "string" && cell !== "") return <StateCell field={field} value={cell} />;
  if (field.type === "ref" && typeof cell === "string" && cell !== "" && projectSlug) {
    return (
      <Link className="font-mono font-semibold text-link hover:underline" href={refHref(projectSlug, cell)}>
        {text}
      </Link>
    );
  }
  return <>{text}</>;
}
