"use client";

// The acts a requirement offers where it stands — review a proposal, propose a draft, agree the
// head, accept a delivery — and the BA assistant door (ISS-58) that "Propose change" and the top
// bar's Ask Agent open. The peek and the full page draw the same buttons from the same rules.

import Link from "next/link";
import { useCallback, useState } from "react";
import { Button, Input, showToast, Tooltip } from "@/design";
import { type DockDoor, useChatDock } from "@/features/conversations/dock";
import { formatApiError } from "@/lib/api/error";
import { requirementsApi } from "../api";
import { useRequirementAction } from "../hooks";
import { requirementHref } from "../routes";
import type { RequirementDetail } from "../types";
import { RefusalLine } from "./refusal";

/** Opens the viewer's BA assistant room about this requirement; a refusal is a toast and no room. */
export function useAssistantDoor(projectId: string, reqKey: string): DockDoor {
  return useCallback(async () => {
    try {
      const r = await requirementsApi.openAssistant(projectId, reqKey);
      return { kind: "room", projectId, conversationId: r.conversation.id };
    } catch (err) {
      showToast({ title: `Could not open the BA assistant for ${reqKey}`, description: formatApiError(err), tone: "error" });
      return null;
    }
  }, [projectId, reqKey]);
}

export function ProposeChange({ projectId, reqKey }: { projectId: string; reqKey: string }) {
  const dock = useChatDock();
  const door = useAssistantDoor(projectId, reqKey);
  const [busy, setBusy] = useState(false);
  if (!dock) return null;
  return (
    <Tooltip label="Opens the BA assistant on this requirement; it drafts the revision for you to propose" multiline>
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
        Propose change
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
  /** On the full page, "Review proposal" scrolls to it; in the peek it opens the full page there. */
  onReview?: () => void;
}) {
  const act = useRequirementAction(projectId, d.key);
  const proposed = d.revisions.find((r) => r.state === "proposed");
  const draft = d.revisions.find((r) => r.state === "draft");
  const head = d.revisions.find((r) => r.state === "current");
  const s = d.standing;
  const busy = act.isPending;
  let primary: React.ReactNode = null;
  if (proposed) {
    primary = inPeek ? (
      <Link
        href={`${requirementHref(slug, d.key)}#proposal`}
        onClick={onReview}
        className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-13 font-semibold text-on-accent hover:bg-accent-hover"
      >
        Review proposal r{proposed.revision}
      </Link>
    ) : (
      <Button type="button" size="sm" variant="primary" onClick={onReview}>
        Review proposal r{proposed.revision}
      </Button>
    );
  } else if (draft && s.waitingOn.kind === "you") {
    primary = (
      <Button type="button" size="sm" variant="primary" loading={busy} onClick={() => act.mutate({ kind: "propose", revision: draft.revision })}>
        Propose r{draft.revision}
      </Button>
    );
  } else if (d.canSignOff && d.status === "draft" && head && !draft) {
    primary = (
      <Button type="button" size="sm" variant="primary" loading={busy} onClick={() => act.mutate({ kind: "agree", revision: head.revision })}>
        Agree r{head.revision}
      </Button>
    );
  } else if (s.state === "delivered" && d.canSignOff) {
    primary = (
      <Tooltip label="Accepting a delivery has no door yet: delivered → accepted was left out of ISS-57" multiline>
        <Button type="button" size="sm" variant="primary" disabled>
          Accept delivery
        </Button>
      </Tooltip>
    );
  }
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {primary}
        {s.attentionGroup !== "done" ? <ProposeChange projectId={projectId} reqKey={d.key} /> : null}
      </div>
      <RefusalLine error={act.error} />
    </div>
  );
}

/** Accept or return the proposed revision, the return carrying why. */
export function ProposalDecision({ projectId, d, revision }: { projectId: string; d: RequirementDetail; revision: number }) {
  const act = useRequirementAction(projectId, d.key);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");
  if (!d.canSignOff) {
    return <p className="text-12 text-subtle">A BA or the owner accepts or returns it.</p>;
  }
  const busy = act.isPending;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" loading={busy} onClick={() => act.mutate({ kind: "accept", revision })}>
          Accept
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setReturning((v) => !v)} aria-expanded={returning}>
          Reject
        </Button>
      </div>
      {returning ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate(
              { kind: "return", revision, reason: reason.trim() },
              {
                onSuccess: () => {
                  setReturning(false);
                  setReason("");
                },
              },
            );
          }}
        >
          <Input
            aria-label="Why it goes back"
            placeholder="Why it goes back to draft"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="min-w-[16rem] flex-1"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={!reason.trim()} loading={busy}>
            Return r{revision}
          </Button>
        </form>
      ) : null}
      <RefusalLine error={act.error} />
    </div>
  );
}
