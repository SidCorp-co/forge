// A park's re-point notice in a person's words (ISS-680, FB-281). Core posts it to the thread as
// agent text (`issues/park-repoint.ts:REPOINT_HEADING`): a heading naming the `needs_info` status,
// a sentence naming the old and new waiting-kind codes, then the reason the run gave. A person reads
// what the park waits on now, as a label, and the reason; the codes stay in the Developer view.

import { NEEDS_INFO_KINDS, type NeedsInfoKind } from "@forge/contracts/issue-vocabulary";
import type { Copy } from "@/lib/i18n/product-copy";

const HEADING = /^↪ \*\*Re-pointed `needs_info`\*\*\s*\n/;
const REKIND = /now a `([a-z_]+)` park/;
const REPOINT = /now waits on (.+?), in place of /;

/** A waiting kind's label; a kind this build does not know reads as one generic word, never its code. */
export function waitingKindLabel(t: Copy, kind: string): string {
  const known = NEEDS_INFO_KINDS.find((k): k is NeedsInfoKind => k === kind);
  return known ? t(`issues.waitingKind.${known}`) : t("issues.waitingKind.unknown");
}

/** The notice as a person reads it, or null where `body` is no re-point notice. */
export function personNotice(body: string, t: Copy): string | null {
  if (!HEADING.test(body)) return null;
  const [said = "", ...rest] = body.replace(HEADING, "").trim().split(/\n\s*\n/);
  const kind = REKIND.exec(said)?.[1];
  const now = kind ? waitingKindLabel(t, kind) : (REPOINT.exec(said)?.[1] ?? null);
  const head = `**${t("issues.thread.waitChanged")}**${now ? ` · ${t("issues.thread.nowWaitsOn", { what: now })}` : ""}`;
  return [head, ...rest].join("\n\n");
}
