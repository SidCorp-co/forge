"use client";

import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import type { PipelineReading, WaitingReason } from "./types";

/**
 * Core writes a queued step's gate reading in English, one fixed reading per reason
 * (`issues/pipeline-health-reasons.ts` GATE_READINGS, and the two held readings told apart by whether
 * the hold clears itself). The interface language reads it by its reason; a reason this build does not
 * know is shown as core wrote it.
 */
const KNOWN: ReadonlySet<WaitingReason> = new Set<WaitingReason>([
  "issue_busy",
  "run_not_running",
  "runner_stale",
  "retry_cooldown",
  "runner_too_old",
  "job_held",
]);

const keyOf = (reason: WaitingReason, needsAction: boolean): string =>
  reason === "job_held" ? (needsAction ? "job_held_stays" : "job_held_clears") : reason;

/** The gate's short label, detail and next step in the interface language, or null for no gate. */
export function useGateReading<G extends PipelineReading & { reason: WaitingReason }>(gate: G | null | undefined): G | null {
  const t = useCopy();
  if (!gate) return null;
  if (!KNOWN.has(gate.reason)) return gate;
  const k = keyOf(gate.reason, gate.needsAction);
  const read = (part: "short" | "detail" | "who") => t(`issues.gate.${k}.${part}` as ProductCopyKey);
  return { ...gate, short: read("short"), detail: read("detail"), who: read("who") };
}
