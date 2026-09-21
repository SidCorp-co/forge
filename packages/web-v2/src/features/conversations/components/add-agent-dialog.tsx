"use client";

// Adding an agent to a room: pick one, then read what it will be able to see.
//
// ISS-1011 — this is a SEPARATE control from the one that adds a person, and
// the separation is the point rather than a layout choice: a person changes who
// reads the room, an agent changes what the room can see, and one combobox
// serving both makes a scope change look like an invitation.
//
// The confirmation is not a "are you sure" — it is the list of claims in
// `membership.ts`, each of which is a fact about what the code does. Removal is
// named there as a narrowing and never as an undo, because it is not one.

import { useState } from "react";
import { Banner, Button, ErrorState, Icon, Spinner } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useAddHandle, useConversationCandidates } from "../hooks";
import { agentAdditionClaims } from "../membership";
import type { ConversationMembership, HandleCandidate } from "../types";
import { SlideOver } from "@/design";

export function AddAgentDialog({
  conversationId,
  room,
  open,
  onClose,
}: {
  conversationId: string;
  room: Partial<Pick<ConversationMembership, "shape" | "scopeProjects" | "participants">>;
  open: boolean;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<HandleCandidate | null>(null);
  const candidates = useConversationCandidates(conversationId, open);
  const add = useAddHandle(conversationId);

  const close = () => {
    setPicked(null);
    add.reset();
    onClose();
  };

  const confirm = () => {
    if (!picked) return;
    add.mutate(
      { userId: picked.userId, projectId: picked.project.id },
      { onSuccess: close },
    );
  };

  return (
    <SlideOver open={open} onClose={close} title="Add an agent" width={460}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        {picked ? (
          <Confirmation candidate={picked} room={room} />
        ) : (
          <CandidateList query={candidates} onPick={setPicked} />
        )}

        {add.isError && (
          <div data-testid="add-agent-error" role="status">
            <Banner tone="danger">{formatApiError(add.error)}</Banner>
          </div>
        )}

        {picked && (
          <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
            <Button variant="ghost" onClick={() => setPicked(null)} disabled={add.isPending}>
              Back
            </Button>
            <Button variant="primary" loading={add.isPending} onClick={confirm}>
              Add @{picked.handle}
            </Button>
          </div>
        )}
      </div>
    </SlideOver>
  );
}

function Confirmation({
  candidate,
  room,
}: {
  candidate: HandleCandidate;
  room: Partial<Pick<ConversationMembership, "shape" | "scopeProjects" | "participants">>;
}) {
  const claims = agentAdditionClaims({ candidate, room });
  return (
    <div data-testid="add-agent-confirmation" className="flex flex-col gap-3">
      <div className="flex items-center gap-2 rounded-md border border-[color:var(--accent)] bg-[color:var(--accent-tint)] px-3 py-2">
        <Icon name="agent" size={15} className="flex-none text-[color:var(--accent-text)]" />
        <span className="fg-label font-mono">@{candidate.handle}</span>
        <span className="fg-caption ml-auto text-muted">{candidate.project.name}</span>
      </div>
      <ul className="flex flex-col gap-2">
        {claims.map((claim) => (
          <li key={claim.key} data-claim={claim.key} className="fg-body-sm text-fg">
            {claim.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CandidateList({
  query,
  onPick,
}: {
  query: ReturnType<typeof useConversationCandidates>;
  onPick: (c: HandleCandidate) => void;
}) {
  if (query.isLoading) {
    return (
      <p role="status" data-testid="agent-candidates-loading" className="fg-body-sm text-muted">
        <Spinner size={14} /> Looking for agents you can add…
      </p>
    );
  }
  if (query.isError) {
    return (
      <div data-testid="agent-candidates-error">
        <ErrorState
          title="Couldn't load the agents"
          message={formatApiError(query.error)}
          onRetry={() => query.refetch()}
        />
      </div>
    );
  }
  const handles = query.data?.handles ?? [];
  if (handles.length === 0) {
    return (
      <p role="status" data-testid="agent-candidates-empty" className="fg-body-sm text-muted">
        There is no agent you can add to this room. An agent is added by somebody holding a member
        role on its project.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {handles.map((handle) => (
        <li key={`${handle.userId ?? "unminted"}:${handle.project.id}`}>
          <button
            type="button"
            onClick={() => onPick(handle)}
            className="flex w-full items-center gap-2 rounded-md border border-line px-3 py-2 text-left hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <Icon name="agent" size={15} className="flex-none text-[color:var(--accent-text)]" />
            <span className="fg-body-sm font-mono">@{handle.handle}</span>
            <span className="fg-caption ml-auto text-muted">{handle.project.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
