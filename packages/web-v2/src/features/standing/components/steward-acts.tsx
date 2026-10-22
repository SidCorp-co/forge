// The steward's acts on one item, in the item's Activity (REQ-48 BC-12): a flat row per act, newest
// first, saying what it did and when. A project writer undoes an act through the inverse door its
// record names; an act no door undoes says how to override it instead, and an undone act says so.

import type { StewardActRecord } from "@forge/contracts/steward";
import { Button, Disclosure, WhoMark } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useStewardActs, useUndoStewardAct } from "../hooks";

function StewardAct({ act, canWrite, onUndo, pending, fault }: { act: StewardActRecord; canWrite: boolean; onUndo: () => void; pending: boolean; fault: string | null }) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <li className="flex gap-2.5 border-b border-line-subtle py-2.5 text-14 last:border-0" data-testid="steward-act" data-act-id={act.id}>
      <span className="w-5 flex-none pt-px">
        <WhoMark kind="agent" who={t("steward.acts.who")} size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-12 text-subtle">
          <b className="text-13 font-semibold text-fg">{t("steward.acts.who")}</b>
          <span title={time.dateTime(act.at)}>{time.relative(act.at)}</span>
        </div>
        <p className="mt-0.5 break-words">{act.did}</p>
        {act.undoneAt ? (
          <p className="fg-caption text-subtle" data-testid="steward-act-undone">
            {t("steward.acts.undone")}
          </p>
        ) : act.undo === null && act.override ? (
          <p className="fg-caption text-muted" data-testid="steward-act-override">
            {t("steward.acts.override", { how: act.override })}
          </p>
        ) : null}
        {fault ? (
          <p className="fg-caption text-danger" role="alert">
            {fault}
          </p>
        ) : null}
      </div>
      {canWrite && act.undo && !act.undoneAt ? (
        <span className="flex-none">
          <Button variant="ghost" size="sm" loading={pending} onClick={onUndo} data-testid="steward-act-undo">
            {t("steward.acts.undo")}
          </Button>
        </span>
      ) : null}
    </li>
  );
}

/**
 * Every act the steward took on the item `subjectKey` names (REQ-n, FB-n, ISS-n); nothing where it
 * took none. `canWrite` is the page's own project-write check: Undo is offered only to a writer.
 * `fold` draws it as one of the page's folds, with its count, where the Activity is folds.
 */
export function StewardActs({ projectId, subjectKey, canWrite, fold = false }: { projectId: string; subjectKey: string; canWrite: boolean; fold?: boolean }) {
  const t = useCopy();
  const { acts, isError } = useStewardActs(projectId, subjectKey);
  const undo = useUndoStewardAct(projectId, subjectKey);
  if (isError) return <p className="py-1.5 text-13 text-subtle">{t("steward.acts.loadFailed")}</p>;
  if (acts.length === 0) return null;
  const failedOn = undo.isError ? undo.variables : null;
  const list = (
    <ul>
      {acts.map((act) => (
        <StewardAct
          key={act.id}
          act={act}
          canWrite={canWrite}
          onUndo={() => undo.mutate(act.id)}
          pending={undo.isPending && undo.variables === act.id}
          fault={failedOn === act.id ? formatApiError(undo.error) : null}
        />
      ))}
    </ul>
  );
  if (fold) {
    return (
      <Disclosure title={t("steward.acts.title")} count={acts.length} testId="steward-acts">
        {list}
      </Disclosure>
    );
  }
  return (
    <section aria-label={t("steward.acts.title")} data-testid="steward-acts">
      <h3 className="fg-caption text-subtle">{t("steward.acts.title")}</h3>
      {list}
    </section>
  );
}
