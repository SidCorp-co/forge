"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Banner, Button, PageSectionTitle, ConfirmDialog, EmptyState, ErrorState, Field, Input, Skeleton } from "@/design";
import { useProject } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { inlineRich } from "./inline-code";
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
  if (!p.marketplace.trim()) return t("skills.err.marketplace");
  if (!NAME_RE.test(p.name.trim())) return t("skills.err.name");
  const ref = p.pinnedRef?.trim();
  if (ref && !SHA_RE.test(ref)) return t("skills.err.sha");
  return null;
}

const stripKey = (r: PluginDesignation): PluginDesignation => ({
  marketplace: r.marketplace.trim(),
  name: r.name.trim(),
  pinnedRef: r.pinnedRef?.trim() || null,
});

const sameList = (a: DraftRow[], b: PluginDesignation[]) =>
  JSON.stringify(a.map(stripKey)) === JSON.stringify(b.map(stripKey));

function Heading() {
  const t = useCopy();
  return (
    <div>
      <PageSectionTitle className="fg-label text-fg">{t("skills.heading")}</PageSectionTitle>
      <p className="fg-caption mt-0.5 text-muted">{inlineRich(t("skills.headingHint"))}</p>
    </div>
  );
}

export function PluginsSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const projectQ = useProject(projectId);
  return (
    <div className="mt-6 border-t border-line pt-5">
      <Heading />
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

  const errors = draft.map((r) => rowError(r, t));
  const firstError = errors.find((e): e is string => e !== null) ?? null;
  const dirty = !sameList(draft, pluginsOf(agentConfig));
  const addRow = () => setDraft((d) => [...d, keyed({ marketplace: "", name: "", pinnedRef: null })]);

  return (
    <>
      {draft.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title={t("skills.empty.title")}
            message={t("skills.empty.message")}
            mascot
            action={canEdit ? { label: t("skills.add"), onClick: addRow } : undefined}
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
              {t("skills.add")}
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
            {t("skills.save")}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={removing !== null}
        title={t("skills.remove.title")}
        message={t("skills.remove.message")}
        confirmLabel={t("skills.remove.confirm")}
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
        <Field label={t("skills.field.marketplace")} hint={t("skills.field.marketplaceHint")}>
          <Input
            value={p.marketplace}
            onChange={(e) => onPatch({ marketplace: e.target.value })}
            disabled={!canEdit}
            placeholder="SidCorp-co/forge-plugin"
          />
        </Field>
        <Field label={t("skills.field.name")} hint={t("skills.field.nameHint")}>
          <Input value={p.name} onChange={(e) => onPatch({ name: e.target.value })} disabled={!canEdit} placeholder="forge" />
        </Field>
        <Field label={t("skills.field.pinned")} hint={t("skills.field.pinnedHint")}>
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
            <Badge tone={p.pinnedRef ? "neutral" : "accent"}>{p.pinnedRef ? t("skills.badge.pinned") : t("skills.badge.tracksHead")}</Badge>
          )}
        </div>
        {canEdit && (
          <Button variant="ghost" onClick={onRemove}>
            {t("skills.remove.confirm")}
          </Button>
        )}
      </div>
    </li>
  );
}
