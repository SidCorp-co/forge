import { type Said, say, sayEn, verbatim } from "@forge/contracts/said";

// Fixtures say what core says: a wait, a gate or a forecast is built from registry keys, and its
// English fields are rendered from them as core renders them, so no fixture carries English a
// reader could only have re-parsed.

export { say, verbatim };
export { waitingOn } from "@forge/contracts/standing";

/** A rule no assertion reads. */
export const RULE: Said = verbatim("r");

/** A forecast wait's who, act and reason, with the English core sends beside them. */
export const forecastWait = (who: Said, act: Said, reason: Said) => ({
  who: sayEn(who),
  act: sayEn(act),
  reason: sayEn(reason),
  says: { who, act, reason },
});

/** One sentence with its English beside it, for a field core sends as both. */
export const sentence = (s: Said) => sayEn(s);

/** An integration card's detail as core sends it: its English beside what it said. */
export const cardDetail = (s: Said) => ({ detail: sayEn(s), says: { detail: s } });

/** A release gate as core sends it: title, sentence and owner in English beside what it said. */
export const gateView = <O extends { kind: string; who: Said; act: Said }, G extends { title: Said; sentence: Said; owner: O }>(g: G) => ({
  ...g,
  title: sayEn(g.title),
  sentence: sayEn(g.sentence),
  owner: { kind: g.owner.kind, who: sayEn(g.owner.who), act: sayEn(g.owner.act), says: { who: g.owner.who, act: g.owner.act } },
  says: { title: g.title, sentence: g.sentence },
});

/** An issue's blocker as core sends it: reason, who must act, the act's label and detail in English beside what it said. */
export const blockerView = <B extends { reason: Said; whoMustAct: Said; label: Said | null; kind: string; detail: Said | null }>({ reason, whoMustAct, label, kind, detail, ...rest }: B) => ({
  ...rest,
  reason: sayEn(reason),
  whoMustAct: sayEn(whoMustAct),
  act: { label: label ? sayEn(label) : "", kind },
  detail: detail ? sayEn(detail) : null,
  says: { reason, whoMustAct, act: label, detail },
});
