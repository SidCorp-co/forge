import { productCopy } from "@/lib/i18n/product-copy";
import { standingAct } from "@/lib/i18n/standing-copy";
import type { NeedsYouArea } from "./types";

/** A menu row's count, worded for its tooltip in `language`: the acts core names read through standing-copy. */
export function needsYouHint(label: string, area: NeedsYouArea, language = "en"): string {
  const t = productCopy(language);
  if (area.you === 0) return t("shell.needsHint.none", { label });
  const act = (a: string) => (a ? standingAct(a, language) : t("shell.needsHint.act"));
  const acts = area.acts.map((a) => (a.count > 1 ? t("shell.needsHint.repeated", { act: act(a.act), n: a.count }) : act(a.act)));
  return t("shell.needsHint.some", { label, n: area.you, acts: acts.join(", ") });
}
