// What was just decided on the Approvals page, at the foot of the screen (REQ-48 BC-11): the batch
// held for five seconds with its Undo, and each decision core refused, named with what it said, so a
// refused post never reads as done.

import { Button } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { DecideState } from "../use-decide";

export function DecidedBar({ decide }: { decide: DecideState }) {
  const t = useCopy();
  const batch = decide.undoable;
  if (!batch && decide.failed.length === 0) return null;
  const first = batch?.[0];
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex flex-col items-center gap-2 px-4" aria-live="polite">
      {decide.failed.length > 0 ? (
        <div role="alert" className="pointer-events-auto flex max-w-xl items-start gap-3 rounded-md border border-danger-6 bg-surface px-4 py-2.5 text-13 text-danger-11" data-testid="approval-failed">
          <ul className="flex flex-col gap-1">
            {decide.failed.map((f) => (
              <li key={`${f.key}:${f.error}`}>{t("approvals.failed", { key: f.key, error: f.error })}</li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" onClick={decide.dismissFailed}>
            {t("approvals.dismiss")}
          </Button>
        </div>
      ) : null}
      {batch && first ? (
        <div className="pointer-events-auto flex items-center gap-4 rounded-md bg-fg px-4 py-2.5 text-13 text-surface" data-testid="approval-undo">
          <span>
            {batch.length === 1
              ? t("approvals.undo.one", { key: first.key, how: t(`approvals.how.${first.how}`) })
              : t("approvals.undo.many", { n: batch.length, how: t(`approvals.how.${batch.every((b) => b.how === first.how) ? first.how : "approved"}`) })}
          </span>
          <button type="button" className="font-semibold underline-offset-2 hover:underline" onClick={decide.undo} data-testid="approval-undo-button">
            {t("approvals.undo")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
