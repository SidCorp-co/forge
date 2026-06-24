"use client";

// Rules inner tab — editor for rule/guide knowledge entries with always-inject budget
// meter (parity with project-facts-tab.tsx). Backed by /api/projects/:id/knowledge.
import { useEffect, useMemo, useState } from "react";
import {
  Banner,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  KnowledgeMarkdown,
  Skeleton,
  Textarea,
  Toggle,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useDeleteEntry, useKnowledgeEntries, useKnowledgeEntry, useUpsertEntry } from "../hooks";
import type { KnowledgeInjection, KnowledgeKind, KnowledgeListRow } from "../types";

const ALWAYS_INJECT_MAX_CHARS = 6000;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ENTRY_MAX_CHARS = 100_000;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

interface EditRow {
  rid: number;
  slug: string;
  title: string;
  body: string;
  injection: KnowledgeInjection;
  kind: KnowledgeKind;
  isNew: boolean;
  // Preserved from server for PUT to avoid silently downgrading verified entries.
  confidence: string;
  authoredBy: string;
  orderIndex: number;
  // null = not yet fetched (existing rows); populated by RuleBodyLoader on expand.
  metadata: Record<string, unknown> | null;
}

interface RulesTabProps {
  projectId: string;
  canManage: boolean;
}

export function RulesTab({ projectId, canManage }: RulesTabProps) {
  const entriesQ = useKnowledgeEntries(projectId, "rule");
  const guidesQ = useKnowledgeEntries(projectId, "guide");

  const rows = useMemo(() => {
    const ruleRows = entriesQ.data?.rows ?? [];
    const guideRows = guidesQ.data?.rows ?? [];
    return [...ruleRows, ...guideRows];
  }, [entriesQ.data, guidesQ.data]);

  const isLoading = entriesQ.isLoading || guidesQ.isLoading;
  const isError = entriesQ.isError || guidesQ.isError;
  const errorMsg = entriesQ.error
    ? formatApiError(entriesQ.error)
    : formatApiError(guidesQ.error as Error);

  function retry() {
    entriesQ.refetch();
    guidesQ.refetch();
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="h-32 w-full rounded-md" />
      </div>
    );
  }

  if (isError) {
    return <ErrorState title="Couldn't load rules" message={errorMsg} onRetry={retry} />;
  }

  return <RulesEditor projectId={projectId} serverRows={rows} canManage={canManage} />;
}

function RulesEditor({
  projectId,
  serverRows,
  canManage,
}: {
  projectId: string;
  serverRows: KnowledgeListRow[];
  canManage: boolean;
}) {
  const [editRows, setEditRows] = useState<EditRow[]>([]);
  const [nextRid, setNextRid] = useState(1);
  // rid-keyed so multiple unsaved new rows (all slug="") don't share a delete-confirm state.
  const [confirmRid, setConfirmRid] = useState<number | null>(null);
  const [loadedBodies, setLoadedBodies] = useState<Map<string, string>>(new Map());
  const [loadedMeta, setLoadedMeta] = useState<Map<string, Record<string, unknown>>>(new Map());

  const upsert = useUpsertEntry(projectId);
  const deleteEntry = useDeleteEntry(projectId);

  // Seed editor rows from server list (each row is body-free; bodies loaded lazily on expand).
  useEffect(() => {
    const seeded = serverRows.map((r, i) => ({
      rid: i + 1,
      slug: r.slug,
      title: r.title,
      body: loadedBodies.get(r.slug) ?? "",
      injection: (r.injection as KnowledgeInjection) ?? "on_demand",
      kind: (r.kind as KnowledgeKind) ?? "rule",
      isNew: false,
      confidence: r.confidence ?? "inferred",
      authoredBy: r.authoredBy ?? "human",
      orderIndex: r.orderIndex ?? 0,
      metadata: loadedMeta.get(r.slug) ?? null,
    }));
    setEditRows(seeded);
    setNextRid(seeded.length + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRows]);

  // Budget: sum of always-inject body chars (approximated for rows with empty body = not loaded).
  const injectedChars = useMemo(
    () =>
      editRows
        .filter((r) => r.injection === "always")
        .reduce((sum, r) => sum + r.body.length, 0),
    [editRows],
  );
  const overBudget = injectedChars > ALWAYS_INJECT_MAX_CHARS;
  const budgetPct = Math.min(100, Math.round((injectedChars / ALWAYS_INJECT_MAX_CHARS) * 100));
  // True when always-inject bodies haven't been fetched yet (count is an underestimate).
  const hasUnloadedAlwaysInject = useMemo(
    () => editRows.some((r) => !r.isNew && r.injection === "always" && !r.body),
    [editRows],
  );

  function addRow() {
    setEditRows((rs) => [
      ...rs,
      {
        rid: nextRid,
        slug: "",
        title: "",
        body: "",
        injection: "on_demand",
        kind: "rule",
        isNew: true,
        confidence: "inferred",
        authoredBy: "human",
        orderIndex: 0,
        metadata: {},
      },
    ]);
    setNextRid((n) => n + 1);
  }

  function patchRow(rid: number, patch: Partial<EditRow>) {
    setEditRows((rs) => rs.map((r) => (r.rid === rid ? { ...r, ...patch } : r)));
  }

  function validateSlug(slug: string, rid: number): string | null {
    const s = slug.trim();
    if (s.length === 0) return "Slug is required.";
    if (s.length > 512) return "Slug must be ≤512 chars.";
    if (!SLUG_PATTERN.test(s)) return "Slug must be kebab-case.";
    if (editRows.some((r) => r.rid !== rid && r.slug.trim() === s)) return "Slug must be unique.";
    return null;
  }

  const errors = useMemo(() => {
    const m = new Map<number, { slug?: string; title?: string; body?: string }>();
    for (const r of editRows) {
      const slugErr = validateSlug(r.slug, r.rid);
      const titleErr = !r.title.trim() ? "Title is required." : undefined;
      const bodyErr =
        r.body.length > ENTRY_MAX_CHARS ? `Body must be ≤${ENTRY_MAX_CHARS} chars.` : undefined;
      if (slugErr || titleErr || bodyErr)
        m.set(r.rid, {
          ...(slugErr ? { slug: slugErr } : {}),
          ...(titleErr ? { title: titleErr } : {}),
          ...(bodyErr ? { body: bodyErr } : {}),
        });
    }
    return m;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRows]);

  function saveRow(row: EditRow) {
    if (errors.has(row.rid)) return;
    upsert.mutate(
      {
        slug: row.slug.trim(),
        body: {
          title: row.title.trim(),
          body: row.body,
          kind: row.kind,
          injection: row.injection,
          // Preserve server-side confidence/authoredBy/orderIndex/metadata to avoid silently
          // downgrading verified entries or wiping metadata.relatedIssueIds.
          confidence: row.confidence as never,
          authoredBy: row.authoredBy as never,
          orderIndex: row.orderIndex,
          metadata: row.metadata ?? {},
        },
      },
      {
        onSuccess: () => {
          setLoadedBodies((m) => new Map(m).set(row.slug.trim(), row.body));
          setLoadedMeta((m) => new Map(m).set(row.slug.trim(), row.metadata ?? {}));
          patchRow(row.rid, { isNew: false });
        },
      },
    );
  }

  function handleDelete(row: EditRow) {
    if (row.isNew) {
      setEditRows((rs) => rs.filter((r) => r.rid !== row.rid));
      return;
    }
    deleteEntry.mutate(row.slug, {
      onSuccess: () => {
        setEditRows((rs) => rs.filter((r) => r.rid !== row.rid));
        setConfirmRid(null);
      },
    });
  }

  return (
    <div>
      {/* Always-inject budget meter */}
      <div className="mb-4 rounded-md border border-line bg-surface px-3 py-2.5">
        <div className="mb-1 flex items-center justify-between">
          <span className="fg-label text-fg">Always-inject budget</span>
          <span
            className="fg-caption font-mono"
            style={{ color: overBudget ? "var(--red-600)" : "var(--fg-muted)" }}
          >
            {injectedChars.toLocaleString()} / {ALWAYS_INJECT_MAX_CHARS.toLocaleString()} chars
            {hasUnloadedAlwaysInject && " (estimated)"}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-pill bg-sunken">
          <div
            className="h-full rounded-pill transition-all"
            style={{
              width: `${budgetPct}%`,
              background: overBudget ? "var(--red-600)" : "var(--accent-solid)",
            }}
          />
        </div>
        {overBudget && (
          <p className="fg-caption mt-1.5" style={{ color: "var(--red-600)" }}>
            Over budget — all always-inject entries are still injected, but this bloats every prompt
            for this project. Trim a body or change injection to on-demand.
          </p>
        )}
      </div>

      {editRows.length === 0 ? (
        <EmptyState
          title="No rules or guides yet"
          message={
            canManage
              ? "Add a rule or guide to give agents project-specific instructions."
              : "No rules or guides have been defined for this project."
          }
          mascot={false}
        />
      ) : (
        <div className="space-y-4">
          {editRows.map((r) => (
            <RuleRow
              key={r.rid}
              projectId={projectId}
              row={r}
              canManage={canManage}
              error={errors.get(r.rid)}
              confirmActive={confirmRid === r.rid}
              isSaving={upsert.isPending}
              isDeleting={deleteEntry.isPending}
              onPatch={(patch) => patchRow(r.rid, patch)}
              onBodyLoad={(slug, body, meta) => setLoadedMeta((m) => new Map(m).set(slug, meta))}
              onSave={() => saveRow(r)}
              onDelete={() => handleDelete(r)}
              onConfirmDelete={() => setConfirmRid(r.rid)}
              onCancelDelete={() => setConfirmRid(null)}
            />
          ))}
        </div>
      )}

      {canManage && (
        <div className="mt-4 space-y-3">
          <Button variant="ghost" size="sm" onClick={addRow}>
            <Icon name="plus" size={14} className="mr-1" />
            Add rule
          </Button>
          {(upsert.isError || deleteEntry.isError) && (
            <Banner tone="danger" onDismiss={() => { upsert.reset(); deleteEntry.reset(); }}>
              {upsert.isError ? formatApiError(upsert.error) : formatApiError(deleteEntry.error as Error)}
            </Banner>
          )}
        </div>
      )}
    </div>
  );
}

function RuleBodyLoader({
  projectId,
  slug,
  onLoad,
}: {
  projectId: string;
  slug: string;
  onLoad: (body: string, metadata: Record<string, unknown>) => void;
}) {
  const entryQ = useKnowledgeEntry(projectId, slug || undefined);
  useEffect(() => {
    if (entryQ.data?.body) {
      onLoad(entryQ.data.body, (entryQ.data.metadata as Record<string, unknown>) ?? {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryQ.data?.body]);
  return null;
}

function RuleRow({
  projectId,
  row,
  canManage,
  error,
  confirmActive,
  isSaving,
  isDeleting,
  onPatch,
  onBodyLoad,
  onSave,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  projectId: string;
  row: EditRow;
  canManage: boolean;
  error?: { slug?: string; title?: string; body?: string };
  confirmActive: boolean;
  isSaving: boolean;
  isDeleting: boolean;
  onPatch: (p: Partial<EditRow>) => void;
  onBodyLoad: (slug: string, body: string, meta: Record<string, unknown>) => void;
  onSave: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(row.isNew);
  const [bodyLoaded, setBodyLoaded] = useState(!!row.body);
  const [showPreview, setShowPreview] = useState(false);
  const debouncedBody = useDebounced(row.body, 300);

  return (
    <div className="rounded-md border border-line bg-surface p-3">
      {/* Load body + metadata from server when row expands for existing entries */}
      {expanded && !row.isNew && !bodyLoaded && (
        <RuleBodyLoader
          projectId={projectId}
          slug={row.slug}
          onLoad={(b, m) => { onPatch({ body: b, metadata: m }); setBodyLoaded(true); onBodyLoad(row.slug, b, m); }}
        />
      )}

      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setExpanded((o) => !o)}
      >
        <Icon
          name="chevronRight"
          size={14}
          className="shrink-0 text-subtle transition-transform duration-[150ms]"
          style={{ transform: expanded ? "rotate(90deg)" : "none" }}
        />
        <span className="fg-label min-w-0 flex-1 truncate">{row.title || row.slug || "New entry"}</span>
        <span className="fg-caption text-muted">{row.kind}</span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          <Field label="Slug" hint="kebab-case identifier" {...(error?.slug ? { error: error.slug } : {})}>
            <Input
              value={row.slug}
              onChange={(e) => onPatch({ slug: e.target.value })}
              disabled={!canManage || !row.isNew}
              placeholder="auth-rules"
            />
          </Field>

          <Field label="Title" {...(error?.title ? { error: error.title } : {})}>
            <Input
              value={row.title}
              onChange={(e) => onPatch({ title: e.target.value })}
              disabled={!canManage}
              placeholder="Authentication rules"
            />
          </Field>

          <Field label="Body" {...(error?.body ? { error: error.body } : {})}>
            <Textarea
              value={row.body}
              onChange={(e) => onPatch({ body: e.target.value })}
              disabled={!canManage}
              rows={5}
              placeholder="Enter rules or guide text…"
            />
            <div className="mt-1 flex justify-end">
              <span
                className="fg-caption font-mono text-muted"
                style={row.body.length > ENTRY_MAX_CHARS ? { color: "var(--red-600)" } : undefined}
              >
                {row.body.length} / {ENTRY_MAX_CHARS}
              </span>
            </div>
          </Field>

          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowPreview((p) => !p)}
            >
              <Icon
                name="chevronRight"
                size={12}
                className="mr-1 shrink-0 transition-transform duration-[150ms]"
                style={{ transform: showPreview ? "rotate(90deg)" : "none" }}
              />
              Preview
            </Button>
            {showPreview && (
              <div className="mt-2 overflow-x-auto rounded-md border border-line bg-sunken p-3">
                <KnowledgeMarkdown>{debouncedBody}</KnowledgeMarkdown>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
            <div className="min-w-0">
              <p className="fg-label text-fg">Always-inject</p>
              <p className="fg-caption text-muted">Injected verbatim into every agent prompt.</p>
            </div>
            <Toggle
              checked={row.injection === "always"}
              onChange={(v) => onPatch({ injection: v ? "always" : "on_demand" })}
              disabled={!canManage}
              aria-label={`Always-inject ${row.slug || "entry"}`}
            />
          </div>

          {canManage && (
            <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
              <div>
                {confirmActive ? (
                  <div className="flex items-center gap-2">
                    <span className="fg-caption text-muted">Remove this entry?</span>
                    <Button variant="danger" size="sm" loading={isDeleting} onClick={onDelete}>
                      Confirm
                    </Button>
                    <Button variant="ghost" size="sm" onClick={onCancelDelete}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" onClick={onConfirmDelete}>
                    <Icon name="trash" size={14} className="mr-1" />
                    Remove
                  </Button>
                )}
              </div>
              {/* Disable Save until body fetched — saves with empty body hit 400 (bodySchema.min(1)). */}
              <Button
                variant="primary"
                size="sm"
                loading={isSaving}
                onClick={onSave}
                disabled={!row.isNew && !bodyLoaded}
              >
                Save
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
