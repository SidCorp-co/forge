import { renderSaid, type Said, type SaidKind, SAID_ENTRIES } from "@forge/contracts/said";
import type { WaitingSays } from "@forge/contracts/standing";
import { labelCopy } from "./labels";
import { baseOf, copyOr, productCopyTemplate } from "./product-copy";

// What core says, in the reader's words: core sends each standing sentence as a registry key and
// typed values (`@forge/contracts/said`) beside its English, and this reads the key through the
// product copy of the reader's language. Nothing here reads core's English; a key this build does
// not know is a visible marker in development and test, never the English it came with.

/** An ISO calendar date as the language writes it: `05/10/2026` in vi, as sent in en. */
const dateIn = (iso: string, language: string): string => {
  const [y, m, d] = iso.split("-");
  return baseOf(language) === "vi" && y && m && d ? `${d}/${m}/${y}` : iso;
};

function valueIn(language: string) {
  const label = labelCopy(language);
  return (kind: SaidKind, value: string | number): string => {
    const v = String(value);
    switch (kind) {
      case "date":
        return dateIn(v, language);
      case "status":
      case "statusLabel":
        return label("issueStatus", v);
      case "step":
        return label("workStep", v.toLowerCase());
      case "health":
        return copyOr(language, `common.state.connection.${v}`, v);
      default:
        return v;
    }
  };
}

/** What a key this build does not know reads as: a marker naming it, so the gap is seen and filed rather than read past. */
export const unknownSaid = (key: string): string => `⟦${key}⟧`;

const ENGLISH_VALUE = (kind: SaidKind, value: string | number): string => {
  const v = String(value);
  if (kind === "step") return v.charAt(0).toUpperCase() + v.slice(1);
  if (kind === "statusLabel") return labelCopy("en")("issueStatus", v);
  return v;
};

/** `s` in `language`. English reads the registry's own template, so it is the sentence core sent. */
export function said(s: Said | null | undefined, language: string): string {
  if (!s) return "";
  const en = baseOf(language) === "en";
  const value = en ? ENGLISH_VALUE : valueIn(language);
  return renderSaid(s, {
    template: (key) => (en ? SAID_ENTRIES[key]?.en : productCopyTemplate(language, key)),
    value,
    unknown: unknownSaid,
  });
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
export function saidView<W extends { who: string; act: string; rule?: string | null | undefined; effect?: string | undefined; says?: WaitingSays }>(
  w: W,
  language: string,
): Omit<W, "says"> {
  const { says, ...rest } = w;
  if (!says) return rest;
  const effect = says.effect ? { effect: said(says.effect, language) } : {};
  return { ...rest, who: said(says.who, language), act: said(says.act, language), rule: said(says.rule, language), ...effect };
}
