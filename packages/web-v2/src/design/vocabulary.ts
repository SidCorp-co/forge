// The badge legend and every fixed enum's reading, in one place. Labels, tones, glyphs and hints are
// declared in @forge/contracts beside each enum (or, for an enum core declares, in contracts'
// `ui-vocabulary.ts`); this file only names which map each family reads and which design-kit colours
// each legend tone draws. A screen never declares a colour map.

import { SENSITIVE_DATA_BADGES } from "@forge/contracts/data-policy";
import { ARTIFACT_CHANGE_LABELS, LANDING_SURFACE_LABELS } from "@forge/contracts/landing-artifacts";
import { NOTIFICATION_TYPE_LABELS } from "@forge/contracts/notifications";
import { ONBOARDING_STATUS_LABELS, ONBOARDING_STATUS_TONES, THREAD_STATUS_HINTS } from "@forge/contracts/onboarding";
import {
  DESIGN_REVISION_STATE_GLYPHS,
  DESIGN_REVISION_STATE_HINTS,
  DESIGN_REVISION_STATE_LABELS,
  DESIGN_REVISION_STATE_TONES,
  DESIGN_STATUS_GLYPHS,
  DESIGN_STATUS_HINTS,
  DESIGN_STATUS_LABELS,
  DESIGN_STATUS_TONES,
} from "@forge/contracts/design-status";
import {
  FEEDBACK_DECISION_LABELS,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_PHASE_GLYPHS,
  FEEDBACK_PHASE_HINTS,
  FEEDBACK_PHASE_LABELS,
  FEEDBACK_PHASE_TONES,
  FEEDBACK_ROUTE_LABELS,
  FEEDBACK_SEVERITY_LABELS,
  FEEDBACK_SEVERITY_TONES,
  FEEDBACK_TARGET_LABELS,
} from "@forge/contracts/feedback";
import {
  MOCKUP_KIND_LABELS,
  MOCKUP_STATUS_GLYPHS,
  MOCKUP_STATUS_HINTS,
  MOCKUP_STATUS_LABELS,
  MOCKUP_STATUS_TONES,
} from "@forge/contracts/mockups";
import { ISSUE_ATTENTION_LABELS, ISSUE_LEASE_VERDICT_LABELS, ISSUE_LEASE_VERDICT_TONES } from "@forge/contracts/issue-standing";
import {
  CRITERION_STANDING_GLYPHS,
  CRITERION_STANDING_HINTS,
  CRITERION_STANDING_LABELS,
  CRITERION_STANDING_TONES,
  ISSUE_CATEGORY_LABELS,
  ISSUE_PRIORITY_BARS,
  ISSUE_PRIORITY_LABELS,
  ISSUE_STATUS_GLYPHS,
  ISSUE_STATUS_HINTS,
  ISSUE_STATUS_LABELS,
  ISSUE_STATUS_TONES,
  type IssueStatusTone,
  WORK_STEP_LABELS,
} from "@forge/contracts/issue-vocabulary";
import {
  BC_VERDICT_HINTS,
  BC_VERDICT_LABELS,
  BC_VERDICT_TONES,
  REQUIREMENT_STATE_GLYPHS,
  REQUIREMENT_STATE_HINTS,
  REQUIREMENT_STATE_LABELS,
  REQUIREMENT_STATE_TONES,
  REVISION_STATE_GLYPHS,
  REVISION_STATE_HINTS,
  REVISION_STATE_LABELS,
  REVISION_STATE_TONES,
} from "@forge/contracts/requirements";
import {
  RELEASE_STATE_GLYPHS,
  RELEASE_STATE_HINTS,
  RELEASE_STATE_LABELS,
  RELEASE_STATE_TONES,
} from "@forge/contracts/releases";
import { SUGGESTION_STATUS_GLYPHS, SUGGESTION_STATUS_LABELS, SUGGESTION_STATUS_TONES } from "@forge/contracts/suggestions";
import {
  CONTRACT_ADOPTION_GLYPHS,
  CONTRACT_ADOPTION_HINTS,
  CONTRACT_ADOPTION_LABELS,
  CONTRACT_ADOPTION_TONES,
  CONTRACT_APPROVAL_LABELS,
  CONTRACT_APPROVAL_TONES,
  CONTRACT_DIRECTION_LABELS,
  CONTRACT_STATE_GLYPHS,
  CONTRACT_STATE_HINTS,
  CONTRACT_STATE_LABELS,
  CONTRACT_STATE_TONES,
} from "@forge/contracts/contract-standing";
import { ENUM_LABELS, type Reading, STATE_READINGS } from "@forge/contracts/ui-vocabulary";
import { type LabelGroup, labelKey } from "@/lib/i18n/labels";
import { copyOr } from "@/lib/i18n/product-copy";
import { type ColorMeta, TONE_META } from "./status";

/** The legend's meaning per tone: amber waits on you, cobalt is running, slate is blocked, green is
 *  ready, grey is done, red came back; neutral is not moving. */
export type LegendTone = IssueStatusTone;

export const LEGEND: Record<LegendTone, Omit<ColorMeta, "label">> = {
  neutral: TONE_META.neutral,
  ready: TONE_META.success,
  run: TONE_META.active,
  you: TONE_META.attention,
  blocked: TONE_META.infra,
  done: TONE_META.archived,
  err: TONE_META.failure,
};

export interface StatusReading {
  label: string;
  tone: LegendTone;
  glyph: string | null;
  /** What the value means, for the tooltip; the badge prefixes the raw value. */
  hint: string | null;
}

interface Maps {
  labels: Record<string, string>;
  tones: Record<string, LegendTone>;
  glyphs?: Record<string, string>;
  hints?: Record<string, string>;
}

const fromReadings = (r: Record<string, Reading>): Maps => ({
  labels: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v[0]])),
  tones: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v[1]])),
  glyphs: Object.fromEntries(Object.entries(r).flatMap(([k, v]) => (v[2] ? [[k, v[2]]] : []))),
});

const POLICY_TONE: Record<(typeof SENSITIVE_DATA_BADGES)[keyof typeof SENSITIVE_DATA_BADGES]["tone"], LegendTone> = {
  neutral: "neutral",
  attention: "you",
  failure: "err",
};

const CONTRACT_FAMILIES = {
  issue: { labels: ISSUE_STATUS_LABELS, tones: ISSUE_STATUS_TONES, glyphs: ISSUE_STATUS_GLYPHS, hints: ISSUE_STATUS_HINTS },
  requirement: { labels: REQUIREMENT_STATE_LABELS, tones: REQUIREMENT_STATE_TONES, glyphs: REQUIREMENT_STATE_GLYPHS, hints: REQUIREMENT_STATE_HINTS },
  bcVerdict: {
    labels: BC_VERDICT_LABELS,
    tones: BC_VERDICT_TONES,
    glyphs: { passing: "✓", failing: "×", stale: "↻", not_judged: "○", gap: "!" },
    hints: BC_VERDICT_HINTS,
  },
  criterion: { labels: CRITERION_STANDING_LABELS, tones: CRITERION_STANDING_TONES, glyphs: CRITERION_STANDING_GLYPHS, hints: CRITERION_STANDING_HINTS },
  revision: { labels: REVISION_STATE_LABELS, tones: REVISION_STATE_TONES, glyphs: REVISION_STATE_GLYPHS, hints: REVISION_STATE_HINTS },
  design: { labels: DESIGN_STATUS_LABELS, tones: DESIGN_STATUS_TONES, glyphs: DESIGN_STATUS_GLYPHS, hints: DESIGN_STATUS_HINTS },
  designRevision: { labels: DESIGN_REVISION_STATE_LABELS, tones: DESIGN_REVISION_STATE_TONES, glyphs: DESIGN_REVISION_STATE_GLYPHS, hints: DESIGN_REVISION_STATE_HINTS },
  releaseState: { labels: RELEASE_STATE_LABELS, tones: RELEASE_STATE_TONES, glyphs: RELEASE_STATE_GLYPHS, hints: RELEASE_STATE_HINTS },
  feedbackPhase: { labels: FEEDBACK_PHASE_LABELS, tones: FEEDBACK_PHASE_TONES, glyphs: FEEDBACK_PHASE_GLYPHS, hints: FEEDBACK_PHASE_HINTS },
  severity: { labels: FEEDBACK_SEVERITY_LABELS, tones: FEEDBACK_SEVERITY_TONES },
  mockup: { labels: MOCKUP_STATUS_LABELS, tones: MOCKUP_STATUS_TONES, glyphs: MOCKUP_STATUS_GLYPHS, hints: MOCKUP_STATUS_HINTS },
  lease: { labels: ISSUE_LEASE_VERDICT_LABELS, tones: ISSUE_LEASE_VERDICT_TONES },
  attention: {
    labels: Object.fromEntries(Object.entries(ISSUE_ATTENTION_LABELS).map(([k, v]) => [k, v.label])),
    tones: Object.fromEntries(Object.entries(ISSUE_ATTENTION_LABELS).map(([k, v]) => [k, v.tone])),
  },
  suggestion: { labels: SUGGESTION_STATUS_LABELS, tones: SUGGESTION_STATUS_TONES, glyphs: SUGGESTION_STATUS_GLYPHS },
  contractState: { labels: CONTRACT_STATE_LABELS, tones: CONTRACT_STATE_TONES, glyphs: CONTRACT_STATE_GLYPHS, hints: CONTRACT_STATE_HINTS },
  contractAdoption: { labels: CONTRACT_ADOPTION_LABELS, tones: CONTRACT_ADOPTION_TONES, glyphs: CONTRACT_ADOPTION_GLYPHS, hints: CONTRACT_ADOPTION_HINTS },
  contractApproval: { labels: CONTRACT_APPROVAL_LABELS, tones: CONTRACT_APPROVAL_TONES, glyphs: { proposed: "●", approved: "✓", returned: "↺" } },
  onboarding: { labels: ONBOARDING_STATUS_LABELS, tones: ONBOARDING_STATUS_TONES, glyphs: { in_progress: "•", waiting_on_you: "?", done: "✓" } },
  thread: {
    labels: ONBOARDING_STATUS_LABELS,
    tones: ONBOARDING_STATUS_TONES,
    glyphs: { in_progress: "•", waiting_on_you: "?", done: "✓" },
    hints: THREAD_STATUS_HINTS,
  },
  dataPolicy: {
    labels: Object.fromEntries(Object.entries(SENSITIVE_DATA_BADGES).map(([k, v]) => [k, v.label])),
    tones: Object.fromEntries(Object.entries(SENSITIVE_DATA_BADGES).map(([k, v]) => [k, POLICY_TONE[v.tone]])),
    hints: Object.fromEntries(Object.entries(SENSITIVE_DATA_BADGES).map(([k, v]) => [k, `${k}: ${v.tip}`])),
  },
} satisfies Record<string, Maps>;

type ReadingFamily = keyof typeof STATE_READINGS;

/** State families: each value wears its legend tone. */
export type StatusFamily = keyof typeof CONTRACT_FAMILIES | ReadingFamily;

const STATUS_MAPS: Record<StatusFamily, Maps> = {
  ...CONTRACT_FAMILIES,
  ...(Object.fromEntries(Object.entries(STATE_READINGS).map(([k, r]) => [k, fromReadings(r)])) as Record<ReadingFamily, Maps>),
};

/** `change_request` reads "Change request": the fallback for a value no map names yet. */
export function sentenceCase(v: string): string {
  const t = v.replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const hintOf = (h: string | undefined) => (h ? h.replace(/^[a-z_-]+: /, "") : null);

/** The locale file's label group of a state family and of its hints; a family with none reads as the contract says it. */
const STATUS_GROUP: Partial<Record<StatusFamily, { label: LabelGroup; hint?: LabelGroup }>> = {
  issue: { label: "issueStatus", hint: "hintIssueStatus" },
  requirement: { label: "requirementState", hint: "hintRequirementState" },
  bcVerdict: { label: "bcVerdict", hint: "hintBcVerdict" },
  criterion: { label: "criterionStanding", hint: "hintCriterionStanding" },
  revision: { label: "revisionState", hint: "hintRevisionState" },
  design: { label: "designStatus", hint: "hintDesignStatus" },
  designRevision: { label: "designRevisionState", hint: "hintDesignRevisionState" },
  releaseState: { label: "releaseState", hint: "hintReleaseState" },
  feedbackPhase: { label: "feedbackPhase", hint: "hintFeedbackPhase" },
  severity: { label: "feedbackSeverity" },
  suggestion: { label: "suggestionStatus" },
  release: { label: "releaseApproval" },
  reconciliation: { label: "reconciliation" },
  buildGate: { label: "buildGate" },
  integration: { label: "integration" },
  dataPolicy: { label: "dataPolicy", hint: "hintDataPolicy" },
  thread: { label: "threadStatus", hint: "hintThreadStatus" },
  onboarding: { label: "threadStatus" },
  mockup: { label: "mockupStatus", hint: "hintMockupStatus" },
};

/** A state family with no label group of its own, read from the shared words under `common.state.<family>.*`. */
export const STATUS_COMMON: ReadonlySet<StatusFamily> = new Set<StatusFamily>(["pipelineRun"]);

/** One state value's reading. A value its family does not name reads sentence-cased and neutral,
 *  so a new core value shows as words, never as a raw token. */
export function statusReading(family: StatusFamily, value: string, language?: string): StatusReading {
  const m = STATUS_MAPS[family];
  const label = m.labels[value];
  if (label === undefined) return { label: sentenceCase(value), tone: "neutral", glyph: null, hint: null };
  const g = STATUS_GROUP[family];
  const hint = hintOf(m.hints?.[value]);
  return {
    label: g ? copyOr(language, labelKey(g.label, value), label) : STATUS_COMMON.has(family) ? copyOr(language, `common.state.${family}.${value}`, label) : label,
    tone: m.tones[value] ?? "neutral",
    glyph: m.glyphs?.[value] ?? null,
    hint: g?.hint && hint ? copyOr(language, labelKey(g.hint, value), hint) : hint,
  };
}

/** Non-state families: a neutral badge with an icon, never a status colour. */
export const ENUM_FAMILIES = {
  priority: ISSUE_PRIORITY_LABELS,
  category: ISSUE_CATEGORY_LABELS,
  feedbackKind: FEEDBACK_KIND_LABELS,
  feedbackRoute: FEEDBACK_ROUTE_LABELS,
  feedbackDecision: FEEDBACK_DECISION_LABELS,
  feedbackTarget: FEEDBACK_TARGET_LABELS,
  mockupKind: MOCKUP_KIND_LABELS,
  contractDirection: CONTRACT_DIRECTION_LABELS,
  step: WORK_STEP_LABELS,
  notificationType: NOTIFICATION_TYPE_LABELS,
  landingSurface: LANDING_SURFACE_LABELS,
  artifactChange: ARTIFACT_CHANGE_LABELS,
  ...ENUM_LABELS,
} as const satisfies Record<string, Record<string, string>>;

export type EnumFamily = keyof typeof ENUM_FAMILIES;

/** The locale file's label group of an enum family. */
const ENUM_GROUP: Partial<Record<EnumFamily, LabelGroup>> = {
  priority: "issuePriority",
  category: "issueCategory",
  feedbackKind: "feedbackKind",
  feedbackRoute: "feedbackRoute",
  feedbackDecision: "feedbackDecision",
  feedbackTarget: "feedbackTarget",
  step: "workStep",
  landingSurface: "landingSurface",
  artifactChange: "artifactChange",
  mockupKind: "mockupKind",
  notificationType: "notificationType",
  agentReportKind: "agentReportKind",
  agentReportTarget: "agentReportTarget",
  role: "role",
};

/** An enum family with no label group of its own, read from the shared words under `common.<family>.*`. */
export const ENUM_COMMON: Partial<Record<EnumFamily, string>> = {
  jobType: "common.jobType",
};

export function enumLabel(family: EnumFamily, value: string, language?: string): string {
  const own = (ENUM_FAMILIES[family] as Record<string, string>)[value];
  const group = ENUM_GROUP[family];
  if (own === undefined) return sentenceCase(value);
  if (group) return copyOr(language, labelKey(group, value), own);
  const common = ENUM_COMMON[family];
  return common ? copyOr(language, `${common}.${value}`, own) : own;
}

export const PRIORITY_BARS: Record<string, number> = ISSUE_PRIORITY_BARS;
