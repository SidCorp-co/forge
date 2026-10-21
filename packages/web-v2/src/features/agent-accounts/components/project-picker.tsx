"use client";

// A long list inside a form is searched, not scrolled: the picker opens on the projects already chosen
// and a search field, and shows the ones that match what was typed. An organization with two dozen
// projects costs the form one line until a person asks for them.
import { useId, useState } from "react";
import { Button, Checkbox, Icon, Input } from "@/design";

export interface PickableProject {
  id: string;
  name: string;
}

export interface ProjectPickerProps {
  projects: readonly PickableProject[];
  picked: readonly string[];
  onToggle: (projectId: string) => void;
}

export function ProjectPicker({ projects, picked, onToggle }: ProjectPickerProps) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const listId = useId();

  const needle = query.trim().toLowerCase();
  const chosen = picked.flatMap((id) => projects.find((p) => p.id === id) ?? []);
  const open = needle !== "" || showAll;
  const matches = needle === "" ? projects : projects.filter((p) => p.name.toLowerCase().includes(needle));

  return (
    <div className="flex flex-col gap-2.5">
      <ul aria-label="Chosen projects" className="flex min-h-7 list-none flex-wrap items-center gap-1.5 p-0">
        {chosen.length === 0 && <li className="fg-body-sm text-muted">No project chosen yet.</li>}
        {chosen.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              aria-label={`Remove ${p.name}`}
              onClick={() => onToggle(p.id)}
              className="inline-flex min-h-7 items-center gap-1 rounded-pill bg-sunken px-2.5 text-13 text-fg hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
              {p.name}
              <Icon name="x" size={12} className="text-subtle" />
            </button>
          </li>
        ))}
      </ul>

      <Input
        icon="search"
        aria-label="Search projects"
        aria-controls={open ? listId : undefined}
        placeholder={`Search ${projects.length} projects`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {open ? (
        <div id={listId} className="max-h-48 overflow-y-auto rounded-md border border-line-subtle px-3 py-2">
          {matches.length === 0 ? (
            <p className="fg-body-sm text-muted">No project matches “{query.trim()}”.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {matches.map((p) => (
                <Checkbox key={p.id} label={p.name} checked={picked.includes(p.id)} onChange={() => onToggle(p.id)} />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {needle === "" && (
        <div>
          <Button variant="ghost" size="sm" aria-expanded={showAll} onClick={() => setShowAll((all) => !all)}>
            {showAll ? "Hide the list" : `Show all ${projects.length}`}
          </Button>
        </div>
      )}
    </div>
  );
}
