"use client";

// Adding a member to a room: pick one, then read what the addition does (ISS-1011).
//
// An agent and a person stay two controls behind two buttons, and the separation is the point: a
// person changes who reads the room, an agent changes what the room can see, and one combobox serving
// both makes a scope change look like an invitation. What the two share is the shape — a candidate
// list, then the claims in `membership.ts`, each a fact about what the code does. Removal is named
// there as a narrowing and never as an undo, because it is not one; and in a shared room the person
// claims say so rather than claiming an access change that did not happen.

import { type ReactNode, useState } from "react";
import { Avatar, Banner, Button, ErrorState, Icon, SlideOver, Spinner } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { useAddHandle, useAddPerson, useConversationCandidates } from "../hooks";
import { agentAdditionClaims, initialsOf, type MembershipClaim, personAdditionClaims } from "../membership";
import type { ConversationCandidates, ConversationMembership, HandleCandidate, PersonCandidate } from "../types";

type Room = Partial<Pick<ConversationMembership, "shape" | "scopeProjects" | "participants">>;

interface DialogProps {
  conversationId: string;
  room: Room;
  open: boolean;
  onClose: () => void;
}

/** What differs between adding an agent and adding a person: the words, the rows, the claims. */
interface MemberKind<T> {
  id: "agent" | "person";
  title: ProductCopyKey;
  /** The lines the list says while it loads, when it fails and when it is empty. */
  loading: ProductCopyKey;
  failed: ProductCopyKey;
  empty: ProductCopyKey;
  candidates: (data: ConversationCandidates) => T[];
  key: (c: T) => string;
  label: (c: T) => string;
  rowClass: string;
  row: (c: T) => ReactNode;
  head: (c: T) => ReactNode;
  claims: (c: T, room: Room, t: Copy) => MembershipClaim[];
}

interface AddMutation<T> {
  add: (c: T, onSuccess: () => void) => void;
  reset: () => void;
  isPending: boolean;
  isError: boolean;
  error: unknown;
}

const nameOf = (p: PersonCandidate): string => p.displayName ?? p.email;

const AGENT: MemberKind<HandleCandidate> = {
  id: "agent",
  title: "conversations.add.agentTitle",
  loading: "conversations.add.agentLoading",
  failed: "conversations.add.agentFailed",
  empty: "conversations.add.agentEmpty",
  candidates: (data) => data.handles,
  key: (h) => `${h.userId ?? "unminted"}:${h.project.id}`,
  label: (h) => `@${h.handle}`,
  rowClass: "border border-line",
  row: (h) => (
    <>
      <Icon name="agent" size={15} className="flex-none text-[color:var(--accent-text)]" />
      <span className="fg-body-sm font-mono">@{h.handle}</span>
      <span className="fg-caption ml-auto text-muted">{h.project.name}</span>
    </>
  ),
  head: (h) => (
    <div className="flex items-center gap-2 rounded-md border border-[color:var(--accent)] bg-[color:var(--accent-tint)] px-3 py-2">
      <Icon name="agent" size={15} className="flex-none text-[color:var(--accent-text)]" />
      <span className="fg-label font-mono">@{h.handle}</span>
      <span className="fg-caption ml-auto text-muted">{h.project.name}</span>
    </div>
  ),
  claims: (candidate, room, t) => agentAdditionClaims({ candidate, room, t }),
};

const PERSON: MemberKind<PersonCandidate> = {
  id: "person",
  title: "conversations.add.personTitle",
  loading: "conversations.add.personLoading",
  failed: "conversations.add.personFailed",
  empty: "conversations.add.personEmpty",
  candidates: (data) => data.people,
  key: (p) => p.userId,
  label: nameOf,
  rowClass: "",
  row: (p) => (
    <>
      <Icon name="users" size={15} className="flex-none text-subtle" />
      <span className="fg-body-sm">{nameOf(p)}</span>
      <span className="fg-caption ml-auto text-muted">{p.email}</span>
    </>
  ),
  head: (p) => (
    <div className="flex items-center gap-2 px-1 py-2">
      <Avatar initials={initialsOf(nameOf(p))} size={22} />
      <span className="fg-label">{nameOf(p)}</span>
      <span className="fg-caption ml-auto text-muted">{p.email}</span>
    </div>
  ),
  claims: (p, room, t) => personAdditionClaims({ name: nameOf(p), room, t }),
};

export function AddAgentDialog(props: DialogProps) {
  const m = useAddHandle(props.conversationId);
  const add = (h: HandleCandidate, onSuccess: () => void) =>
    m.mutate({ userId: h.userId, projectId: h.project.id }, { onSuccess });
  return <AddMemberDialog {...props} kind={AGENT} mutation={{ ...m, add }} />;
}

export function AddPersonDialog(props: DialogProps) {
  const m = useAddPerson(props.conversationId);
  const add = (p: PersonCandidate, onSuccess: () => void) => m.mutate({ userId: p.userId }, { onSuccess });
  return <AddMemberDialog {...props} kind={PERSON} mutation={{ ...m, add }} />;
}

function AddMemberDialog<T>({
  conversationId,
  room,
  open,
  onClose,
  kind,
  mutation,
}: DialogProps & { kind: MemberKind<T>; mutation: AddMutation<T> }) {
  const t = useCopy();
  const [picked, setPicked] = useState<T | null>(null);
  const candidates = useConversationCandidates(conversationId, open);

  const close = () => {
    setPicked(null);
    mutation.reset();
    onClose();
  };

  return (
    <SlideOver open={open} onClose={close} title={t(kind.title)} width={460}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        {picked ? (
          <div data-testid={`add-${kind.id}-confirmation`} className="flex flex-col gap-3">
            {kind.head(picked)}
            <ul className="flex flex-col gap-2">
              {kind.claims(picked, room, t).map((claim) => (
                <li key={claim.key} data-claim={claim.key} className="fg-body-sm text-fg">
                  {claim.text}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <CandidateList kind={kind} query={candidates} onPick={setPicked} />
        )}

        {mutation.isError && (
          <div data-testid={`add-${kind.id}-error`} role="status">
            <Banner tone="danger">{formatApiError(mutation.error)}</Banner>
          </div>
        )}

        {picked && (
          <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
            <Button variant="ghost" onClick={() => setPicked(null)} disabled={mutation.isPending}>
              {t("conversations.add.back")}
            </Button>
            <Button variant="primary" loading={mutation.isPending} onClick={() => mutation.add(picked, close)}>
              {t("conversations.add.confirm", { label: kind.label(picked) })}
            </Button>
          </div>
        )}
      </div>
    </SlideOver>
  );
}

function CandidateList<T>({
  kind,
  query,
  onPick,
}: {
  kind: MemberKind<T>;
  query: ReturnType<typeof useConversationCandidates>;
  onPick: (c: T) => void;
}) {
  const t = useCopy();
  if (query.isLoading) {
    return (
      <p role="status" data-testid={`${kind.id}-candidates-loading`} className="fg-body-sm text-muted">
        <Spinner size={14} /> {t(kind.loading)}
      </p>
    );
  }
  if (query.isError) {
    return (
      <div data-testid={`${kind.id}-candidates-error`}>
        <ErrorState
          title={t(kind.failed)}
          message={formatApiError(query.error)}
          onRetry={() => query.refetch()}
        />
      </div>
    );
  }
  const list = query.data ? kind.candidates(query.data) : [];
  if (list.length === 0) {
    return (
      <p role="status" data-testid={`${kind.id}-candidates-empty`} className="fg-body-sm text-muted">
        {t(kind.empty)}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {list.map((c) => (
        <li key={kind.key(c)}>
          <button
            type="button"
            onClick={() => onPick(c)}
            className={`flex w-full items-center gap-2 rounded-md ${kind.rowClass} px-3 py-2 text-left hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]`}
          >
            {kind.row(c)}
          </button>
        </li>
      ))}
    </ul>
  );
}
