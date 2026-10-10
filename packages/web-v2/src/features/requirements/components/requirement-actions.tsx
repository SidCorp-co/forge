"use client";

// The acts a requirement offers where it stands — review a proposal, propose a draft, agree the
// head, accept a delivery, defer or drop it — and the BA assistant door (ISS-58) that "Propose change" and the top
// bar's Ask Agent open. The peek and the full page's header draw the same one primary act from the
// same rules; "Propose change" sits with the revisions, Accept / Reject beside the diff. Every sign-off
// (accept, agree, re-pin, accept a delivery) opens a confirm step taking the signer's reason (ISS-281); while
// it is open the button that opened it is off, so a second press cannot close it and drop the typed reason.

import Link from "next/link";
import { useCallback, useState } from "react";
import { AcceptStep, Button, Input, showToast, Tooltip, focusOnMount } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { type DockDoor, useChatDock } from "@/features/chat-dock";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useLabel } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import type { Copy } from "@/lib/i18n/product-copy";
import { draftIssuesToPromote } from "@forge/contracts/requirements";
import { requirementsApi } from "../api";
import { useRequirementAction } from "../hooks";
import { requirementHref } from "@/lib/routes/requirements";
import type { RequirementAction, RequirementDetail } from "../types";
import { PromoteDrafts } from "./promote-drafts";
import { DraftEditor } from "./requirement-draft-editor";

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
    <Button
      type="button"
      size="sm"
      loading={busy}
      onClick={() => {
        setBusy(true);
        void door().then((target) => {
          setBusy(false);
          if (target) dock.show(target);
        });
      }}
    >
      {t("requirements.act.proposeChange")}
    </Button>
  );
}

/** What moved under the requirement's pins: each design and contract, from what it was pinned at. */
function movedPins(facts: RequirementDetail["standing"]["facts"], t: Copy): string {
  const was = (pinned: unknown, line: string) => (pinned === null ? t("requirements.act.notFollowedYet") : line);
  return [
    ...facts.stalePins.map((p) => t("requirements.act.pinMovedDesign", { title: p.title, approved: p.approved, was: was(p.pinned, t("requirements.act.pinWas", { r: p.pinned ?? 0 })) })),
    ...facts.staleContractPins.map((p) => t("requirements.act.pinMovedContract", { contract: p.contract, current: p.current, was: was(p.pinned, t("requirements.act.pinWasVersion", { v: p.pinned ?? "" })) })),
  ].join(", ");
}

/** "Review proposal": the full page's revisions in the peek (`href`), the revisions view on the full page. */
function ReviewProposal({ href, revision, onReview }: { href: string | null; revision: number; onReview?: () => void }) {
  const t = useCopy();
  const words = t("requirements.act.reviewProposal", { r: revision });
  return href ? (
    <Link href={href} onClick={onReview} className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-13 font-semibold text-on-accent hover:bg-accent-hover">
      {words}
    </Link>
  ) : (
    <Button type="button" size="sm" variant="primary" onClick={onReview}>
      {words}
    </Button>
  );
}

/** Agree a draft's current revision; held, and saying why, while a design it pins is not approved. */
function AgreeAct({ projectId, reqKey, revision, held }: { projectId: string; reqKey: string; revision: number; held: RequirementDetail["standing"]["facts"]["unapprovedDesigns"] }) {
  const t = useCopy();
  const { designWord } = useStateWords();
  if (held.length > 0) {
    const designs = held.map((x) => `${x.title} (${designWord(x.designStatus)})`).join(", ");
    return (
      <Tooltip label={t("requirements.act.agreeHeldTip", { designs })} multiline>
        <Button type="button" size="sm" variant="primary" disabled data-testid="agree-held">
          {t("requirements.act.agreeR", { r: revision })}
        </Button>
      </Tooltip>
    );
  }
  return (
    <SignOff
      projectId={projectId}
      reqKey={reqKey}
      label={t("requirements.act.agreeR", { r: revision })}
      consequence={t("requirements.act.agreeConsequence", { r: revision })}
      reasonLabel={t("requirements.act.agreeWhyLabel")}
      reasonRequired
      act={(reason) => ({ kind: "agree", revision, reason })}
    />
  );
}

/** Core's raw state names stay as written in English, as they always read there; another language reads their label. */
function useStateWords() {
  const t = useCopy();
  const label = useLabel();
  const lang = useInterfaceLanguage();
  const word = (family: "requirementState" | "designStatus", st: string) => (lang === "en" ? st : label(family, st).toLowerCase());
  return {
    statusWord: (st: string | undefined) => (st ? word("requirementState", st) : undefined),
    designWord: (st: string | null) => (st ? word("designStatus", st) : t("requirements.act.noDesignYet")),
  };
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
  const lang = useInterfaceLanguage();
  const { statusWord } = useStateWords();
  const act = useRequirementAction(projectId, d.key);
  const proposed = d.revisions.find((r) => r.state === "proposed");
  const draft = d.revisions.find((r) => r.state === "draft");
  const head = d.revisions.find((r) => r.state === "current");
  const s = d.standing;
  const busy = act.isPending;
  let primary: React.ReactNode = null;
  if (d.status === "deferred") {
    primary = d.canSignOff ? (
      <ReasonAct
        projectId={projectId}
        reqKey={d.key}
        label={t("requirements.act.undefer")}
        primary
        tip={t("requirements.act.undeferTip", { reason: d.deferral?.reason ?? "", from: statusWord(d.deferral?.from) ?? t("requirements.act.itsStatus") })}
        whyLabel={t("requirements.act.undeferWhyLabel")}
        whyHint={t("requirements.act.undeferWhy")}
        build={(reason) => ({ kind: "undefer", reason })}
      />
    ) : null;
  } else if (proposed) {
    primary = <ReviewProposal href={inPeek ? `${requirementHref(slug, d.key)}?tab=revisions` : null} revision={proposed.revision} onReview={onReview} />;
  } else if (draft && s.waitingOn.kind === "you") {
    primary = (
      <>
        <Button type="button" size="sm" variant="primary" loading={busy} onClick={() => act.mutate({ kind: "propose", revision: draft.revision })}>
          {t("requirements.act.proposeR", { r: draft.revision })}
        </Button>
        <DraftEditor projectId={projectId} d={d} draft={draft} />
      </>
    );
  } else if (d.canSignOff && d.status === "agreed" && head && s.facts.stalePins.length + s.facts.staleContractPins.length > 0) {
    const moved = movedPins(s.facts, t);
    primary = (
      <SignOff
        projectId={projectId}
        reqKey={d.key}
        label={t("requirements.act.repin")}
        tip={s.waitingOn.says.effect ? said(s.waitingOn.says.effect, lang) : t("requirements.act.repinTip", { moved })}
        consequence={t("requirements.act.repinConsequence", { moved })}
        reasonLabel={t("requirements.act.repinWhyLabel")}
        reasonRequired
        act={(reason) => ({ kind: "repin", revision: head.revision, reason })}
      />
    );
  } else if (d.canSignOff && d.status === "draft" && head && !draft) {
    primary = <AgreeAct projectId={projectId} reqKey={d.key} revision={head.revision} held={s.facts.unapprovedDesigns} />;
  } else if (s.state === "delivered" && d.canSignOff && head) {
    primary = (
      <SignOff
        projectId={projectId}
        reqKey={d.key}
        label={t("requirements.act.acceptDeliveryR", { r: head.revision })}
        tip={t("requirements.act.acceptDeliveryTip", { r: head.revision })}
        consequence={t("requirements.act.acceptDeliveryConsequence", { r: head.revision })}
        reasonLabel={t("requirements.act.acceptDeliveryWhyLabel")}
        act={(reason) => ({ kind: "accept-delivery", revision: head.revision, reason })}
      />
    );
  } else if (d.canPromote && draftIssuesToPromote(d.status, d.issues).length > 0) {
    primary = <PromoteDrafts projectId={projectId} d={d} />;
  }
  const deferrable = d.canSignOff && (d.status === "draft" || d.status === "agreed");
  const droppable = d.canSignOff && (d.status === "draft" || d.status === "agreed" || d.status === "deferred");
  if (!primary && !deferrable && !droppable) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {primary}
      {deferrable ? (
        <ReasonAct
          projectId={projectId}
          reqKey={d.key}
          label={t("requirements.act.defer")}
          whyLabel={t("requirements.act.deferWhyLabel")}
          whyHint={t("requirements.act.deferWhy")}
          extra={{ label: t("requirements.act.meantForLabel"), hint: t("requirements.act.meantFor") }}
          build={(reason, targetPhase) => ({ kind: "defer", reason, targetPhase: targetPhase || undefined })}
        />
      ) : null}
      {droppable ? (
        <ReasonAct
          projectId={projectId}
          reqKey={d.key}
          label={t("requirements.act.drop")}
          submitVariant="danger"
          whyLabel={t("requirements.act.dropWhyLabel")}
          whyHint={t("requirements.act.dropWhy")}
          build={(reason) => ({ kind: "drop", reason })}
        />
      ) : null}
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
  reasonLabel,
  reasonRequired = false,
  act: build,
}: {
  projectId: string;
  reqKey: string;
  label: string;
  tip?: string;
  consequence: string;
  /** The reason field's label, named for this act. */
  reasonLabel: string;
  /** Core refuses this act without a reason (agree, re-pin). */
  reasonRequired?: boolean;
  act: (reason: string | undefined) => RequirementAction;
}) {
  const act = useRequirementAction(projectId, reqKey);
  const [open, setOpen] = useState(false);
  const button = (
    <Button type="button" size="sm" variant="primary" disabled={act.isPending || open} aria-expanded={open} onClick={() => setOpen(true)}>
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
            reasonLabel={reasonLabel}
            reasonRequired={reasonRequired}
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

/** The reason an act must give, typed and sent: and, given `extra`, a second optional line beside it. */
function ReasonForm({
  whyLabel,
  whyHint,
  submit,
  submitVariant,
  extra,
  busy,
  error,
  onSend,
  onCancel,
}: {
  whyLabel: string;
  whyHint: string;
  submit: string;
  submitVariant?: "primary" | "danger";
  extra?: { label: string; hint: string };
  busy: boolean;
  /** The act's refusal, where no caller shows it. */
  error?: unknown;
  onSend: (reason: string, extra: string) => void;
  onCancel: () => void;
}) {
  const t = useCopy();
  const [reason, setReason] = useState("");
  const [more, setMore] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSend(reason.trim(), more.trim());
      }}
    >
      <Input aria-label={whyLabel} placeholder={whyHint} value={reason} onChange={(e) => setReason(e.target.value)} className="min-w-64 flex-1" ref={focusOnMount} />
      {extra ? <Input aria-label={extra.label} placeholder={extra.hint} value={more} onChange={(e) => setMore(e.target.value)} /> : null}
      <Button type="submit" size="sm" variant={submitVariant} disabled={!reason.trim()} loading={busy}>
        {submit}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
        {t("common.cancel")}
      </Button>
      {error ? <RefusalLine error={error} /> : null}
    </form>
  );
}

/** An act that must say why: its button opens the reason form, which sends what `build` makes of it. */
function ReasonAct({
  projectId,
  reqKey,
  label,
  tip,
  primary = false,
  build,
  ...form
}: {
  projectId: string;
  reqKey: string;
  label: string;
  tip?: string;
  primary?: boolean;
  build: (reason: string, extra: string) => RequirementAction;
} & Pick<Parameters<typeof ReasonForm>[0], "whyLabel" | "whyHint" | "submitVariant" | "extra">) {
  const act = useRequirementAction(projectId, reqKey);
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <ReasonForm
        {...form}
        submit={label}
        busy={act.isPending}
        error={act.error}
        onSend={(reason, extra) => act.mutate(build(reason, extra), { onSuccess: () => setOpen(false) })}
        onCancel={() => setOpen(false)}
      />
    );
  }
  const button = (
    <Button type="button" size="sm" variant={primary ? "primary" : "ghost"} onClick={() => setOpen(true)}>
      {label}
    </Button>
  );
  return tip ? (
    <Tooltip label={tip} multiline>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

/** Accept or return the proposed revision: the accept through its confirm step, the return carrying why. */
export function ProposalDecision({ projectId, d, revision }: { projectId: string; d: RequirementDetail; revision: number }) {
  const t = useCopy();
  const act = useRequirementAction(projectId, d.key);
  const [step, setStep] = useState<"accept" | "return" | null>(null);
  if (!d.canSignOff) return null;
  const busy = act.isPending;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={busy || step !== null} onClick={() => setStep("accept")} aria-expanded={step === "accept"}>
          {t("requirements.act.accept")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy || step !== null} onClick={() => setStep("return")} aria-expanded={step === "return"}>
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
        <ReasonForm
          whyLabel={t("requirements.act.returnWhyLabel")}
          whyHint={t("requirements.act.returnWhy")}
          submit={t("requirements.act.returnR", { r: revision })}
          busy={busy}
          onSend={(why) => act.mutate({ kind: "return", revision, reason: why }, { onSuccess: () => setStep(null) })}
          onCancel={() => setStep(null)}
        />
      ) : null}
      <RefusalLine error={act.error} />
    </div>
  );
}
