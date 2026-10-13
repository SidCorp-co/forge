"use client";

import { useState } from "react";
import {
  Badge,
  Button,
  CardTitle,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  type SettingsForm,
} from "@/design";
import type { PipelineDraft } from "../pipeline-form";
import type { PluginDesignation } from "../types";

const BLANK: PluginDesignation = { marketplace: "", name: "", pinnedRef: null, autoUpdate: false };

export function PluginsSection({
  form,
  canEdit,
}: {
  form: SettingsForm<PipelineDraft>;
  canEdit: boolean;
}) {
  const plugins = form.draft.plugins;
  const [removing, setRemoving] = useState<number | null>(null);

  const setPlugins = (next: (current: PluginDesignation[]) => PluginDesignation[]) =>
    form.setDraft((d) => ({ ...d, plugins: next(d.plugins) }));
  const patchRow = (i: number, patch: Partial<PluginDesignation>) =>
    setPlugins((list) => list.map((p, n) => (n === i ? { ...p, ...patch } : p)));

  return (
    <div className="mt-6 border-t border-line pt-5">
      <div>
        <CardTitle className="fg-label text-fg">Plugins</CardTitle>
        <p className="fg-caption mt-0.5 text-muted">
          This project designates plugins; a device installs the union of every project it serves,
          and only when that box has <code>[plugins] enabled</code>. The driver skill{" "}
          <code>issue-flow</code> arrives this way.
        </p>
      </div>

      {plugins.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title="No plugins yet"
            message="Without a plugin carrying issue-flow, a dispatched session is told to use a skill it does not have."
            mascot
            action={
              canEdit
                ? {
                    label: "Add a plugin",
                    onClick: () => setPlugins(() => [{ ...BLANK }]),
                    icon: "plus",
                  }
                : undefined
            }
          />
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {plugins.map((p, i) => {
            const rowError = (field: "marketplace" | "name" | "pinnedRef") => form.errorAt(`plugins.${i}.${field}`);
            return (
              // A row IS its position in the list: nothing reorders them, and a half-typed name is not an identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
              <li key={i} className="py-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Marketplace" hint="owner/repo of the plugin marketplace" error={rowError("marketplace")}>
                    <Input
                      value={p.marketplace}
                      onChange={(e) => patchRow(i, { marketplace: e.target.value })}
                      disabled={!canEdit}
                      placeholder="SidCorp-co/forge-plugin"
                    />
                  </Field>
                  <Field label="Name" hint="kebab-case, as the marketplace lists it" error={rowError("name")}>
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
                    error={rowError("pinnedRef")}
                  >
                    <Input
                      value={p.pinnedRef ?? ""}
                      onChange={(e) => patchRow(i, { pinnedRef: e.target.value.trim() || null })}
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
                    <Badge tone={p.pinnedRef ? "neutral" : "accent"}>
                      {p.pinnedRef ? "pinned" : "tracks head"}
                    </Badge>
                  </div>
                  {canEdit && (
                    <Button variant="ghost" onClick={() => setRemoving(i)}>
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canEdit && plugins.length > 0 && (
        <div className="mt-3">
          <Button variant="secondary" onClick={() => setPlugins((list) => [...list, { ...BLANK }])}>
            Add a plugin
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
          setPlugins((list) => list.filter((_, n) => n !== removing));
          setRemoving(null);
        }}
      />
    </div>
  );
}
