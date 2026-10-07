"use client";

// The acts a requirement offers where it stands — review a proposal, propose a draft, agree the
// head, accept a delivery, defer or drop it — and the BA assistant door (ISS-58) that "Propose change" and the top
// bar's Ask Agent open. The peek and the full page's header draw the same one primary act from the
// same rules; "Propose change" sits with the revisions, Accept / Reject beside the diff. Every sign-off
// (accept, agree, re-pin, accept a delivery) opens a confirm step taking the signer's reason (ISS-281).

import Link from "next/link";
import { useCallback, useState } from "react";
import { AcceptStep, Button, Input, showToast, Tooltip } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { type DockDoor, useChatDock } from "@/features/chat-dock/dock";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useLabel } from "@/lib/i18n/interface-language";
import { standingEffect } from "@/lib/i18n/standing-copy";
import { draftIssuesToPromote } from "@forge/contracts/requirements";
import { requirementsApi } from "../api";
import { useRequirementAction } from "../hooks";
import { requirementHref } from "@/lib/routes/requirements";
import type { RequirementAction, RequirementDetail } from "../types";
import { PromoteDrafts } from "./promote-drafts";

/** Opens the viewer's BA assistant room about this requirement; a refusal is a toast and no room. */
export function useAssistantDoor(projectId: string, reqKey: string): DockDoor {
  const t = useCopy();
  return useCallback(async () => {
    try {
      const r = await requirementsApi.openAssistant(projectId, reqKey);
      return { kind: "room", projectId, conversationId: r.conversation.id };
    } catch (err) {
      showToast({ title: t("requirements.act.assistantFailed", { key: reqKey }), description: formatApiError(err), tone: "error" });
      return null;
    }
  }, [projectId, reqKey, t]);
}

export function ProposeChange({ projectId, reqKey }: { projectId: string; reqKey: string }) {
  const t = useCopy();
  const dock = useChatDock();
  const door = useAssistantDoor(projectId, reqKey);
  const [busy, setBusy] = useState(false);
  if (!dock) return null;
  return (
    <Tooltip label={t("requirements.act.proposeChangeTip")} multiline>
      <Button
        type="button"
        size="sm"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          const target = await door();
          setBusy(false);
          if (target) dock.show(target);
        }}
      >
        {t("requirements.act.proposeChange")}
      </Button>
    </Tooltip>
  );
}

export function PrimaryActions({
  projectId,
  slug,
  d,
  inPeek,
  onReview,
}: {
  projectId: string;
  slug: string;
  d: RequirementDetail;
  inPeek?: boolean;
  /** On the full page, "Review proposal" opens the revisions view; in the peek it opens the full page there. */
  onReview?: () => void;
}) {
  const t = useCopy();
  const label = useLabel();
  const lang = useInterfaceLanguage();
  // core's raw state names stay as written in English, as they always read there; another language reads their label
  const statusWord = (st: string) => (lang === "en" ? st : label("requirementState", st).toLowerCase());
  const designWord = (st: string) => (lang === "en" ? st : label("designStatus", st).toLowerCase());
  const act = useRequirementAction(projectId, d.key);
  const proposed = d.revisions.find((r) => r.state === "proposed");
  const draft = d.revisions.find((r) => r.state === "draft");
  const head = d.revisions.find((r) => r.state === "current");
  const s = d.standing;
  const busy = act.isPending;
  let primary: React.ReactNode = null;
  if (d.status === "deferred") {
    primary = d.canSignOff ? (
      <UndeferAct
        projectId={projectId}
        reqKey={d.key}
        tip={t("requirements.act.undeferTip", { reason: d.deferral?.reason ?? "", from: d.deferral?.from ? statusWord(d.deferral.from) : t("requirements.act.itsStatus") })}
      />
    ) : null;
  } else if (proposed) {
    primary = inPeek ? (
      <Link
        href={`${requirementHref(slug, d.key)}?tab=revisions`}
        onClick={onReview}
        className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-13 font-semibold text-on-accent hover:bg-accent-hover"
      >
        {t("requirements.act.reviewProposal", { r: proposed.revision })}
      </Link>
    ) : (
      <Button type="button" size="sm" variant="primary" onClick={onReview}>
        {t("requirements.act.reviewProposal", { r: proposed.revision })}
      </Button>
    );
  } else if (draft && s.waitingOn.kind === "you") {
    primary = (
      <Button type="button" size="sm" variant="primary" loading={busy} onClick={() => act.mutate({ kind: "propose", revision: draft.revision })}>
        {t("requirements.act.proposeR", { r: draft.revision })}
      </Button>
    );
  } else if (d.canSignOff && d.status === "agreed" && head && s.facts.stalePins.length + s.facts.staleContractPins.length > 0) {
    const notYet = t("requirements.act.notFollowedYet");
    const moved = [
      ...s.facts.stalePins.map((p) => t("requirements.act.pinMovedDesign", { title: p.title, approved: p.approved, was: p.pinned === null ? notYet : t("requirements.act.pinWas", { r: p.pinned }) })),
      ...s.facts.staleContractPins.map((p) => t("requirements.act.pinMovedContract", { contract: p.contract, current: p.current, was: p.pinned === null ? notYet : t("requirements.act.pinWasVersion", { v: p.pinned }) })),
    ].join(", ");
    primary = (
      <SignOff
        projectId={projectId}
        reqKey={d.key}
        label={t("requirements.act.repin")}
        tip={s.waitingOn.effect ? standingEffect(s.waitingOn.effect, lang) : t("requirements.act.repinTip", { moved })}
        consequence={t("requirements.act.repinConsequence", { moved })}
        act={(reason) => ({ kind: "repin", revision: head.revision, reason })}
      />
    );
  } else if (d.canSignOff && d.status === "draft" && head && !draft && s.facts.unapprovedDesigns.length > 0) {
    const designs = s.facts.unapprovedDesigns.map((x) => `${x.title} (${x.designStatus ? designWord(x.designStatus) : t("requirements.act.noDesignYet")})`).join(", ");
    primary = (
      <Tooltip label={t("requirements.act.agreeHeldTip", { designs })} multiline>
        <Button type="button" size="sm" variant="primary" disabled data-testid="agree-held">
          {t("requirements.act.agreeR", { r: head.revision })}
        </Button>
      </Tooltip>
    );
  } else if (d.canSignOff && d.status === "draft" && head && !draft) {
    primary = (
      <SignOff
        projectId={projectId}
        reqKey={d.key}
        label={t("requirements.act.agreeR", { r: head.revision })}
        consequence={t("requirements.act.agreeConsequence", { r: head.revision })}
        act={(reason) => ({ kind: "agree", revision: head.revision, reason })}
      />
    );
  } else if (s.state === "delivered" && d.canSignOff && head) {
    primary = (
      <SignOff
        projectId={projectId}
        reqKey={d.key}
        label={t("requirements.act.acceptDeliveryR", { r: head.revision })}
        tip={t("requirements.act.acceptDeliveryTip", { r: head.revision })}
        consequence={t("requirements.act.acceptDeliveryConsequence", { r: head.revision })}
        act={(reason) => ({ kind: "accept-delivery", revision: head.revision, reason })}
      />
    );
  } else if (d.canSignOff && draftIssuesToPromote(d.status, d.issues).length > 0) {
    primary = <PromoteDrafts projectId={projectId} d={d} />;
  }
  const deferrable = d.canSignOff && (d.status === "draft" || d.status === "agreed");
  const droppable = d.canSignOff && (d.status === "draft" || d.status === "agreed" || d.status === "deferred");
  if (!primary && !deferrable && !droppable) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {primary}
      {deferrable ? <DeferAct projectId={projectId} reqKey={d.key} /> : null}
      {droppable ? <DropAct projectId={projectId} reqKey={d.key} /> : null}
      <RefusalLine error={act.error} />
    </div>
  );
}

/** A signer's sign-off: the button opens the confirm step, which sends the act with the reason typed. */
function SignOff({
  projectId,
  reqKey,
  label,
  tip,
  consequence,
  act: build,
}: {
  projectId: string;
  reqKey: string;
  label: string;
  tip?: string;
  consequence: string;
  act: (reason: string | undefined) => RequirementAction;
}) {
  const act = useRequirementAction(projectId, reqKey);
  const [open, setOpen] = useState(false);
  const button = (
    <Button type="button" size="sm" variant="primary" disabled={act.isPending} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      {label}
    </Button>
  );
  return (
    <>
      {tip ? (
        <Tooltip label={tip} multiline>
          {button}
        </Tooltip>
      ) : (
        button
      )}
      {open ? (
        <div className="basis-full">
          <AcceptStep
            confirmLabel={label}
            consequence={consequence}
            loading={act.isPending}
            onCancel={() => setOpen(false)}
            onConfirm={(reason) => act.mutate(build(reason), { onSuccess: () => setOpen(false) })}
          />
        </div>
      ) : null}
      <RefusalLine error={act.error} />
    </>
  );
}

/** Drops a requirement that is not going to be built, saying why; core refuses it while a live issue links to it. */
function DropAct({ projectId, reqKey }: { projectId: string; reqKey: string }) {
  const t = useCopy();
  const act = useRequirementAction(projectId, reqKey);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) {
    return (
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t("requirements.act.drop")}
      </Button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        act.mutate({ kind: "drop", reason: reason.trim() }, { onSuccess: () => setOpen(false) });
      }}
    >
      <Input aria-label={t("requirements.act.dropWhyLabel")} placeholder={t("requirements.act.dropWhy")} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      <Button type="submit" size="sm" variant="danger" disabled={!reason.trim()} loading={act.isPending}>
        {t("requirements.act.drop")}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        {t("common.cancel")}
      </Button>
      <RefusalLine error={act.error} />
    </form>
  );
}

/** Takes the requirement out of the current release, saying why and, optionally, where it is meant to go. */
function DeferAct({ projectId, reqKey }: { projectId: string; reqKey: string }) {
  const t = useCopy();
  const act = useRequirementAction(projectId, reqKey);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [targetPhase, setTargetPhase] = useState("");
  if (!open) {
    return (
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t("requirements.act.defer")}
      </Button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        act.mutate({ kind: "defer", reason: reason.trim(), targetPhase: targetPhase.trim() || undefined }, { onSuccess: () => setOpen(false) });
      }}
    >
      <Input aria-label={t("requirements.act.deferWhyLabel")} placeholder={t("requirements.act.deferWhy")} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      <Input aria-label={t("requirements.act.meantForLabel")} placeholder={t("requirements.act.meantFor")} value={targetPhase} onChange={(e) => setTargetPhase(e.target.value)} />
      <Button type="submit" size="sm" disabled={!reason.trim()} loading={act.isPending}>
        {t("requirements.act.defer")}
      </Button>
      <RefusalLine error={act.error} />
    </form>
  );
}

/** Puts a deferred requirement back at the status it left, saying why it comes back, as its defer said why it left. */
function UndeferAct({ projectId, reqKey, tip }: { projectId: string; reqKey: string; tip: string }) {
  const t = useCopy();
  const act = useRequirementAction(projectId, reqKey);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) {
    return (
      <Tooltip label={tip} multiline>
        <Button type="button" size="sm" variant="primary" onClick={() => setOpen(true)}>
          {t("requirements.act.undefer")}
        </Button>
      </Tooltip>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        act.mutate({ kind: "undefer", reason: reason.trim() }, { onSuccess: () => setOpen(false) });
      }}
    >
      <Input aria-label={t("requirements.act.undeferWhyLabel")} placeholder={t("requirements.act.undeferWhy")} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      <Button type="submit" size="sm" disabled={!reason.trim()} loading={act.isPending}>
        {t("requirements.act.undefer")}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        {t("common.cancel")}
      </Button>
      <RefusalLine error={act.error} />
    </form>
  );
}

/** Accept or return the proposed revision: the accept through its confirm step, the return carrying why. */
export function ProposalDecision({ projectId, d, revision }: { projectId: string; d: RequirementDetail; revision: number }) {
  const t = useCopy();
  const act = useRequirementAction(projectId, d.key);
  const [step, setStep] = useState<"accept" | "return" | null>(null);
  const [reason, setReason] = useState("");
  if (!d.canSignOff) {
    return <p className="text-12 text-subtle">{t("requirements.act.signerDecides")}</p>;
  }
  const busy = act.isPending;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => setStep((v) => (v === "accept" ? null : "accept"))} aria-expanded={step === "accept"}>
          {t("requirements.act.accept")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setStep((v) => (v === "return" ? null : "return"))} aria-expanded={step === "return"}>
          {t("requirements.act.reject")}
        </Button>
      </div>
      {step === "accept" ? (
        <AcceptStep
          confirmLabel={t("requirements.act.acceptR", { r: revision })}
          consequence={t("requirements.act.acceptConsequence", { r: revision })}
          loading={busy}
          onCancel={() => setStep(null)}
          onConfirm={(why) => act.mutate({ kind: "accept", revision, reason: why }, { onSuccess: () => setStep(null) })}
        />
      ) : null}
      {step === "return" ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate(
              { kind: "return", revision, reason: reason.trim() },
              {
                onSuccess: () => {
                  setStep(null);
                  setReason("");
                },
              },
            );
          }}
        >
          <Input
            aria-label={t("requirements.act.returnWhyLabel")}
            placeholder={t("requirements.act.returnWhy")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="min-w-[16rem] flex-1"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={!reason.trim()} loading={busy}>
            {t("requirements.act.returnR", { r: revision })}
          </Button>
        </form>
      ) : null}
      <RefusalLine error={act.error} />
    </div>
  );
}
