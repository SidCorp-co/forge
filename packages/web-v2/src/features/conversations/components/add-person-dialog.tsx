"use client";

// Adding a colleague to a room: who reads it changes, and what it can see does
// not.
//
// ISS-1011 — deliberately a different component reached by a different button
// from `add-agent-dialog.tsx`. What it says is smaller because what it does is
// smaller, and in a shared room it says so rather than claiming an access
// change that did not happen.

import { useState } from "react";
import { Avatar, Banner, Button, ErrorState, Icon, SlideOver, Spinner } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useAddPerson, useConversationCandidates } from "../hooks";
import { initialsOf, personAdditionClaims } from "../membership";
import type { ConversationMembership, PersonCandidate } from "../types";

const nameOf = (person: PersonCandidate): string => person.displayName ?? person.email;

export function AddPersonDialog({
  conversationId,
  room,
  open,
  onClose,
}: {
  conversationId: string;
  room: Partial<Pick<ConversationMembership, "shape" | "scopeProjects">>;
  open: boolean;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<PersonCandidate | null>(null);
  const candidates = useConversationCandidates(conversationId, open);
  const add = useAddPerson(conversationId);

  const close = () => {
    setPicked(null);
    add.reset();
    onClose();
  };

  // cm:guard the same rule the agent dialogue follows: a refused add keeps the dialogue open and keeps the selection, because the refusal names the project the person holds no role on and that is what the adder has to act on (ISS-1011 criteria 42, 47).
  const confirm = () => {
    if (!picked) return;
    add.mutate({ userId: picked.userId }, { onSuccess: close });
  };

  return (
    <SlideOver open={open} onClose={close} title="Add a person" width={460}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        {picked ? (
          <Confirmation person={picked} room={room} />
        ) : (
          <CandidateList query={candidates} onPick={setPicked} />
        )}

        {add.isError && (
          <div data-testid="add-person-error" role="status">
            <Banner tone="danger">{formatApiError(add.error)}</Banner>
          </div>
        )}

        {picked && (
          <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
            <Button variant="ghost" onClick={() => setPicked(null)} disabled={add.isPending}>
              Back
            </Button>
            <Button variant="primary" loading={add.isPending} onClick={confirm}>
              Add {nameOf(picked)}
            </Button>
          </div>
        )}
      </div>
    </SlideOver>
  );
}

function Confirmation({
  person,
  room,
}: {
  person: PersonCandidate;
  room: Partial<Pick<ConversationMembership, "shape" | "scopeProjects">>;
}) {
  const claims = personAdditionClaims({ name: nameOf(person), room });
  return (
    <div data-testid="add-person-confirmation" className="flex flex-col gap-3">
      <div className="flex items-center gap-2 px-1 py-2">
        <Avatar initials={initialsOf(nameOf(person))} size={22} />
        <span className="fg-label">{nameOf(person)}</span>
        <span className="fg-caption ml-auto text-muted">{person.email}</span>
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
  onPick: (p: PersonCandidate) => void;
}) {
  if (query.isLoading) {
    return (
      <p role="status" data-testid="person-candidates-loading" className="fg-body-sm text-muted">
        <Spinner size={14} /> Looking for people you can add…
      </p>
    );
  }
  if (query.isError) {
    return (
      <div data-testid="person-candidates-error">
        <ErrorState
          title="Couldn't load the people"
          message={formatApiError(query.error)}
          onRetry={() => query.refetch()}
        />
      </div>
    );
  }
  const people = query.data?.people ?? [];
  if (people.length === 0) {
    return (
      <p role="status" data-testid="person-candidates-empty" className="fg-body-sm text-muted">
        There is nobody left to add. A person joins a room only if they already hold a role on every
        project it is about.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {people.map((person) => (
        <li key={person.userId}>
          <button
            type="button"
            onClick={() => onPick(person)}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <Icon name="users" size={15} className="flex-none text-subtle" />
            <span className="fg-body-sm">{nameOf(person)}</span>
            <span className="fg-caption ml-auto text-muted">{person.email}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
