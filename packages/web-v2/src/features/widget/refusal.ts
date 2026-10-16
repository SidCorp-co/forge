import type { WidgetRefusalCode } from "@forge/contracts/widget";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { WidgetRefusal, WidgetUnreachable } from "./api";

/**
 * A refusal as the visitor is shown it: a widget code by its own plain sentence, a code core sent
 * that is not the widget's by the general one with the code beside it, and an unreachable core as
 * the network.
 */
export interface Shown {
  code: WidgetRefusalCode | "network" | "other";
  /** The code core named, shown small so a visitor can quote it; null where none was named. */
  rawCode: string | null;
  /** Core's own sentence for a limit, shown under the plain one. */
  detail: string | null;
}

export function shownOf(err: unknown): Shown {
  if (err instanceof WidgetRefusal)
    return { code: err.code ?? "other", rawCode: err.rawCode, detail: err.code === "WIDGET_LIMIT_REACHED" ? err.message : null };
  if (err instanceof WidgetUnreachable) return { code: "network", rawCode: null, detail: null };
  return { code: "other", rawCode: null, detail: null };
}

export function refusalKey(code: Shown["code"]): ProductCopyKey {
  return `widget.refused.${code}`;
}
