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

import Link from "next/link";
import { useState } from "react";
import { Banner, Button, ErrorState, Icon, Spinner } from "@/design";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useAddHandle, useConversationCandidates } from "../hooks";
import { agentAdditionClaims, beyondReachLines, candidateHeldReason } from "../membership";
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
  // Projects found deleted since the list was read: their agents leave it now, not at the next read.
  const [goneProjects, setGoneProjects] = useState<ReadonlySet<string>>(new Set());
  const candidates = useConversationCandidates(conversationId, open);
  const add = useAddHandle(conversationId);

  const close = () => {
    setPicked(null);
    setGoneProjects(new Set());
    add.reset();
    onClose();
  };

  const confirm = () => {
    if (!picked) return;
    const projectId = picked.project.id;
    add.mutate(
      { userId: picked.userId, projectId },
      {
        onSuccess: close,
        onError: (err) => {
          if (!(err instanceof ApiError) || err.code !== PROJECT_GONE) return;
          setGoneProjects((ids) => new Set([...ids, projectId]));
          setPicked(null);
          void candidates.refetch();
        },
      },
    );
  };

  return (
    <SlideOver open={open} onClose={close} title="Add an agent" width={460}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        {picked ? (
          <Confirmation candidate={picked} room={room} />
        ) : (
          <CandidateList
            query={candidates}
            goneProjects={goneProjects}
            onPick={(candidate) => {
              add.reset();
              setPicked(candidate);
            }}
          />
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

const PROJECT_GONE = "PROJECT_GONE";

function CandidateList({
  query,
  goneProjects,
  onPick,
}: {
  query: ReturnType<typeof useConversationCandidates>;
  goneProjects: ReadonlySet<string>;
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
  const handles = (query.data?.handles ?? []).filter((h) => !goneProjects.has(h.project.id));
  // Agents of projects the reader holds no member role on: whose members add each, beside a new project (r33, r34).
  const beyond = beyondReachLines(query.data?.beyondReach);
  if (handles.length === 0) {
    // Emptied by a project deleted under the panel, that is why (ISS-1229 r30, judge-86). Otherwise every
    // agent the reader may add is in the room already: a role sentence there blamed a role an admin held
    // (r32, judge-90), so it says where another agent comes from instead.
    if (goneProjects.size > 0) {
      return (
        <p role="status" data-testid="agent-candidates-empty" className="fg-body-sm text-muted">
          There is no agent left that you can add to this room: the project of the agent you picked was
          deleted.
        </p>
      );
    }
    return (
      <div role="status" data-testid="agent-candidates-empty" className="fg-body-sm flex flex-col gap-2 text-muted">
        <p>
          Every agent you can add is already in this room.
          {beyond.length === 0 &&
            " Each project has its own agent, so another one comes with another project in this organization."}
        </p>
        {beyond.map((line) => (
          <p key={line} data-testid="agent-beyond-reach">
            {line}
          </p>
        ))}
        <p>
          {beyond.length > 0 && "Or "}
          <Link href="/projects?new=1" className="text-link underline-offset-2 hover:underline">
            {beyond.length > 0 ? "start a new project" : "Start a new project"}
          </Link>
          {beyond.length > 0 && ", which comes with its own agent."}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1">
        {handles.map((handle) => {
          // An agent that cannot be added is shown with why, and is not offered (r35, r37).
          const held = candidateHeldReason(handle);
          return (
          <li key={`${handle.userId ?? "unminted"}:${handle.project.id}`}>
            <button
              type="button"
              disabled={held !== null}
              onClick={() => onPick(handle)}
              className="flex w-full flex-col gap-0.5 rounded-md border border-line px-3 py-2 text-left hover:bg-hover disabled:cursor-not-allowed disabled:hover:bg-transparent focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
              <span className="flex w-full items-center gap-2">
                <Icon name="agent" size={15} className="flex-none text-[color:var(--accent-text)]" />
                <span className={`fg-body-sm font-mono ${held ? "text-muted" : ""}`}>@{handle.handle}</span>
                <span className="fg-caption ml-auto text-muted">{handle.project.name}</span>
              </span>
              {held && (
                <span className="fg-caption text-muted" data-testid="agent-held-reason">{held}</span>
              )}
            </button>
          </li>
          );
        })}
      </ul>
      {beyond.map((line) => (
        <p key={line} data-testid="agent-beyond-reach" className="fg-caption text-muted">
          {line}
        </p>
      ))}
    </div>
  );
}
