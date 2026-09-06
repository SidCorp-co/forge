"use client";

// One stage's `allowedTools` or `disallowedTools`, as removable chips plus two
// ways to add: pick an id already in use elsewhere in this config, or type a
// raw one. Grouped by MCP server, same grouping the read-only display uses.
//
// There is no canonical registry of Claude Code tool ids anywhere in this repo
// — builtins come from the CLI and MCP ids from whatever servers a job gets —
// so `options` is seeded from what the project already writes rather than from
// a hardcoded catalog that would drift in silence.

import { useState } from "react";
import { Button, Icon, Input, Select } from "@/design";
import { groupByServer, humanizeToolName } from "../types";

export function ToolListEditor({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string[];
  /** Ids offered by the picker; the ones already chosen are filtered out. */
  options: string[];
  onChange: (next: string[]) => void;
}) {
  const [picked, setPicked] = useState("");
  const [typed, setTyped] = useState("");

  const chosen = new Set(value);
  const offer = options.filter((o) => !chosen.has(o));

  function add(raw: string) {
    const id = raw.trim();
    if (!id || chosen.has(id)) return;
    onChange([...value, id]);
  }

  return (
    <div>
      <p className="fg-caption mb-1 text-muted">{label}</p>
      {hint && <p className="fg-caption mb-1.5 text-subtle">{hint}</p>}

      {value.length === 0 ? (
        <p className="fg-body-sm text-muted">
          Nothing listed — this stage uses the default tool surface.
        </p>
      ) : (
        <div className="space-y-1.5">
          {groupByServer(value).map(([server, tools]) => (
            <div key={server}>
              <p className="fg-caption text-subtle">{server}</p>
              <div className="flex flex-wrap gap-1.5">
                {tools.map((raw) => {
                  const { label: name } = humanizeToolName(raw);
                  return (
                    <button
                      key={raw}
                      type="button"
                      title={raw}
                      aria-label={`Remove ${name}`}
                      onClick={() => onChange(value.filter((t) => t !== raw))}
                      className="fg-caption inline-flex max-w-full items-center gap-1 truncate rounded-pill border border-line px-2 py-0.5 text-muted hover:border-accent-text hover:text-accent-text"
                    >
                      <span className="truncate">{name}</span>
                      <Icon name="x" size={11} />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        {offer.length > 0 && (
          <div className="flex flex-1 gap-2">
            <Select
              options={offer.map((o) => ({
                value: o,
                label: humanizeToolName(o).label,
              }))}
              value={picked}
              onChange={setPicked}
              placeholder="Pick a tool in use elsewhere…"
              aria-label={`Pick a tool already in use to add to ${label}`}
              className="flex-1"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!picked}
              onClick={() => {
                add(picked);
                setPicked("");
              }}
            >
              Add
            </Button>
          </div>
        )}
        <div className="flex flex-1 gap-2">
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              add(typed);
              setTyped("");
            }}
            placeholder="…or type an id, e.g. mcp__forge__forge_issues"
            aria-label={`Add a tool id to ${label}`}
            className="flex-1"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!typed.trim()}
            onClick={() => {
              add(typed);
              setTyped("");
            }}
          >
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}
