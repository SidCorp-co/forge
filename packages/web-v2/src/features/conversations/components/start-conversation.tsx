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

import { useState } from "react";
import { Button, Checkbox, ErrorState, Icon, Select, Spinner } from "@/design";
import { useOrgScopedProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useOpenConversation, useProjectCandidates } from "../hooks";
import { roomOpeningClaims } from "../membership";
import type { ConversationProject, HandleCandidate } from "../types";

/** One agent chosen for a room that does not exist yet. */
type PickedHandle = { userId: string | null; projectId: string };

const sameHandle = (a: PickedHandle, b: PickedHandle) =>
  a.projectId === b.projectId && a.userId === b.userId;

export function StartConversation({ onStarted }: { onStarted: (id: string, projectId: string) => void }) {
  const { projects } = useOrgScopedProjects();
  const [projectId, setProjectId] = useState("");
  const [people, setPeople] = useState<string[]>([]);
  const [handles, setHandles] = useState<PickedHandle[]>([]);
  const [confirming, setConfirming] = useState(false);
  const candidates = useProjectCandidates(projectId || undefined, !!projectId);
  const open = useOpenConversation();

  const toggle = <T,>(list: T[], value: T, same: (a: T, b: T) => boolean): T[] =>
    list.some((x) => same(x, value)) ? list.filter((x) => !same(x, value)) : [...list, value];

  // cm:guard the base project is counted as ONE agent whether or not it was picked from the list, because the room always opens with its own handle: a projection that counted only the ticked boxes would call a two-project room one-to-one and promise a privacy the room will not have (ISS-1011).
  const base = projects.find((p) => p.id === projectId);
  const chosen: ConversationProject[] = handles.flatMap((h) => {
    const found = (candidates.data?.handles ?? []).find((c: HandleCandidate) =>
      sameHandle({ userId: c.userId, projectId: c.project.id }, h),
    );
    return found ? [found.project] : [];
  });
  // cm:guard an agent for the room's OWN project is discounted on both counts, and core no longer offers one — this is the client half of the same rule, for a tab holding a candidate list from before that fix. Counting it would add a handle the room will not have, and the sentence built on that count promises a shared room where a one-to-one room is what opens (ISS-1011).
  const brought = chosen.filter((p) => p.id !== projectId);
  const scopeProjects: ConversationProject[] = [
    ...(base ? [{ id: base.id, name: base.name, slug: base.slug }] : []),
    ...brought,
  ];
  const claims = roomOpeningClaims({ projects: scopeProjects, agentCount: 1 + brought.length });

  const start = () => {
    if (!projectId) return;
    open.mutate(
      { projectId, people, handles },
      { onSuccess: (row) => onStarted(row.id, projectId) },
    );
  };

  return (
    <div className="grid h-full min-h-0 place-items-center overflow-y-auto px-4 py-8">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="text-center">
          <p className="fg-h3">Start a conversation</p>
          <p className="fg-body-sm mt-1 text-muted">
            Pick a project, and choose who else is in the room.
          </p>
        </div>

        <div>
          <label htmlFor="conversations-new-project" className="fg-body-sm mb-1.5 block text-muted">
            Project
          </label>
          <Select
            id="conversations-new-project"
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
            value={projectId}
            onChange={(v) => {
              setProjectId(v);
              setPeople([]);
              setHandles([]);
              setConfirming(false);
            }}
            placeholder="Select a project…"
          />
          {projectId && (
            <p className="fg-caption mt-1 text-subtle">
              The room starts with this project&apos;s own agent, and is about this project.
            </p>
          )}
        </div>

        {projectId && !confirming && (
          <Extras
            query={candidates}
            people={people}
            handles={handles}
            onTogglePerson={(id) => setPeople((l) => toggle(l, id, (a, b) => a === b))}
            onToggleHandle={(h) => setHandles((l) => toggle(l, h, sameHandle))}
          />
        )}

        {confirming && (
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

        {projectId && !confirming && (
          <Button variant="primary" onClick={() => setConfirming(true)}>
            Start the room
          </Button>
        )}

        {confirming && (
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
  // cm:guard the agents and the people render as two lists, here as everywhere else in this feature: choosing an agent changes what the room can see and choosing a colleague changes who reads it, and one list of both would make the larger act look like the smaller (ISS-1011 criterion 14).
  const data = query.data;
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
            {data.handles.map((h) => (
              <Checkbox
                key={`${h.userId ?? "unminted"}:${h.project.id}`}
                checked={handles.some((x) => sameHandle(x, { userId: h.userId, projectId: h.project.id }))}
                onChange={() => onToggleHandle({ userId: h.userId, projectId: h.project.id })}
                label={
                  <span className="flex items-center gap-1.5">
                    <Icon name="agent" size={13} className="text-[color:var(--accent-text)]" />
                    <span className="font-mono">@{h.handle}</span>
                    <span className="fg-caption text-muted">{h.project.name}</span>
                  </span>
                }
              />
            ))}
          </div>
        </div>
      )}
      {data.people.length > 0 && (
        <div>
          <p className="fg-overline text-subtle">People — who reads the room</p>
          <div className="mt-1 flex flex-col gap-1">
            {data.people.map((p) => (
              <Checkbox
                key={p.userId}
                checked={people.includes(p.userId)}
                onChange={() => onTogglePerson(p.userId)}
                label={p.displayName ?? p.email}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
