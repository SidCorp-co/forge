"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Banner, Button, PageSectionTitle, ConfirmDialog, EmptyState, ErrorState, Field, Input, Skeleton } from "@/design";
import { useProject } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { useUpdatePlugins } from "../hooks";
import type { PluginDesignation, ProjectAgentConfig } from "../types";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

const pluginsOf = (agentConfig: unknown): PluginDesignation[] =>
  (agentConfig && typeof agentConfig === "object" ? (agentConfig as ProjectAgentConfig) : {}).plugins ?? [];

interface DraftRow extends PluginDesignation {
  /** Stable across reorder and rename, so React keeps this row's focus and caret. */
  rowKey: string;
}

function rowError(p: DraftRow, t: Copy): string | null {
  if (!p.marketplace.trim()) return t("settings.project.plugins.marketplaceRequired");
  if (!NAME_RE.test(p.name.trim())) return t("settings.project.plugins.nameRule");
  const ref = p.pinnedRef?.trim();
  if (ref && !SHA_RE.test(ref)) return t("settings.project.plugins.shaRule");
  return null;
}

const stripKey = (r: PluginDesignation): PluginDesignation => ({
  marketplace: r.marketplace.trim(),
  name: r.name.trim(),
  pinnedRef: r.pinnedRef?.trim() || null,
});

const sameList = (a: DraftRow[], b: PluginDesignation[]) =>
  JSON.stringify(a.map(stripKey)) === JSON.stringify(b.map(stripKey));

export function PluginsSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const t = useCopy();
  const projectQ = useProject(projectId);
  return (
    <div id="plugins" className="mt-6 scroll-mt-24 border-t border-line pt-5">
      <div>
        <PageSectionTitle className="fg-label text-fg">{t("settings.project.plugins.title")}</PageSectionTitle>
        <p className="fg-caption mt-0.5 text-muted">{t("settings.project.plugins.lead")}</p>
      </div>
      {projectQ.isError ? (
        <div className="mt-3">
          <ErrorState message={formatApiError(projectQ.error)} onRetry={() => projectQ.refetch()} />
        </div>
      ) : projectQ.data ? (
        <PluginsEditor projectId={projectId} agentConfig={projectQ.data.agentConfig} canEdit={canEdit} />
      ) : (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-16 w-full rounded-md" />
          <Skeleton className="h-16 w-2/3 rounded-md" />
        </div>
      )}
    </div>
  );
}

function PluginsEditor({ projectId, agentConfig, canEdit }: { projectId: string; agentConfig: unknown; canEdit: boolean }) {
  const t = useCopy();
  const update = useUpdatePlugins(projectId);
  const nextKey = useRef(0);
  const keyed = (p: PluginDesignation): DraftRow => ({ ...p, rowKey: `row-${nextKey.current++}` });
  const [draft, setDraft] = useState<DraftRow[]>(() => pluginsOf(agentConfig).map(keyed));
  const [removing, setRemoving] = useState<number | null>(null);
  // A refetched project resets the draft to what is stored.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `keyed` only mints row keys from a ref.
  useEffect(() => setDraft(pluginsOf(agentConfig).map(keyed)), [agentConfig]);

  const errors = draft.map((p) => rowError(p, t));
  const firstError = errors.find((e): e is string => e !== null) ?? null;
  const dirty = !sameList(draft, pluginsOf(agentConfig));
  const addRow = () => setDraft((d) => [...d, keyed({ marketplace: "", name: "", pinnedRef: null })]);

  return (
    <>
      {draft.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title={t("settings.project.plugins.emptyTitle")}
            message={t("settings.project.plugins.emptyBody")}
            mascot
            action={canEdit ? { label: t("settings.project.plugins.add"), onClick: addRow } : undefined}
          />
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-line-subtle">
          {draft.map((p, i) => (
            <PluginRow
              key={p.rowKey}
              row={p}
              error={errors[i] ?? null}
              canEdit={canEdit}
              onPatch={(patch) => setDraft((d) => d.map((r, n) => (n === i ? { ...r, ...patch } : r)))}
              onRemove={() => setRemoving(i)}
            />
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="mt-3 space-y-3">
          {draft.length > 0 && (
            <Button variant="secondary" onClick={addRow}>
              {t("settings.project.plugins.add")}
            </Button>
          )}
          {firstError && <Banner tone="attention">{firstError}</Banner>}
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={!dirty || firstError !== null}
            onClick={() => update.mutate(draft.map(stripKey))}
            className="min-h-11"
          >
            {t("settings.project.plugins.save")}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={removing !== null}
        title={t("settings.project.plugins.removeTitle")}
        message={t("settings.project.plugins.removeBody")}
        confirmLabel={t("settings.project.plugins.remove")}
        tone="danger"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          setDraft((d) => d.filter((_, n) => n !== removing));
          setRemoving(null);
        }}
      />
    </>
  );
}

function PluginRow({
  row: p,
  error,
  canEdit,
  onPatch,
  onRemove,
}: {
  row: DraftRow;
  error: string | null;
  canEdit: boolean;
  onPatch: (patch: Partial<PluginDesignation>) => void;
  onRemove: () => void;
}) {
  const t = useCopy();
  return (
    <li className="py-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("settings.project.plugins.marketplace")} hint={t("settings.project.plugins.marketplaceHint")}>
          <Input
            value={p.marketplace}
            onChange={(e) => onPatch({ marketplace: e.target.value })}
            disabled={!canEdit}
            placeholder="SidCorp-co/forge-plugin"
          />
        </Field>
        <Field label={t("settings.project.plugins.name")} hint={t("settings.project.plugins.nameHint")}>
          <Input value={p.name} onChange={(e) => onPatch({ name: e.target.value })} disabled={!canEdit} placeholder="forge" />
        </Field>
        <Field label={t("settings.project.plugins.pinned")} hint={t("settings.project.plugins.pinnedHint")}>
          <Input
            value={p.pinnedRef ?? ""}
            onChange={(e) => onPatch({ pinnedRef: e.target.value.trim() || null })}
            disabled={!canEdit}
            placeholder="054d7575…"
          />
        </Field>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          {error ? (
            <p className="fg-caption" style={{ color: "var(--dangerw-600)" }}>
              {error}
            </p>
          ) : (
            <Badge tone={p.pinnedRef ? "neutral" : "accent"}>{p.pinnedRef ? t("settings.project.plugins.isPinned") : t("settings.project.plugins.tracksHead")}</Badge>
          )}
        </div>
        {canEdit && (
          <Button variant="ghost" onClick={onRemove}>
            {t("settings.project.plugins.remove")}
          </Button>
        )}
      </div>
    </li>
  );
}
