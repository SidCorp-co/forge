// The few words every lessons surface draws the same way: a lesson's scope, a person, a source.

import {
  CORRECTION_SOURCE_LABELS,
  type CorrectionSource,
  LESSON_CONFUSION_LABELS,
  type LessonConfusionKind,
  type LessonPerson,
  type LessonScopeView,
} from "@forge/contracts/lessons";
import type { useCopy } from "@/lib/i18n/interface-language";

type Copy = ReturnType<typeof useCopy>;

export function scopeWords(t: Copy, scope: LessonScopeView): string {
  if (scope.kind === "area") return t("lessons.scope.area", { name: scope.areaName ?? "?" });
  if (scope.kind === "item_kind") return t("lessons.scope.itemKind", { kind: scope.itemKind ?? "?" });
  return t("lessons.scope.project");
}

export function personWords(t: Copy, person: LessonPerson | null, agency: "human" | "agent" = "human"): string {
  return person?.name ?? (agency === "agent" ? t("lessons.confusion.agent") : "?");
}

export const sourceWords = (source: CorrectionSource) => CORRECTION_SOURCE_LABELS[source];

export const confusionWords = (kind: LessonConfusionKind) => LESSON_CONFUSION_LABELS[kind];
