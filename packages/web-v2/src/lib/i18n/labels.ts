import { ARTIFACT_CHANGE_LABELS, LANDING_SURFACE_LABELS } from "@forge/contracts/landing-artifacts";
import {
  DESIGN_REVISION_STATE_HINTS,
  DESIGN_REVISION_STATE_LABELS,
  DESIGN_STATUS_HINTS,
  DESIGN_STATUS_LABELS,
} from "@forge/contracts/design-status";
import {
  FEEDBACK_ATTENTION_LABELS,
  FEEDBACK_DECISION_LABELS,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_PHASE_HINTS,
  FEEDBACK_PHASE_LABELS,
  FEEDBACK_ROUTE_LABELS,
  FEEDBACK_SEVERITY_LABELS,
  FEEDBACK_TARGET_LABELS,
} from "@forge/contracts/feedback";
import {
  CRITERION_STANDING_HINTS,
  CRITERION_STANDING_LABELS,
  ISSUE_CATEGORY_LABELS,
  ISSUE_PRIORITY_LABELS,
  ISSUE_STATUS_HINTS,
  ISSUE_STATUS_LABELS,
  WORK_STEP_LABELS,
} from "@forge/contracts/issue-vocabulary";
import { NEEDS_YOU_AREA_LABELS } from "@forge/contracts/needs-you";
import { RELEASE_ATTENTION_LABELS, RELEASE_PROOF_LABELS, RELEASE_STATE_HINTS, RELEASE_STATE_LABELS } from "@forge/contracts/releases";
import {
  BC_VERDICT_HINTS,
  BC_VERDICT_LABELS,
  REQUIREMENT_ATTENTION_LABELS,
  REQUIREMENT_STATE_HINTS,
  REQUIREMENT_STATE_LABELS,
  REVISION_STATE_HINTS,
  REVISION_STATE_LABELS,
} from "@forge/contracts/requirements";
import { SUGGESTION_STATUS_LABELS } from "@forge/contracts/suggestions";
import { HEALTH_MARKER_LABELS } from "@forge/contracts/workflow-health";
import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { copyOr } from "./product-copy";

// The words the contracts give an enum value (a requirement's state, a feedback's phase, an area of
// Needs you). The contract's label is English and stays the source: it is what a language without a
// translation reads, and what the locale file's English holds, key for key (`labels.test.ts` walks
// every value of every group, so a value added to a contract with no translation is red).

const labelsOf = <V extends { label: string }>(m: Record<string, V>): Record<string, string> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.label]));
const hintsOf = <V extends { hint: string | null }>(m: Record<string, V>): Record<string, string> =>
  Object.fromEntries(Object.entries(m).flatMap(([k, v]) => (v.hint ? [[k, v.hint]] : [])));

// The built-in workflow templates' words, keyed `<template id>.<element id>`: a node type, a band
// and a line kind take their words from the template they belong to, since two templates may give one
// id different words. A project's own template is never here: its words are its author's.
const builtin = <E extends { id: string }>(
  of: (t: (typeof BUILTIN_WORKFLOW_TEMPLATES)[number]) => readonly E[],
  word: (e: E) => string | undefined,
): Record<string, string> =>
  Object.fromEntries(BUILTIN_WORKFLOW_TEMPLATES.flatMap((t) => of(t).flatMap((e) => (word(e) ? [[`${t.id}.${e.id}`, word(e) as string]] : []))));
const bandsOf = (t: (typeof BUILTIN_WORKFLOW_TEMPLATES)[number]) => (t.lanes.from === "template" ? t.lanes.bands : []);

const sentencesOf = (m: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.replace(/^[a-z_-]+: /, "")]));

export const LABEL_GROUPS = {
  requirementState: REQUIREMENT_STATE_LABELS,
  bcVerdict: BC_VERDICT_LABELS,
  revisionState: REVISION_STATE_LABELS,
  requirementAttention: labelsOf(REQUIREMENT_ATTENTION_LABELS),
  requirementAttentionHint: hintsOf(REQUIREMENT_ATTENTION_LABELS),
  releaseState: RELEASE_STATE_LABELS,
  releaseProof: RELEASE_PROOF_LABELS,
  releaseAttention: labelsOf(RELEASE_ATTENTION_LABELS),
  releaseAttentionHint: hintsOf(RELEASE_ATTENTION_LABELS),
  feedbackPhase: FEEDBACK_PHASE_LABELS,
  feedbackKind: FEEDBACK_KIND_LABELS,
  feedbackSeverity: FEEDBACK_SEVERITY_LABELS,
  feedbackRoute: FEEDBACK_ROUTE_LABELS,
  feedbackDecision: FEEDBACK_DECISION_LABELS,
  feedbackTarget: FEEDBACK_TARGET_LABELS,
  feedbackAttention: labelsOf(FEEDBACK_ATTENTION_LABELS),
  feedbackAttentionHint: hintsOf(FEEDBACK_ATTENTION_LABELS),
  needsYouArea: NEEDS_YOU_AREA_LABELS,
  healthMarker: HEALTH_MARKER_LABELS,
  designStatus: DESIGN_STATUS_LABELS,
  designRevisionState: DESIGN_REVISION_STATE_LABELS,
  landingSurface: LANDING_SURFACE_LABELS,
  artifactChange: ARTIFACT_CHANGE_LABELS,
  criterionStanding: CRITERION_STANDING_LABELS,
  issuePriority: ISSUE_PRIORITY_LABELS,
  issueStatus: ISSUE_STATUS_LABELS,
  workStep: WORK_STEP_LABELS,
  issueCategory: ISSUE_CATEGORY_LABELS,
  suggestionStatus: SUGGESTION_STATUS_LABELS,
  templateTitle: Object.fromEntries(BUILTIN_WORKFLOW_TEMPLATES.map((t) => [t.id, t.title])),
  templateNode: builtin((t) => t.nodeTypes, (n) => n.label),
  templateNodeHint: builtin((t) => t.nodeTypes, (n) => n.tooltip),
  templateBand: builtin(bandsOf, (b) => b.label),
  templateBandHint: builtin(bandsOf, (b) => b.tooltip),
  templateEdge: builtin((t) => t.edgeKinds, (k) => k.label),
  templateEdgeHint: builtin((t) => t.edgeKinds, (k) => k.tooltip),
  // what a state means, for the tooltip: the contracts write `value: sentence` and the badge shows the sentence
  hintRequirementState: sentencesOf(REQUIREMENT_STATE_HINTS),
  hintBcVerdict: sentencesOf(BC_VERDICT_HINTS),
  hintRevisionState: sentencesOf(REVISION_STATE_HINTS),
  hintFeedbackPhase: sentencesOf(FEEDBACK_PHASE_HINTS),
  hintReleaseState: sentencesOf(RELEASE_STATE_HINTS),
  hintIssueStatus: sentencesOf(ISSUE_STATUS_HINTS),
  hintCriterionStanding: sentencesOf(CRITERION_STANDING_HINTS),
  hintDesignStatus: sentencesOf(DESIGN_STATUS_HINTS),
  hintDesignRevisionState: sentencesOf(DESIGN_REVISION_STATE_HINTS),
} as const satisfies Record<string, Record<string, string>>;

export type LabelGroup = keyof typeof LABEL_GROUPS;

export const labelKey = (group: LabelGroup, value: string) => `label.${group}.${value}`;

/** The label of `value` in `group`, in `language`; a value no group names reads as itself. */
export function labelCopy(language?: string | null) {
  return (group: LabelGroup, value: string): string => {
    const source = (LABEL_GROUPS[group] as Record<string, string>)[value] ?? value;
    return copyOr(language, labelKey(group, value), source);
  };
}
