import { renderSaid, type Said, type SaidKind, SAID_ENTRIES } from "@forge/contracts/said";
import type { WaitingSays } from "@forge/contracts/standing";
import { labelCopy } from "./labels";
import { englishOnly } from "./product-copy";

// What core says, in the reader's words: core sends each standing sentence as a registry key and
// typed values (`@forge/contracts/said`) beside its English, and this reads the key's English from the
// registry, the sentence core sent. Forge is English only (owner, 2026-10-08, ISS-1071), so a
// language other than English is refused by name (`englishOnly`); a key this build does not know is a
// visible marker in development and test, never the English it came with.

/** What a key this build does not know reads as: a marker naming it, so the gap is seen and filed rather than read past. */
export const unknownSaid = (key: string): string => `⟦${key}⟧`;

const ENGLISH_VALUE = (kind: SaidKind, value: string | number): string => {
  const v = String(value);
  if (kind === "step") return v.charAt(0).toUpperCase() + v.slice(1);
  if (kind === "statusLabel") return labelCopy("en")("issueStatus", v);
  if (kind === "role") return labelCopy("en")("permissionRole", v);
  return v;
};

/** `s` in `language`, which is English: the registry's own template, so it is the sentence core sent. */
export function said(s: Said | null | undefined, language: string): string {
  englishOnly(language);
  if (!s) return "";
  return renderSaid(s, { template: (key) => SAID_ENTRIES[key]?.en, value: ENGLISH_VALUE, unknown: unknownSaid });
}

/** `s` in `language`, or null where core said nothing. */
export const saidOrNull = (s: Said | null | undefined, language: string): string | null => (s ? said(s, language) : null);

/** Whether `s`, or the first of the acts it joins, says `key`: how a screen tells which act a wait owes without reading its words. */
export function saysKey(s: Said | null | undefined, key: Said["key"]): boolean {
  if (!s) return false;
  if (s.key === key) return true;
  const acts = s.vars?.acts;
  return Array.isArray(acts) && (acts[0] as Said | undefined)?.key === key;
}

/** A wait in `language`: its `who`, `act`, `rule` and `effect` read from what core said, and `says` dropped, so what is left is words to draw. A view with no `says` is already in the reader's words. */
export function saidView<W extends { who: string; act: string; rule?: string | null | undefined; effect?: string | undefined; says?: SaidWait }>(
  w: W,
  language: string,
): Omit<W, "says"> {
  const { says, ...rest } = w;
  if (!says) return rest;
  const rule = says.rule ? { rule: said(says.rule, language) } : {};
  const effect = says.effect ? { effect: said(says.effect, language) } : {};
  return { ...rest, who: said(says.who, language), act: said(says.act, language), ...rule, ...effect };
}

/** What a wait said: who and what always, why and to what effect where it says so. */
export type SaidWait = Pick<WaitingSays, "who" | "act"> & Partial<Pick<WaitingSays, "rule" | "effect">>;
