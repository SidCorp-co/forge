
import { useRef, useState } from "react";
import { Button, Field, Popover, Textarea } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey as CopyKey } from "@/lib/i18n/product-copy";
import { useCutRelease, useReleaseDecision } from "../hooks";
import type { ReleaseDetail } from "../types";
import { RefusalText } from "./release-bits";

type Decided = "approve" | "return";

const DECIDE_WITH_REASON: Record<Decided, { opens: CopyKey; why: CopyKey; placeholder: CopyKey | null; submit: CopyKey; testid: string; primary: boolean }> = {
  approve: { opens: "releases.approve", why: "releases.whyShip", placeholder: null, submit: "releases.approve", testid: "release-approve", primary: true },
  return: { opens: "releases.returnWithReason", why: "releases.whyBack", placeholder: "releases.whyBackPlaceholder", submit: "releases.returnWithReason", testid: "release-return", primary: false },
};

// both decisions carry a reason: a return says what the master answers, an approval why it may ship (Requirement lifecycle r15 release_check)
function DecideWithReason({ projectId, runId, approvalId, decision }: { projectId: string; runId: string; approvalId: string; decision: Decided }) {
  const t = useCopy();
  const decide = useReleaseDecision(projectId);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const c = DECIDE_WITH_REASON[decision];
  return (
    <>
      <span ref={anchorRef} className="inline-flex">
        <Button type="button" size="sm" variant={c.primary ? "primary" : undefined} aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid={c.testid}>
          {t(c.opens)}
        </Button>
      </span>
      <Popover open={open} anchor={anchorRef} onDismiss={() => setOpen(false)} placement="bottom-end" takesFocus className="w-80 bg-surface p-3 ">
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            decide.mutate(
              { runId, approvalId, body: { decision, reason: reason.trim() } },
              {
                onSuccess: () => {
                  setOpen(false);
                  setReason("");
                },
              },
            );
          }}
        >
          <Field label={t(c.why)}>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder={c.placeholder ? t(c.placeholder) : undefined}
              data-testid={`${c.testid}-reason`}
            />
          </Field>
          <RefusalText error={decide.error} />
          <span className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={!reason.trim()} loading={decide.isPending} data-testid={`${c.testid}-submit`}>
              {t(c.submit)}
            </Button>
          </span>
        </form>
      </Popover>
    </>
  );
}

export function ReleaseActions({ projectId, r }: { projectId: string; r: ReleaseDetail }) {
  const t = useCopy();
  const cut = useCutRelease(projectId);
  const decision = r.can.decide && r.approval && r.runId ? { runId: r.runId, approvalId: r.approval.id } : null;
  // the act RELEASE_ROSTER_OVERSIZE names: core chose the oldest merged issues one release carries
  const split = r.can.split && r.split ? r.split : null;
  if (!decision && !r.can.cut && !split) return null;
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid="release-actions">
      {decision ? (
        <>
          <DecideWithReason projectId={projectId} {...decision} decision="return" />
          <DecideWithReason projectId={projectId} {...decision} decision="approve" />
        </>
      ) : split ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="primary"
            loading={cut.isPending}
            onClick={() => cut.mutate(split.issueIds)}
            data-testid="release-split"
          >
            {t("releases.split", { n: split.issueIds.length, version: r.version })}
          </Button>
          <RefusalText error={cut.error} />
        </>
      ) : (
        <>
          <Button
            type="button"
            size="sm"
            variant="primary"
            loading={cut.isPending}
            onClick={() => cut.mutate(r.issues.map((i) => i.id))}
            data-testid="release-cut"
          >
            {t("releases.cut", { version: r.version })}
          </Button>
          <RefusalText error={cut.error} />
        </>
      )}
    </span>
  );
}
