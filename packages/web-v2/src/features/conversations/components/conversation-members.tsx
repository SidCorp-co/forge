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
import { useCopy } from "@/lib/i18n/interface-language";
import { useRemoveParticipant } from "../hooks";
import { agentsOf, initialsOf, peopleOf, removalClaim, scopeDerivation } from "../membership";
import type { ConversationMembership, ConversationParticipant } from "../types";
import { AddAgentDialog, AddPersonDialog } from "./add-member-dialog";

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
  const t = useCopy();
  const [addingAgent, setAddingAgent] = useState(false);
  const [addingPerson, setAddingPerson] = useState(false);
  const remove = useRemoveParticipant(conversationId);

  const agents = agentsOf(room);
  const people = peopleOf(room);

  return (
    <>
      <SlideOver open={open} onClose={onClose} title={t("conversations.members.title")} width={420}>
        <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto">
          <p className="fg-caption text-subtle" data-testid="members-scope-derivation">
            {scopeDerivation(room, t)}
          </p>

          {remove.isError && (
            <div data-testid="members-remove-error" role="status">
              <Banner tone="danger">{formatApiError(remove.error)}</Banner>
            </div>
          )}

          {(
            [
              [t("conversations.members.agents"), t("conversations.members.agentsHint"), t("conversations.members.addAgent"), agents, () => setAddingAgent(true)],
              [t("conversations.members.people"), t("conversations.members.peopleHint"), t("conversations.members.addPerson"), people, () => setAddingPerson(true)],
            ] as const
          ).map(([title, hint, addLabel, members, onAdd]) => (
            <section key={title} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <SectionTitle className="fg-overline text-subtle">{title}</SectionTitle>
                  <p className="fg-caption text-subtle">{hint}</p>
                </div>
                {canChange && (
                  <Button size="sm" variant="secondary" icon="plus" onClick={onAdd}>
                    {addLabel}
                  </Button>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                {members.map((member) => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    room={room}
                    canChange={canChange}
                    busy={remove.isPending}
                    onRemove={() => remove.mutate({ participantId: member.id })}
                  />
                ))}
              </div>
            </section>
          ))}
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

/** One member, in the shape its kind gets. */
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
  const t = useCopy();
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
          {isAgent ? `@${member.displayName ?? member.label}` : (member.displayName ?? t("conversations.members.unknown"))}
        </span>
        <span className="fg-caption block truncate text-subtle">
          {isAgent ? (project?.name ?? t("conversations.members.noLongerAbout")) : t("conversations.members.person")}
        </span>
      </div>
      {isAgent && member.reachable === false && (
        <Tooltip label={t("conversations.members.cantActHint")}>
          <span className="fg-caption rounded bg-surface px-1.5 py-0.5 text-muted">{t("conversations.members.cantAct")}</span>
        </Tooltip>
      )}
      {canChange && (
        <Tooltip label={removalClaim(member, room, t)}>
          <IconButton
            icon="x"
            size="sm"
            aria-label={t("conversations.members.takeOut", { name: member.displayName ?? t("conversations.members.thisMember") })}
            disabled={busy}
            onClick={onRemove}
          />
        </Tooltip>
      )}
    </div>
  );
}
