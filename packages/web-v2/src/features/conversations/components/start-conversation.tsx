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

export function StartConversation({ onStarted }: { onStarted: (id: string, projectId: string) => void }) {
  const { projects } = useOrgScopedProjects();
  const [projectId, setProjectId] = useState("");
  const [people, setPeople] = useState<string[]>([]);
  const [handles, setHandles] = useState<Array<{ userId: string; projectId: string }>>([]);
  const candidates = useProjectCandidates(projectId || undefined, !!projectId);
  const open = useOpenConversation();

  const toggle = <T,>(list: T[], value: T, same: (a: T, b: T) => boolean): T[] =>
    list.some((x) => same(x, value)) ? list.filter((x) => !same(x, value)) : [...list, value];

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
            }}
            placeholder="Select a project…"
          />
          {projectId && (
            <p className="fg-caption mt-1 text-subtle">
              The room starts with this project&apos;s own agent, and is about this project.
            </p>
          )}
        </div>

        {projectId && <Extras query={candidates} people={people} handles={handles}
          onTogglePerson={(id) => setPeople((l) => toggle(l, id, (a, b) => a === b))}
          onToggleHandle={(h) => setHandles((l) => toggle(l, h, (a, b) => a.userId === b.userId))}
        />}

        {open.isError && (
          <p className="fg-body-sm text-[color:var(--red-600)]" data-testid="start-error">
            {formatApiError(open.error)}
          </p>
        )}

        {projectId && (
          <Button variant="primary" loading={open.isPending} onClick={start}>
            Start the room
          </Button>
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
  handles: Array<{ userId: string; projectId: string }>;
  onTogglePerson: (userId: string) => void;
  onToggleHandle: (h: { userId: string; projectId: string }) => void;
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
                key={h.userId}
                checked={handles.some((x) => x.userId === h.userId)}
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
