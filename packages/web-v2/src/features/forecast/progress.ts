import type { IssueProgress } from "@forge/contracts/forecast";
import type { Copy } from "@/lib/i18n/product-copy";

// The one progress line (JU-2): core's count of shipped, landed awaiting release and to do, in the
// same words on the requirements list, its rail, Releases and the forecast line. Every surface
// prints all three, so "done" never stands for one of them.

export function progressText(p: IssueProgress, t: Copy): string {
  return [
    t("progress.shipped", { n: p.shipped }),
    t("progress.awaitingRelease", { n: p.awaitingRelease }),
    t("progress.toDo", { n: p.toDo }),
  ].join(" · ");
}
