"use client";

// Project settings → Pipeline → "Session groups" (ISS-494).
//
// A session group makes several pipeline stages share ONE Claude CLI session
// (resumed via `--resume`, keyed by `(issueId, sessionGroup)`), so context
// carries across stages instead of every stage starting cold.
//
// Two representations that MUST stay in sync (see project memory
// `pipeline-config/sessionGroups-dual-representation-and-shallow-merge`):
//   1. top-level `sessionGroups: Record<group, status[]>` — a DECLARATION.
//   2. per-state `states[<status>].sessionGroup` — the ONLY thing the
//      dispatcher reads for continuity.
// Editing the map alone is a runtime no-op, so on save this writes BOTH and
// resends the FULL `states` map (the PATCH merge is shallow / wholesale-replace
// at the `states` key). Mirrors the save-island contract of
// `mcp-servers-section.tsx`: takes the full fetched config, edits its slice,
// spreads `...config` on save so sibling keys (toggles, mcpServers) survive.

import { useEffect, useMemo, useState } from "react";
import { Banner, Button, Icon, Input, Select } from "@/design";
import { formatPipelineConfigError } from "@/lib/api/error";
import { useUpdatePipelineConfig } from "../hooks";
import {
  CODE_STATUS,
  FIX_STATUS,
  ON_RESUME_FAIL_OPTIONS,
  SESSION_GROUP_STAGES,
  SUGGESTED_SESSION_GROUPS,
  sessionGroupStageLabel,
  validateSessionGroups,
  type PipelineConfig,
} from "../types";

type GroupDraft = { name: string; members: string[] };
type ResumePolicy = "fresh" | "abort" | "";

type StatesMap = Record<string, Record<string, unknown>>;

function asStates(config: PipelineConfig): StatesMap {
  const s = config.states;
  return s && typeof s === "object" ? (s as StatesMap) : {};
}

/** Pipeline-order index for stable member ordering. */
const STATUS_ORDER = new Map(SESSION_GROUP_STAGES.map((s, i) => [s.status, i]));
function sortMembers(members: string[]): string[] {
  return [...members].sort(
    (a, b) => (STATUS_ORDER.get(a) ?? 99) - (STATUS_ORDER.get(b) ?? 99),
  );
}

/**
 * Seed the editor from the runtime source of truth: `states[x].sessionGroup`
 * bindings drive membership; declared `sessionGroups` keys/members are unioned
 * in so empty or drifted declarations stay visible (and thus removable/fixable)
 * rather than being silently dropped.
 */
function seedGroups(config: PipelineConfig): GroupDraft[] {
  const byName = new Map<string, string[]>();
  const add = (name: string, status?: string) => {
    const arr = byName.get(name) ?? [];
    if (status && !arr.includes(status)) arr.push(status);
    byName.set(name, arr);
  };

  const declared =
    config.sessionGroups && typeof config.sessionGroups === "object" ? config.sessionGroups : {};
  for (const name of Object.keys(declared)) add(name);

  for (const [status, st] of Object.entries(asStates(config))) {
    const sg = st?.sessionGroup;
    if (typeof sg === "string" && sg.length > 0) add(sg, status);
  }
  for (const [name, members] of Object.entries(declared)) {
    if (Array.isArray(members)) for (const m of members) if (typeof m === "string") add(name, m);
  }

  return [...byName.entries()].map(([name, members]) => ({ name, members: sortMembers(members) }));
}

/** Stable serialization for the dirty check (ignores member order / group order). */
function snapshot(groups: GroupDraft[], policy: ResumePolicy): string {
  const norm = [...groups]
    .map((g) => ({ name: g.name.trim(), members: sortMembers(g.members) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify({ norm, policy });
}

export function SessionGroupsSection({
  projectId,
  config,
  canEdit,
}: {
  projectId: string;
  /** The full server-fetched pipelineConfig (round-tripped on save). */
  config: PipelineConfig;
  canEdit: boolean;
}) {
  const update = useUpdatePipelineConfig(projectId);

  const seeded = useMemo(() => seedGroups(config), [config]);
  const seededPolicy: ResumePolicy =
    config.onResumeFail === "fresh" || config.onResumeFail === "abort" ? config.onResumeFail : "";

  const [groups, setGroups] = useState<GroupDraft[]>(seeded);
  const [policy, setPolicy] = useState<ResumePolicy>(seededPolicy);
  const [newName, setNewName] = useState("");
  useEffect(() => {
    setGroups(seedGroups(config));
    setPolicy(seededPolicy);
    // seededPolicy derives from config; config is the only real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  const initial = useMemo(() => snapshot(seeded, seededPolicy), [seeded, seededPolicy]);
  const dirty = snapshot(groups, policy) !== initial;

  const recordForValidation = useMemo(() => {
    const r: Record<string, string[]> = {};
    for (const g of groups) r[g.name.trim()] = g.members;
    return r;
  }, [groups]);
  const duplicateName =
    new Set(groups.map((g) => g.name.trim())).size !== groups.length;
  const errors = useMemo(() => {
    const base = validateSessionGroups(recordForValidation);
    return duplicateName && !base.some((e) => e.includes("Duplicate"))
      ? ["Group names must be unique.", ...base]
      : base;
  }, [recordForValidation, duplicateName]);

  function toggleMember(groupIdx: number, status: string) {
    setGroups((gs) =>
      gs.map((g, i) => {
        if (i === groupIdx) {
          const has = g.members.includes(status);
          return {
            ...g,
            members: has ? g.members.filter((s) => s !== status) : sortMembers([...g.members, status]),
          };
        }
        // Enforce single-group membership: remove from any other group.
        return { ...g, members: g.members.filter((s) => s !== status) };
      }),
    );
  }

  function renameGroup(idx: number, name: string) {
    setGroups((gs) => gs.map((g, i) => (i === idx ? { ...g, name } : g)));
  }

  function removeGroup(idx: number) {
    setGroups((gs) => gs.filter((_, i) => i !== idx));
  }

  function addGroup() {
    const name = newName.trim();
    if (!name) return;
    setGroups((gs) => [...gs, { name, members: [] }]);
    setNewName("");
  }

  function applySuggested() {
    setGroups(
      Object.entries(SUGGESTED_SESSION_GROUPS).map(([name, members]) => ({
        name,
        members: sortMembers(members),
      })),
    );
  }

  function save() {
    // Drop empty / unnamed groups (schema requires ≥1 member, names 1-64).
    const clean = groups
      .map((g) => ({ name: g.name.trim(), members: g.members }))
      .filter((g) => g.name.length > 0 && g.members.length > 0);

    const nextGroups: Record<string, string[]> = {};
    const statusToGroup = new Map<string, string>();
    for (const g of clean) {
      nextGroups[g.name] = sortMembers(g.members);
      for (const s of g.members) statusToGroup.set(s, g.name);
    }

    // Full states resend: set sessionGroup on members, delete it everywhere
    // else (so the backend superRefine never sees a dangling reference).
    const nextStates: StatesMap = {};
    for (const [status, st] of Object.entries(asStates(config))) {
      const base: Record<string, unknown> = st && typeof st === "object" ? { ...st } : {};
      const grp = statusToGroup.get(status);
      if (grp) base.sessionGroup = grp;
      else delete base.sessionGroup;
      nextStates[status] = base;
    }
    // A grouped status with no stored states entry still needs its binding.
    for (const [status, grp] of statusToGroup) {
      if (!(status in nextStates)) nextStates[status] = { sessionGroup: grp };
    }

    const next: PipelineConfig = {
      ...config,
      states: nextStates,
      // Always send the map (even `{}`) so removing every group actually clears
      // it — an omitted key would be kept by the shallow PATCH merge.
      sessionGroups: nextGroups,
      onResumeFail: policy || undefined,
    };
    update.mutate(next);
  }

  const saveDisabled = !dirty || errors.length > 0 || update.isPending;

  return (
    <div className="mt-6 border-t border-line pt-5">
      <h3 className="fg-label text-fg">Session groups</h3>
      <p className="fg-body-sm mb-3 text-muted">
        Group pipeline stages so their jobs share one Claude session (resumed via{" "}
        <code className="font-mono text-[12px]">--resume</code>) for one issue. Resume pins the later
        stage to the <strong>same device</strong> as the earlier one; if that device is gone it falls
        back to a fresh session.
      </p>

      {groups.length === 0 ? (
        <div className="rounded-md border border-line bg-sunken px-3 py-3">
          <p className="fg-body-sm text-muted">
            No session groups — <strong>each stage runs in its own isolated Claude session</strong>.
            Add a group (or apply the suggested default) to let stages resume one shared session.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g, idx) => {
            const codeFixClash = g.members.includes(CODE_STATUS) && g.members.includes(FIX_STATUS);
            return (
              <div key={idx} className="rounded-md border border-line bg-surface p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  {canEdit ? (
                    <Input
                      value={g.name}
                      onChange={(e) => renameGroup(idx, e.target.value)}
                      placeholder="Group name"
                      maxLength={64}
                      className="max-w-56"
                      aria-label={`Group ${idx + 1} name`}
                    />
                  ) : (
                    <p className="fg-label font-mono text-fg">{g.name || "(unnamed)"}</p>
                  )}
                  {canEdit && (
                    <Button variant="ghost" size="sm" onClick={() => removeGroup(idx)}>
                      Remove
                    </Button>
                  )}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {SESSION_GROUP_STAGES.map((s) => {
                    const selected = g.members.includes(s.status);
                    if (!canEdit) {
                      return selected ? (
                        <span
                          key={s.status}
                          className="fg-caption rounded-pill bg-sunken px-2 py-0.5 text-fg"
                        >
                          {s.label}
                        </span>
                      ) : null;
                    }
                    return (
                      <button
                        key={s.status}
                        type="button"
                        onClick={() => toggleMember(idx, s.status)}
                        aria-pressed={selected}
                        className={
                          selected
                            ? "fg-caption rounded-pill border border-accent-text bg-accent-tint px-2 py-0.5 text-accent-text"
                            : "fg-caption rounded-pill border border-line px-2 py-0.5 text-muted hover:border-accent-text"
                        }
                      >
                        {s.label}
                      </button>
                    );
                  })}
                  {!canEdit && g.members.length === 0 && (
                    <span className="fg-caption text-subtle">No stages</span>
                  )}
                </div>

                {codeFixClash && (
                  <p
                    className="fg-caption mt-2 flex items-center gap-1"
                    style={{ color: "var(--amberw-600)" }}
                  >
                    <Icon name="alert" size={12} />
                    Code and Fix in one group risks merge conflicts — they branch off the same base.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canEdit && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addGroup();
                }
              }}
              placeholder="New group name"
              maxLength={64}
              className="max-w-56"
              aria-label="New group name"
            />
            <Button variant="secondary" size="sm" onClick={addGroup} disabled={!newName.trim()}>
              <Icon name="plus" size={14} className="mr-1" />
              Add group
            </Button>
            <Button variant="ghost" size="sm" onClick={applySuggested}>
              Apply suggested default
            </Button>
          </div>

          <div className="flex flex-col gap-1">
            <label className="fg-label text-fg">On resume failure</label>
            <div className="w-56">
              <Select
                options={ON_RESUME_FAIL_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                value={policy}
                onChange={(v) => setPolicy(v as ResumePolicy)}
                placeholder="Default (start fresh)"
              />
            </div>
            <p className="fg-caption text-muted">
              {ON_RESUME_FAIL_OPTIONS.find((o) => o.value === policy)?.hint ??
                "If a session can't be resumed (device gone or prior run failed), start a fresh session."}
            </p>
          </div>

          {errors.length > 0 && (
            <Banner tone="attention">
              <ul className="list-inside list-disc">
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </Banner>
          )}

          {update.isError && (
            <Banner tone="danger" onDismiss={() => update.reset()}>
              {formatPipelineConfigError(update.error)}
            </Banner>
          )}

          {update.isSuccess && !dirty && (
            <Banner tone="success" onDismiss={() => update.reset()}>
              Session groups saved.
            </Banner>
          )}

          <Button
            variant="primary"
            loading={update.isPending}
            disabled={saveDisabled}
            onClick={save}
            className="min-h-11"
          >
            Save session groups
          </Button>
        </div>
      )}
    </div>
  );
}
