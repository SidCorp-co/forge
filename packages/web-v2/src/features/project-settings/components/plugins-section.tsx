"use client";

// cm:guard the save REPLACES `agentConfig.plugins` whole — the draft this section holds must always start from the fetched list and always be sent complete. A partial send is not a smaller edit here, it is a deletion of everything omitted.
// cm:edge contract -> packages/core/src/projects/routes.ts — `PATCH /:id/plugins` takes `{ plugins }` and validates each against `pluginDesignationSchema`: kebab-case name, `pinnedRef` a 7-40 char git SHA or null

import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useProject } from "@/features/projects/hooks";
import { useUpdatePlugins } from "../hooks";
import type { PluginDesignation, ProjectAgentConfig } from "../types";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

function asAgentConfig(raw: unknown): ProjectAgentConfig {
  return raw && typeof raw === "object" ? (raw as ProjectAgentConfig) : {};
}

function rowError(p: DraftRow): string | null {
  if (!p.marketplace.trim()) return "Marketplace is required.";
  if (!NAME_RE.test(p.name.trim())) return "Name must be kebab-case.";
  const ref = p.pinnedRef?.trim();
  if (ref && !SHA_RE.test(ref)) return "Pinned SHA must be 7–40 hex characters.";
  return null;
}

interface DraftRow extends PluginDesignation {
  /** Stable across reorder and rename, so React keeps this row's focus and caret. */
  rowKey: string;
}

const stripKey = (r: DraftRow): PluginDesignation => ({
  marketplace: r.marketplace.trim(),
  name: r.name.trim(),
  pinnedRef: r.pinnedRef?.trim() || null,
  autoUpdate: Boolean(r.autoUpdate),
});

function sameList(a: DraftRow[], b: PluginDesignation[]): boolean {
  return JSON.stringify(a.map(stripKey)) === JSON.stringify(b.map((p) => stripKey(p as DraftRow)));
}

export function PluginsSection({
  projectId,
  canEdit,
}: {
  projectId: string;
  canEdit: boolean;
}) {
  const projectQ = useProject(projectId);
  const update = useUpdatePlugins(projectId);

  const server = asAgentConfig(projectQ.data?.agentConfig).plugins ?? [];
  const [draft, setDraft] = useState<DraftRow[] | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const nextKey = useRef(0);
  const newRow = (): DraftRow => ({
    rowKey: `row-${nextKey.current++}`,
    marketplace: "",
    name: "",
    pinnedRef: null,
    autoUpdate: false,
  });

  useEffect(() => {
    if (!projectQ.data) return;
    const stored = asAgentConfig(projectQ.data.agentConfig).plugins ?? [];
    setDraft(stored.map((p) => ({ ...p, rowKey: `row-${nextKey.current++}` })));
  }, [projectQ.data]);

  const heading = (
    <div>
      <h3 className="fg-label text-fg">Plugins</h3>
      <p className="fg-caption mt-0.5 text-muted">
        This project designates plugins; a device installs the union of every project it serves,
        and only when that box has <code>[plugins] enabled</code>. The driver skill{" "}
        <code>issue-flow</code> arrives this way.
      </p>
    </div>
  );

  if (projectQ.isLoading || !draft) {
    return (
      <div className="mt-6 border-t border-line pt-5">
        {heading}
        <div className="mt-3 space-y-2">
          <Skeleton className="h-16 w-full rounded-md" />
          <Skeleton className="h-16 w-2/3 rounded-md" />
        </div>
      </div>
    );
  }

  if (projectQ.isError) {
    return (
      <div className="mt-6 border-t border-line pt-5">
        {heading}
        <div className="mt-3">
          <ErrorState
            message={formatApiError(projectQ.error)}
            onRetry={() => projectQ.refetch()}
          />
        </div>
      </div>
    );
  }

  const errors = draft.map(rowError);
  const firstError = errors.find((e): e is string => e !== null) ?? null;
  const dirty = !sameList(draft, server);

  const patchRow = (i: number, patch: Partial<PluginDesignation>) =>
    setDraft((d) => (d ? d.map((p, n) => (n === i ? { ...p, ...patch } : p)) : d));

  return (
    <div className="mt-6 border-t border-line pt-5">
      {heading}

      {draft.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title="No plugins yet"
            message="Without a plugin carrying issue-flow, a dispatched session is told to use a skill it does not have."
            mascot
            action={
              canEdit
                ? {
                    label: "Add a plugin",
                    onClick: () => setDraft([newRow()]),
                  }
                : undefined
            }
          />
        </div>
      ) : (
        <ul className="mt-3 space-y-3">
          {draft.map((p, i) => (
            <li
              key={p.rowKey}
              className="rounded-md border border-line bg-surface p-3"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Marketplace" hint="owner/repo of the plugin marketplace">
                  <Input
                    value={p.marketplace}
                    onChange={(e) => patchRow(i, { marketplace: e.target.value })}
                    disabled={!canEdit}
                    placeholder="SidCorp-co/forge-plugin"
                  />
                </Field>
                <Field label="Name" hint="kebab-case, as the marketplace lists it">
                  <Input
                    value={p.name}
                    onChange={(e) => patchRow(i, { name: e.target.value })}
                    disabled={!canEdit}
                    placeholder="forge"
                  />
                </Field>
                <Field
                  label="Pinned SHA"
                  hint="Empty tracks the marketplace head; a SHA freezes it."
                >
                  <Input
                    value={p.pinnedRef ?? ""}
                    onChange={(e) =>
                      patchRow(i, { pinnedRef: e.target.value.trim() || null })
                    }
                    disabled={!canEdit}
                    placeholder="054d7575…"
                  />
                </Field>
                <div className="flex items-end pb-1">
                  <Checkbox
                    checked={Boolean(p.autoUpdate)}
                    onChange={(v) => patchRow(i, { autoUpdate: v })}
                    disabled={!canEdit}
                    label="Auto-update"
                  />
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  {errors[i] ? (
                    <p className="fg-caption" style={{ color: "var(--dangerw-600)" }}>
                      {errors[i]}
                    </p>
                  ) : (
                    <Badge tone={p.pinnedRef ? "neutral" : "accent"}>
                      {p.pinnedRef ? "pinned" : "tracks head"}
                    </Badge>
                  )}
                </div>
                {canEdit && (
                  <Button variant="ghost" onClick={() => setRemoving(i)}>
                    Remove
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="mt-3 space-y-3">
          {draft.length > 0 && (
            <Button
              variant="secondary"
              onClick={() =>
                setDraft((d) => (d ? [...d, newRow()] : d))
              }
            >
              Add a plugin
            </Button>
          )}
          {firstError && <Banner tone="attention">{firstError}</Banner>}
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={!dirty || firstError !== null}
            onClick={() =>
              update.mutate(draft.map(stripKey))
            }
            className="min-h-11"
          >
            Save plugins
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        title="Remove this plugin?"
        message="Every device serving this project drops it on its next poll. A session that needed its skill will not have one."
        confirmLabel="Remove"
        tone="danger"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          setDraft((d) => (d ? d.filter((_, n) => n !== removing) : d));
          setRemoving(null);
        }}
      />
    </div>
  );
}
