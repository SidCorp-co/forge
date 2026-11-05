
import { useRef, useState } from "react";
import { Button, Checkbox, Field, Popover, Textarea } from "@/design";
import { ApiError } from "@/lib/api/client";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { saidView } from "@/lib/i18n/said";
import type { ProductCopyKey as CopyKey } from "@/lib/i18n/product-copy";
import { useCutRelease, useDraftDecision, useReleaseDecision } from "../hooks";
import type { ReleaseDecisionBody, ReleaseDetail } from "../types";
import { RefusalText } from "./release-bits";

type Decided = "approve" | "return";

const DECIDE_WITH_REASON: Record<Decided, { opens: CopyKey; why: CopyKey; placeholder: CopyKey | null; submit: CopyKey; testid: string; primary: boolean }> = {
  approve: { opens: "releases.approve", why: "releases.whyShip", placeholder: null, submit: "releases.approve", testid: "release-approve", primary: true },
  return: { opens: "releases.returnWithReason", why: "releases.whyBack", placeholder: "releases.whyBackPlaceholder", submit: "releases.returnWithReason", testid: "release-return", primary: false },
};

/** What a decision is taken on: a run's pending request, or a draft by its version (ISS-869). */
type Target = { runId: string; approvalId: string } | { version: string };

/**
 * A draft is decided only where its master records it rather than cutting it (`can.decide`, from
 * core's `draftDecisionRefusal`): its approval agrees to that record, and says so (ISS-1019).
 */
const APPROVE_RECORD: (typeof DECIDE_WITH_REASON)[Decided] = {
  ...DECIDE_WITH_REASON.approve,
  opens: "releases.approveRecord",
  why: "releases.whyRecord",
  submit: "releases.approveRecord",
};

const wordingOf = (target: Target, decision: Decided) =>
  "version" in target && decision === "approve" ? APPROVE_RECORD : DECIDE_WITH_REASON[decision];

function useDecide(projectId: string, target: Target) {
  const onRun = useReleaseDecision(projectId);
  const onDraft = useDraftDecision(projectId);
  if ("version" in target) {
    const { version } = target;
    return { ...onDraft, send: (body: ReleaseDecisionBody, done: () => void) => onDraft.mutate({ version, body }, { onSuccess: done }) };
  }
  const { runId, approvalId } = target;
  return { ...onRun, send: (body: ReleaseDecisionBody, done: () => void) => onRun.mutate({ runId, approvalId, body }, { onSuccess: done }) };
}

/**
 * Whether an approval was refused on its unproven criteria alone: then the approver may carry them
 * all by their word (ISS-914), and nothing else stands in the way.
 */
export function refusedOnlyOnUnproven(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.code !== "CHECKLIST_INCOMPLETE") return false;
  const refusals = (error.body as { error?: { refusals?: { path?: unknown }[] } } | undefined)?.error?.refusals;
  return Array.isArray(refusals) && refusals.length > 0 && refusals.every((r) => r.path === "/answers/verdicts");
}

// both decisions carry a reason: a return says what the master answers, an approval why it may ship (Requirement lifecycle r15 release_check)
function DecideWithReason({ projectId, target, decision }: { projectId: string; target: Target; decision: Decided }) {
  const t = useCopy();
  const decide = useDecide(projectId, target);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [carry, setCarry] = useState(false);
  const [carryWhy, setCarryWhy] = useState("");
  const c = wordingOf(target, decision);
  const mayCarry = decision === "approve" && (carry || refusedOnlyOnUnproven(decide.error));
  const carrying = mayCarry && carry;
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
            const body: ReleaseDecisionBody = carrying
              ? { decision, reason: reason.trim(), carry: { all: true, why: carryWhy.trim() } }
              : { decision, reason: reason.trim() };
            decide.send(body, () => {
              setOpen(false);
              setReason("");
              setCarry(false);
              setCarryWhy("");
            });
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
          {mayCarry ? (
            <span className="grid gap-2" data-testid="release-carry">
              <Checkbox checked={carry} onChange={setCarry} label={t("releases.carryAll")} />
              {carry ? (
                <Field label={t("releases.carryWhy")}>
                  <Textarea value={carryWhy} onChange={(e) => setCarryWhy(e.target.value)} rows={2} data-testid="release-carry-why" />
                </Field>
              ) : null}
            </span>
          ) : null}
          <span className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={!reason.trim() || (carrying && !carryWhy.trim())} loading={decide.isPending} data-testid={`${c.testid}-submit`}>
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
  const language = useInterfaceLanguage();
  const cut = useCutRelease(projectId);
  const decision: Target | null = !r.can.decide
    ? null
    : r.state === "draft"
      ? { version: r.version }
      : r.approval && r.runId
        ? { runId: r.runId, approvalId: r.approval.id }
        : null;
  // the act RELEASE_ROSTER_OVERSIZE names: core chose the oldest merged issues one release carries
  const split = r.can.split && r.split ? r.split : null;
  if (!decision && !r.can.cut && !split) return null;
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid="release-actions">
      {decision ? (
        <>
          <DecideWithReason projectId={projectId} target={decision} decision="return" />
          <DecideWithReason projectId={projectId} target={decision} decision="approve" />
        </>
      ) : split ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="primary"
            loading={cut.isPending}
            onClick={() => cut.mutate(split.issueIds)}
            // what splitting does, where the page no longer carries a banner to say it (ISS-1001)
            title={saidView(r.waitingOn, language).effect ?? undefined}
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
