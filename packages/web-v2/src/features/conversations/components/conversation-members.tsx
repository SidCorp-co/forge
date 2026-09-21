"use client";

// Who is in this room — the roster, and the way in and out of it (ISS-1011).
//
// An agent and a person are two kinds of member with different authority and
// different reach, so they are two sections with two row treatments and two
// separate add controls. The agent row carries an outline the person row does
// not, at the accent token, which clears the 3:1 non-text contrast bar against
// the surface behind it: the difference is meant to be seen rather than read.

import { useState } from "react";
import {
  Avatar,
  Banner,
  Button,
  Icon,
  IconButton,
  SectionTitle,
  SlideOver,
  Tooltip,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useRemoveParticipant } from "../hooks";
import { agentsOf, initialsOf, peopleOf, removalClaim, scopeDerivation } from "../membership";
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
  const remove = useRemoveParticipant(conversationId);

  const agents = agentsOf(room);
  const people = peopleOf(room);

  return (
    <>
      <SlideOver open={open} onClose={onClose} title="Who is in this room" width={420}>
        <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto">
          <p className="fg-caption text-subtle" data-testid="members-scope-derivation">
            {scopeDerivation(room)}
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
                busy={remove.isPending}
                onRemove={() => remove.mutate({ participantId: agent.id })}
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
                busy={remove.isPending}
                onRemove={() => remove.mutate({ participantId: person.id })}
              />
            ))}
          </Section>
        </div>
      </SlideOver>

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
  busy,
  onRemove,
}: {
  member: ConversationParticipant;
  room: Partial<ConversationMembership>;
  canChange: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  const isAgent = member.kind === "handle";
  const project = (room.scopeProjects ?? []).find((p) => p.id === member.projectId);
  return (
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
          <Avatar initials={initialsOf(member.displayName ?? "?")} size={20} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <span className={`fg-body-sm block truncate ${isAgent ? "font-mono" : ""}`}>
          {isAgent ? `@${member.displayName ?? member.label}` : (member.displayName ?? "Unknown")}
        </span>
        <span className="fg-caption block truncate text-subtle">
          {isAgent ? (project?.name ?? "a project this room is no longer about") : "Person"}
        </span>
      </div>
      {isAgent && member.reachable === false && (
        <Tooltip label="This agent holds no live credential or has lost its project role, so it cannot answer here.">
          <span className="fg-caption rounded bg-surface px-1.5 py-0.5 text-muted">can't act</span>
        </Tooltip>
      )}
      {canChange && (
        <Tooltip label={removalClaim(member, room)}>
          <IconButton
            icon="x"
            size="sm"
            aria-label={`Take ${member.displayName ?? "this member"} out of the room`}
            disabled={busy}
            onClick={onRemove}
          />
        </Tooltip>
      )}
    </div>
  );
}
