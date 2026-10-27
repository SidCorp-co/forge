"use client";

// Who is in this room — the roster, and the way in and out of it (ISS-1011).
//
// An agent and a person are two kinds of member with different authority and
// different reach, so they are two sections with two row treatments and two
// separate add controls. The agent row carries an outline the person row does
// not, at the accent token, which clears the 3:1 non-text contrast bar against
// the surface behind it: the difference is meant to be seen rather than read.

import { readerInitials } from "@forge/contracts/person-name";
import { useId, useState } from "react";
import {
  Avatar,
  Banner,
  Button,
  ConfirmDialog,
  Icon,
  IconButton,
  SectionTitle,
  SlideOver,
  Tooltip,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useAuth } from "@/providers/auth-provider";
import { useRemoveParticipant } from "../hooks";
import {
  agentsOf,
  answeringAgents,
  cannotAnswerReason,
  memberName,
  orderedPeopleOf,
  personStanding,
  removalClaim,
  removalHeld,
  removalQuestion,
  removeControlName,
} from "../membership";
import type { ConversationMembership, ConversationParticipant } from "../types";
import { AddAgentDialog } from "./add-agent-dialog";
import { AddPersonDialog } from "./add-person-dialog";

export function ConversationMembers({
  conversationId,
  room,
  canChange,
  open,
  onClose,
}: {
  conversationId: string;
  room: Partial<ConversationMembership>;
  /** False for a reader who may look at the room but not change who is in it. */
  canChange: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const [addingAgent, setAddingAgent] = useState(false);
  const [addingPerson, setAddingPerson] = useState(false);
  // Taking somebody out is asked first, naming who (ISS-1229 r23): two unnamed people read alike.
  const [removing, setRemoving] = useState<ConversationParticipant | null>(null);
  const remove = useRemoveParticipant(conversationId);
  const viewerId = useAuth().user?.id ?? null;
  const asked = removing ? removalQuestion(removing, viewerId, room) : null;

  const agents = agentsOf(room);
  const people = orderedPeopleOf(room, viewerId);

  return (
    <>
      <SlideOver open={open} onClose={onClose} title="Who is in this room" width={420}>
        <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto">
          <p className="fg-caption text-subtle" data-testid="members-agents-answer">
            {answeringAgents(room)}
          </p>

          {remove.isError && (
            <div data-testid="members-remove-error" role="status">
              <Banner tone="danger">{formatApiError(remove.error)}</Banner>
            </div>
          )}

          <Section
            title="Agents"
            hint="What this room can see comes from these."
            action={
              canChange ? (
                <Button size="sm" variant="secondary" icon="plus" onClick={() => setAddingAgent(true)}>
                  Add agent
                </Button>
              ) : null
            }
          >
            {agents.map((agent) => (
              <MemberRow
                key={agent.id}
                member={agent}
                room={room}
                canChange={canChange}
                viewerId={viewerId}
                busy={remove.isPending}
                onRemove={() => setRemoving(agent)}
              />
            ))}
          </Section>

          <Section
            title="People"
            hint="Who can read this room."
            action={
              canChange ? (
                <Button size="sm" variant="secondary" icon="plus" onClick={() => setAddingPerson(true)}>
                  Add person
                </Button>
              ) : null
            }
          >
            {people.map((person) => (
              <MemberRow
                key={person.id}
                member={person}
                room={room}
                canChange={canChange}
                viewerId={viewerId}
                busy={remove.isPending}
                onRemove={() => setRemoving(person)}
              />
            ))}
          </Section>
        </div>
      </SlideOver>

      <ConfirmDialog
        open={removing !== null}
        title={asked?.title ?? ""}
        message={removing ? removalClaim(removing, room, viewerId) : ""}
        confirmLabel={asked?.confirm ?? ""}
        tone="danger"
        loading={remove.isPending}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate({ participantId: removing.id }, { onSettled: () => setRemoving(null) });
        }}
      />

      <AddAgentDialog
        conversationId={conversationId}
        room={room}
        open={addingAgent}
        onClose={() => setAddingAgent(false)}
      />
      <AddPersonDialog
        conversationId={conversationId}
        room={room}
        open={addingPerson}
        onClose={() => setAddingPerson(false)}
      />
    </>
  );
}

function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint: string;
  action: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <SectionTitle className="fg-overline text-subtle">{title}</SectionTitle>
          <p className="fg-caption text-subtle">{hint}</p>
        </div>
        {action}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

/**
 * One member, in the shape its kind gets.
 */
function MemberRow({
  member,
  room,
  canChange,
  viewerId,
  busy,
  onRemove,
}: {
  member: ConversationParticipant;
  room: Partial<ConversationMembership>;
  canChange: boolean;
  viewerId: string | null;
  busy: boolean;
  onRemove: () => void;
}) {
  const isAgent = member.kind === "handle";
  const project = (room.scopeProjects ?? []).find((p) => p.id === member.projectId);
  const held = removalHeld(member, room);
  const heldReasonId = useId();
  // A tapped held control says why under its row: a bubble above it covered the section's Add
  // agent button, the very remedy the reason names (ISS-1229 r31, judge-88).
  const [heldTapped, setHeldTapped] = useState(false);
  return (
    <div className="flex flex-col">
      <div
        data-testid={isAgent ? "member-row-agent" : "member-row-person"}
        className={`flex min-h-[40px] items-center gap-2 rounded-md px-2.5 py-1.5 ${
          isAgent
            ? "border border-[color:var(--accent)] bg-[color:var(--accent-tint)]"
            : "border border-transparent"
        }`}
      >
        {isAgent ? (
          <span data-testid="member-mark-agent" className="flex-none">
            <Icon name="agent" size={15} className="text-[color:var(--accent-text)]" />
          </span>
        ) : (
          <span data-testid="member-mark-person" className="flex-none">
            <Avatar initials={readerInitials(member.userId, viewerId, member.displayName)} size={20} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <span className={`fg-body-sm block ${isAgent ? "truncate font-mono" : "break-words"}`}>
            {memberName(member, viewerId, "start")}
          </span>
          <span className="fg-caption block truncate text-subtle">
            {isAgent ? (project?.name ?? "a project this room is no longer about") : personStanding(member, room, viewerId).line}
          </span>
        </div>
        {/* Core marks an agent by its role on the room's project, the one thing answering here asks of
            it (ISS-1229 r32, judge-90). Its reason is in the row: a tapped bubble covered the next agent's
            take-out control at 390 (r33, judge-92). */}
        {isAgent && member.reachable === false && (
          <span data-testid="member-cannot-answer" className="fg-caption flex-none rounded bg-surface px-1.5 py-0.5 text-muted">
            can't answer
          </span>
        )}
        {/* A held control stays focusable, so its reason reaches a keyboard reader too (r27 review F1). */}
        {canChange && (
          <Tooltip
            prose
            label={held ?? removalClaim(member, room, viewerId)}
            {...(held ? { onTouchShown: setHeldTapped } : {})}
          >
            <IconButton
              icon="x"
              size="sm"
              aria-label={removeControlName(member, room, viewerId)}
              aria-describedby={held ? heldReasonId : undefined}
              aria-disabled={held !== null || undefined}
              className={held ? "cursor-not-allowed opacity-50" : undefined}
              disabled={busy}
              onClick={held ? undefined : onRemove}
            />
          </Tooltip>
        )}
        {canChange && held && (
          <span id={heldReasonId} className="sr-only">
            {held}
          </span>
        )}
      </div>
      {isAgent && member.reachable === false && (
        <p className="fg-caption px-2.5 pt-1 text-muted" data-testid="member-cannot-answer-reason">
          {cannotAnswerReason(project?.name)}
        </p>
      )}
      {canChange && held && heldTapped && (
        <p className="fg-caption px-2.5 pt-1.5 text-muted" data-testid="member-held-reason" aria-hidden="true">
          {held}
        </p>
      )}
    </div>
  );
}
