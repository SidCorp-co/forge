"use client";

// Starting a room, with whoever it starts with (ISS-1011).
//
// Until this existed a room could only be opened by a message arriving, or by
// the Forge UI opening one for exactly two participants — the person typing and
// the project's own agent. This is the second way in, and it does not replace
// the first: the adapters still open rooms exactly as they did.
//
// The room is opened when the person says start, and not when they pick a
// project, so browsing the project list leaves no empty rooms behind it.

import { personChoice } from "@forge/contracts/person-name";
import { orderPeople } from "@/lib/people/order-people";
import { useState } from "react";
import { useAuth } from "@/providers/auth-provider";
import { Button, Checkbox, ErrorState, Icon, Select, Spinner } from "@/design";
import { useOrgScopedProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useOpenConversation, useProjectCandidates, useRoomOpeners } from "../hooks";
import { candidateHeldReason, roomOpeningClaims, startsRooms, unopenableReason } from "../membership";
import type { ConversationProject, HandleCandidate } from "../types";

/** One agent chosen for a room that does not exist yet. */
type PickedHandle = { userId: string | null; projectId: string };

const sameHandle = (a: PickedHandle, b: PickedHandle) =>
  a.projectId === b.projectId && a.userId === b.userId;

export function StartConversation({ onStarted }: { onStarted: (id: string, projectId: string) => void }) {
  const { projects: visible, isLoading: projectsLoading } = useOrgScopedProjects();
  // Whose agent can answer is read before anything is offered: a project whose agent lost its role is
  // marked as Add an agent marks it, and cannot be picked (ISS-1229 r36, judge-97).
  const openersQ = useRoomOpeners(visible.some((p) => startsRooms(p.role)));
  const isLoading = projectsLoading || openersQ.isLoading;
  const opener = (id: string) => openersQ.data?.openers.find((o) => o.projectId === id);
  // A project the reader only views is not offered: core refuses the room it would open (judge-95). Nor
  // is one core has not said a room can open on, the read having failed or not named it.
  const projects = visible.filter((p) => startsRooms(p.role) && (!openersQ.data || opener(p.id)));
  const openersFailed = openersQ.isError && !openersQ.data;
  const onlyViews = projects.length === 0 && visible.length > 0;
  // Where nothing can be started, nothing here says start (the coordinator on PR #1151).
  const nothingToStart = onlyViews || (!isLoading && visible.length === 0);
  const [projectId, setProjectId] = useState("");
  const [people, setPeople] = useState<string[]>([]);
  const [handles, setHandles] = useState<PickedHandle[]>([]);
  const [confirming, setConfirming] = useState(false);
  const candidates = useProjectCandidates(projectId || undefined, !!projectId);
  const open = useOpenConversation();

  const toggle = <T,>(list: T[], value: T, same: (a: T, b: T) => boolean): T[] =>
    list.some((x) => same(x, value)) ? list.filter((x) => !same(x, value)) : [...list, value];

  const base = projects.find((p) => p.id === projectId);
  // Read again on every render: a project picked while its agent answered is not opened once it no longer
  // does, and says why where the room would have started (r36 review).
  const pickedAgent = base ? opener(base.id) : undefined;
  const pickedWhy = base && pickedAgent ? unopenableReason(pickedAgent, base.name) : null;
  const opens = Boolean(base) && !pickedWhy;
  const chosen: ConversationProject[] = handles.flatMap((h) => {
    const found = (candidates.data?.handles ?? []).find((c: HandleCandidate) =>
      sameHandle({ userId: c.userId, projectId: c.project.id }, h),
    );
    return found ? [found.project] : [];
  });
  const brought = chosen.filter((p) => p.id !== projectId);
  const scopeProjects: ConversationProject[] = [
    ...(base ? [{ id: base.id, name: base.name, slug: base.slug }] : []),
    ...brought,
  ];
  const claims = roomOpeningClaims({ projects: scopeProjects, agentCount: 1 + chosen.length });

  const start = () => {
    if (!opens) return;
    open.mutate(
      { projectId, people, handles },
      { onSuccess: (row) => onStarted(row.id, projectId) },
    );
  };

  // Until the reader's roles are read, nothing is offered: a viewer would be invited first.
  if (isLoading) {
    return (
      <div className="grid h-full min-h-0 place-items-center px-4 py-8">
        <p role="status" data-testid="start-loading" className="fg-body-sm flex items-center gap-2 text-muted">
          <Spinner size={14} /> Reading your projects…
        </p>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 place-items-center overflow-y-auto px-4 py-8">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="text-center">
          <p className="fg-h3">
            {onlyViews ? "Conversations you can read" : nothingToStart ? "No project you can see" : "Start a conversation"}
          </p>
          <p className="fg-body-sm mt-1 text-muted">
            {onlyViews
              ? "You hold the viewer role on every project here, so their conversations are yours to read from the list."
              : nothingToStart
                ? "A conversation is about a project, and this organization holds none you can see."
                : "Pick a project, and choose who else is in the room."}
          </p>
        </div>

        {!nothingToStart && openersFailed && (
          <div data-testid="start-openers-error">
            <ErrorState
              title="Couldn't read which projects a room can start on"
              message={formatApiError(openersQ.error)}
              onRetry={() => openersQ.refetch()}
            />
          </div>
        )}

        {!nothingToStart && !openersFailed && (
        <div>
          <label htmlFor="conversations-new-project" className="fg-body-sm mb-1.5 block text-muted">
            Project
          </label>
          <Select
            id="conversations-new-project"
            options={projects.map((p) => {
              const agent = opener(p.id);
              const why = agent ? unopenableReason(agent, p.name) : null;
              return why ? { value: p.id, label: p.name, detail: why, disabled: true } : { value: p.id, label: p.name };
            })}
            value={projectId}
            onChange={(v) => {
              setProjectId(v);
              setPeople([]);
              setHandles([]);
              setConfirming(false);
            }}
            placeholder="Select a project…"
          />
          {pickedWhy && (
            <p className="fg-caption mt-1 text-muted" data-testid="start-unopenable">
              {pickedWhy}
            </p>
          )}
          {opens && (
            <p className="fg-caption mt-1 text-subtle">
              The room starts with this project&apos;s own agent, and is about this project.
            </p>
          )}
        </div>
        )}

        {opens && !confirming && (
          <Extras
            query={candidates}
            people={people}
            handles={handles}
            onTogglePerson={(id) => setPeople((l) => toggle(l, id, (a, b) => a === b))}
            onToggleHandle={(h) => setHandles((l) => toggle(l, h, sameHandle))}
          />
        )}

        {opens && confirming && (
          <ul className="flex flex-col gap-2" data-testid="start-confirmation">
            {claims.map((claim) => (
              <li key={claim.key} data-claim={claim.key} className="fg-body-sm text-fg">
                {claim.text}
              </li>
            ))}
          </ul>
        )}

        {open.isError && (
          <p className="fg-body-sm text-[color:var(--red-600)]" data-testid="start-error">
            {formatApiError(open.error)}
          </p>
        )}

        {opens && !confirming && (
          <Button variant="primary" onClick={() => setConfirming(true)}>
            Start the room
          </Button>
        )}

        {opens && confirming && (
          <div className="flex items-center justify-end gap-2.5">
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={open.isPending}>
              Back
            </Button>
            <Button variant="primary" loading={open.isPending} onClick={start}>
              Open the room
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Extras({
  query,
  people,
  handles,
  onTogglePerson,
  onToggleHandle,
}: {
  query: ReturnType<typeof useProjectCandidates>;
  people: string[];
  handles: PickedHandle[];
  onTogglePerson: (userId: string) => void;
  onToggleHandle: (h: PickedHandle) => void;
}) {
  const viewerId = useAuth().user?.id ?? null;
  if (query.isLoading) {
    return (
      <p role="status" data-testid="start-candidates-loading" className="fg-body-sm text-muted">
        <Spinner size={14} /> Looking for who you can add…
      </p>
    );
  }
  if (query.isError) {
    return (
      <div data-testid="start-candidates-error">
        <ErrorState
          title="Couldn't load who you can add"
          message={formatApiError(query.error)}
          onRetry={() => query.refetch()}
        />
      </div>
    );
  }
  const raw = query.data;
  // The opener is in the room by opening it: listed once, as "You", and never offered as someone
  // else to add (ISS-1229 r25, judge-72).
  const data = raw
    ? { ...raw, people: orderPeople(raw.people.filter((p) => p.userId !== viewerId), viewerId) }
    : raw;
  if (!data || (data.people.length === 0 && data.handles.length === 0)) {
    return (
      <p role="status" data-testid="start-candidates-empty" className="fg-body-sm text-subtle">
        There is nobody else you can add to a room in this project. It will start with you and the
        project&apos;s own agent.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {data.handles.length > 0 && (
        <div>
          <p className="fg-overline text-subtle">Agents — what the room can see</p>
          <div className="mt-1 flex flex-col gap-1">
            {data.handles.map((h) => {
              const held = candidateHeldReason(h);
              return (
              <div key={`${h.userId ?? "unminted"}:${h.project.id}`}>
                <Checkbox
                  checked={handles.some((x) => sameHandle(x, { userId: h.userId, projectId: h.project.id }))}
                  disabled={held !== null}
                  onChange={() => onToggleHandle({ userId: h.userId, projectId: h.project.id })}
                  label={
                    <span className="flex items-center gap-1.5">
                      <Icon name="agent" size={13} className="text-[color:var(--accent-text)]" />
                      <span className="font-mono">@{h.handle}</span>
                      <span className="fg-caption text-muted">{h.project.name}</span>
                    </span>
                  }
                />
                {held && (
                  <p className="fg-caption ml-[28px] text-muted" data-testid="start-held-reason">{held}</p>
                )}
              </div>
              );
            })}
          </div>
        </div>
      )}
      {data.people.length > 0 && (
        <div>
          <p className="fg-overline text-subtle">People — who reads the room</p>
          <div className="mt-1 flex flex-col gap-1">
            <Checkbox checked disabled onChange={() => {}} label={<span data-person-label>You</span>} />
            {data.people.map((p) => (
              <Checkbox
                key={p.userId}
                checked={people.includes(p.userId)}
                onChange={() => onTogglePerson(p.userId)}
                label={<PersonChoice displayName={p.displayName} email={p.email} />}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A person offered for the room: by name, with the address that tells two alike apart (ISS-1229 r21). */
function PersonChoice({ displayName, email }: { displayName: string | null; email: string }) {
  const { label, detail } = personChoice(displayName, email);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2">
      <span data-person-label>{label}</span>
      <span className="fg-caption min-w-0 break-all text-muted" data-person-detail>{detail}</span>
    </span>
  );
}
