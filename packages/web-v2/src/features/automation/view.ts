import type { StandingGroup, StandingGroupLabels } from "@forge/contracts/standing";
import type { ListGroup } from "@/design";
import { enumLabel } from "@/design/vocabulary";
import type { useTimeFormat } from "@/lib/i18n/interface-language";
import { formatDateTime } from "@/lib/i18n/format";
import { type Copy, type ProductCopyKey, productCopy } from "@/lib/i18n/product-copy";
import type { FireProduced, FireStanding } from "./types";

/** Why a fire ended where it did: its refusal, its error, or why it ran nothing. */
export function fireWhy(f: Pick<FireStanding, "refusal" | "error" | "reason">, language = "en"): string | null {
  if (f.refusal) return f.refusal;
  if (f.error) return f.error;
  return f.reason ? enumLabel("fireSkipReason", f.reason, language) : null;
}

export function fmtDuration(seconds: number | null, t: Copy = productCopy()): string {
  if (seconds == null) return "—";
  if (seconds < 60) return t("common.age.seconds", { n: seconds });
  return t("common.elapsed.minutes", { m: Math.floor(seconds / 60), s: String(seconds % 60).padStart(2, "0") });
}

const PRODUCED: Array<keyof Omit<FireProduced, "newReports">> = ["reports", "proposals", "issues", "runs", "notifications"];

export function producedLine(p: FireProduced, t: Copy = productCopy()): string {
  const parts = PRODUCED.filter((k) => p[k] > 0).map((k) => t(`schedules.produced.${k}.${p[k] === 1 ? "one" : "many"}` as ProductCopyKey, { n: p[k] }));
  if (parts.length === 0) return t("schedules.produced.nothing");
  return p.newReports > 0 ? `${parts.join(" · ")} · ${t("schedules.produced.new", { n: p.newReports })}` : parts.join(" · ");
}

export const shortId = (id: string) => id.slice(0, 8);

export function fmtTime(iso: string | null, language = "en"): string {
  if (!iso) return "—";
  if (Number.isNaN(new Date(iso).getTime())) return "—";
  return formatDateTime(iso, language);
}

/** The reader's copy, language and time formats, for the pure builders of a list row. */
export interface RowCtx {
  t: Copy;
  language: string;
  time: ReturnType<typeof useTimeFormat>;
}

export type AutomationGroupFamily = "schedule" | "fire" | "report";

/** A tab's groups in the order the contract declares them, the labels and hints read in the reader's language. */
export function automationGroups<R extends { attentionGroup: G }, G extends StandingGroup>(
  rows: readonly R[],
  order: readonly G[],
  labels: StandingGroupLabels<G>,
  family: AutomationGroupFamily,
  t: Copy,
): ListGroup<R>[] {
  return order.map((g) => ({
    id: g,
    label: t(`schedules.group.${family}.${g}.label` as ProductCopyKey),
    hint: labels[g].hint ? t(`schedules.group.${family}.${g}.hint` as ProductCopyKey) : "",
    tone: labels[g].tone,
    collapsed: labels[g].collapsed,
    rows: rows.filter((r) => r.attentionGroup === g),
  }));
}
