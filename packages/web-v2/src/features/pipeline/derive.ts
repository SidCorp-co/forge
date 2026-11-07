import type { StageKey } from "@/design/stages";
import { gateReasonLine } from "@/features/runners";
import { formatElapsed as formatElapsedIn } from "@/lib/i18n/format";
import { productCopy } from "@/lib/i18n/product-copy";
import type { RunGate } from "./types";

export function jobTypeToStage(jobType: string | null | undefined): StageKey | null {
  switch (jobType) {
    case "triage":
    case "clarify":
    case "plan":
    case "code":
    case "review":
    case "test":
    case "release":
      return jobType;
    case "fix":
      return "code";
    default:
      return null;
  }
}

/** ISS-1192 — what a reviewer opening a run session is told about the box's
 *  gate. `none` and `clear` are different facts and never share a picture. */
export interface RunGateNote {
  verdict: "none" | "clear" | "marked" | "failing_open" | "unreadable";
  headline: string;
  detail: string;
  reason: string | null;
}

/** The run could not be fetched: the condition is unknown, which is not "none". */
export function runGateUnfetched(message: string, language = "en"): RunGateNote {
  return {
    verdict: "unreadable",
    headline: productCopy(language)("sessions.gate.unfetched"),
    detail: message,
    reason: null,
  };
}

/** `undefined` is a response that did not carry the field, and says nothing. */
export function runGateNote(gate: RunGate | null | undefined, language = "en"): RunGateNote | null {
  if (gate === undefined) return null;
  const t = productCopy(language);
  if (gate === null) {
    return { verdict: "none", headline: t("sessions.gate.unreportedHead"), detail: t("sessions.gate.unreportedDetail"), reason: null };
  }
  if (gate.read === "unreadable") {
    return { verdict: "unreadable", headline: t("sessions.gate.unreadHead"), detail: t("sessions.gate.unreadDetail", { reason: gate.reason }), reason: null };
  }
  const c = gate.condition;
  if (c.verdict === "clear") {
    return { verdict: "clear", headline: t("sessions.gate.clearHead"), detail: t("sessions.gate.clearDetail"), reason: null };
  }
  const rate = c.perDay === null ? t("runners.gate.rateUnstated") : t("runners.gate.perDay", { n: Math.round(c.perDay) });
  const window = c.windowMs === null ? t("runners.span.unknown") : formatElapsedIn(c.windowMs, language);
  return {
    verdict: c.verdict,
    headline: c.verdict === "failing_open" ? t("sessions.gate.failingHead") : t("sessions.gate.markedHead"),
    detail: t("sessions.gate.detail", { count: c.count, rate, window }),
    reason: gateReasonLine(c.byReason, c.count, language),
  };
}

