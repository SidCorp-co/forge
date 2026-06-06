'use client';

import { Suspense, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { Plus, Copy } from 'lucide-react';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import {
  useCreateSkill,
  useUpdateSkill,
  useDeleteSkill,
  useProjectSkillSyncStatus,
  useBulkPushSkills,
  useEffectiveSkills,
  useApplyDefault,
} from '@/features/skill/hooks/use-skills';
import {
  SkillList,
  type SortField,
  type SortDirection,
} from '@/features/skill/components/skill-list';
import {
  SkillFolderEditor,
  type SkillFolderSavePayload,
} from '@/features/skill/components/skill-folder-editor';
import { SkillSyncPanel } from '@/features/skill/components/skill-sync-panel';
import { SkillHistory } from '@/features/skill/components/skill-history';
import { Skeleton } from '@/components/ui/skeleton';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { formatApiError } from '@/lib/api/error';
import type { Skill, EffectiveSkill } from '@/features/skill/types';

function SkillsPageInner() {
  useSetPageTitle('Skills');
  const { slug } = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const project = useProjectBySlug(slug);
  const projectId = project?.id;

  // ISS-388 — `/effective` returns globals (read-only built-in defaults) + this
  // project's project skills, annotated with `editable` + the shadow relation.
  const skillsQuery = useEffectiveSkills(projectId);
  const syncQuery = useProjectSkillSyncStatus(projectId);
  const createSkill = useCreateSkill();
  const updateSkill = useUpdateSkill();
  const deleteSkill = useDeleteSkill();
  const bulkPush = useBulkPushSkills();
  const applyDefault = useApplyDefault();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // True once the user picks/creates/closes a skill — pins manual selection so
  // the `?skill=` deep-link no longer forces a row (see deepLinkSelectedId).
  const [interacted, setInteracted] = useState(false);
  const [filter, setFilter] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  // Memoized so its identity is stable across renders — the deep-link + filter
  // useMemos below depend on it (avoids react-hooks/exhaustive-deps churn).
  const skills = useMemo(() => skillsQuery.data?.data ?? [], [skillsQuery.data]);
  const syncStatus = syncQuery.data?.data;
  // Tracks which skill's "Sync now" is in flight (null = a top-level Sync All).
  const [syncingSkill, setSyncingSkill] = useState<string | null>(null);

  const filteredSorted = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const base = f
      ? skills.filter(
          (s) =>
            s.name.toLowerCase().includes(f) ||
            (s.description ?? '').toLowerCase().includes(f),
        )
      : skills.slice();
    base.sort((a, b) => {
      const dir = sortDirection === 'asc' ? 1 : -1;
      if (sortField === 'name') return a.name.localeCompare(b.name) * dir;
      return ((a.version ?? 0) - (b.version ?? 0)) * dir;
    });
    return base;
  }, [skills, filter, sortField, sortDirection]);

  // Deep-link selection (ISS-277): the Settings by-stage matrix links here with
  // `?skill=<skillId>`, so the two surfaces (Studio + Settings) point at one
  // authoring page. Resolved as DERIVED state (no effect) — the matching row is
  // pre-selected until the user interacts, after which `interacted` pins manual
  // selection. Matches the registration's `skillId` (`id`) or `documentId`.
  const deepLinkSkillId = searchParams.get('skill');
  const deepLinkSelectedId = useMemo(() => {
    if (interacted || !deepLinkSkillId) return null;
    const match = skills.find((s) => s.id === deepLinkSkillId || s.documentId === deepLinkSkillId);
    return match ? (match.documentId ?? match.id) : null;
  }, [interacted, deepLinkSkillId, skills]);

  const activeSelectedId = selectedId ?? deepLinkSelectedId;

  const selected = useMemo(
    () => skills.find((s) => (s.documentId ?? s.id) === activeSelectedId) ?? null,
    [skills, activeSelectedId],
  );

  function handleSort(field: SortField) {
    if (field === sortField) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  }

  function handleSave(data: SkillFolderSavePayload) {
    setInteracted(true);
    // Globals are immutable read-only templates — the editor is read-only for
    // them, so a save can only originate from a project skill or a new skill.
    if (selected && selected.scope !== 'global') {
      updateSkill.mutate(
        {
          documentId: selected.documentId ?? selected.id,
          data: {
            name: data.name,
            description: data.description,
            skillMd: data.skillMd,
            target: data.target,
            isGlobal: data.isGlobal,
            files: data.files,
          },
        },
        { onSuccess: () => setSelectedId(null) },
      );
    } else if (!selected && projectId) {
      createSkill.mutate(
        {
          name: data.name,
          description: data.description,
          skillMd: data.skillMd,
          target: data.target,
          isGlobal: data.isGlobal,
          files: data.files,
          projectId: data.isGlobal ? undefined : projectId,
        },
        {
          onSuccess: (res) => {
            setCreating(false);
            const created = res?.data;
            if (created) setSelectedId(created.documentId ?? created.id);
          },
        },
      );
    }
  }

  function handleDelete(skill: Skill) {
    // Globals are immutable built-in defaults — never deletable from a project.
    if (skill.scope === 'global') return;
    if (!confirm(`Delete skill "${skill.name}"?`)) return;
    const id = skill.documentId ?? skill.id;
    deleteSkill.mutate(id, {
      onSuccess: () => {
        if (activeSelectedId === id) {
          setInteracted(true);
          setSelectedId(null);
        }
      },
    });
  }

  // Apply default — copy the selected global template into a new same-name
  // project skill (it then shadows the global) and select the editable copy.
  function handleApplyDefault(skill: Skill) {
    if (!projectId) return;
    applyDefault.mutate(
      { projectId, globalSkillId: skill.id },
      {
        onSuccess: (res) => {
          setInteracted(true);
          const created = res?.data;
          if (created) setSelectedId(created.documentId ?? created.id);
        },
      },
    );
  }

  // Sync now → enqueue a target-scoped bulk-push job (the runner pulls + reports
  // back; the 30s poll on useProjectSkillSyncStatus then refreshes freshness).
  // `skillName` omitted = Sync All. Targets dev only — the freshness view tracks
  // claude-code (dev) devices, and a cloud-target job has no consumer here.
  function handleSync(skillName?: string) {
    if (!projectId) return;
    setSyncingSkill(skillName ?? null);
    bulkPush.mutate(
      {
        targets: ['dev'],
        projectDocumentId: projectId,
        skillNames: skillName ? [skillName] : undefined,
      },
      { onSettled: () => setSyncingSkill(null) },
    );
  }

  const saving = createSkill.isPending || updateSkill.isPending;
  const editorOpen = creating || !!selected;
  const saveError = createSkill.error || updateSkill.error || applyDefault.error;
  const selectedEffective = selected as EffectiveSkill | null;
  // Globals are read-only built-in defaults; only project skills are editable.
  const selectedIsGlobal = selected?.scope === 'global';

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-on-surface">Skills</h1>
          <p className="text-sm text-primary-fixed">
            Reusable skill manifests synced to dev and cloud agents.
          </p>
        </div>
        {!editorOpen && (
          <button
            type="button"
            onClick={() => {
              setInteracted(true);
              setSelectedId(null);
              setCreating(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-sm border border-outline-variant/30 bg-primary px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            New skill
          </button>
        )}
      </div>

      {!projectId ? (
        <p className="text-sm text-primary-fixed">Loading project…</p>
      ) : (
        <>
          <SkillSyncPanel
            data={syncStatus}
            onSync={handleSync}
            syncing={bulkPush.isPending}
            syncingSkill={syncingSkill}
            deviceHref={(deviceId) => `/settings/devices/${deviceId}`}
          />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div>
              {skillsQuery.isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                </div>
              ) : skillsQuery.error ? (
                <p className="text-[10px] uppercase tracking-widest text-error">
                  {formatApiError(skillsQuery.error)}
                </p>
              ) : (
                <SkillList
                  skills={filteredSorted}
                  onSelect={(s) => {
                    setInteracted(true);
                    setCreating(false);
                    setSelectedId(s.documentId ?? s.id);
                  }}
                  onDelete={handleDelete}
                  selectedId={selected?.documentId ?? selected?.id}
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  filter={filter}
                  onFilterChange={setFilter}
                />
              )}
            </div>

            <div className="space-y-3">
              {editorOpen ? (
                <div className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-4">
                  {selectedIsGlobal && (
                    <div className="mb-3 flex items-center justify-between gap-2 rounded border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-xs text-on-surface-variant">
                      <span>
                        <strong>Built-in default</strong> (read-only).
                        {selectedEffective?.shadowedByProjectSkillId
                          ? ' A project copy already shadows this default.'
                          : ' Apply default to create an editable project copy.'}
                      </span>
                      {projectId && !selectedEffective?.shadowedByProjectSkillId && (
                        <button
                          type="button"
                          onClick={() => handleApplyDefault(selected!)}
                          disabled={applyDefault.isPending}
                          className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium text-info hover:bg-info-surface/30 disabled:opacity-50"
                        >
                          <Copy className="h-3 w-3" />
                          Apply default
                        </button>
                      )}
                    </div>
                  )}
                  {!selectedIsGlobal && selectedEffective?.shadowsGlobal && (
                    <p className="mb-3 rounded border border-info/30 bg-info-surface/20 p-3 text-xs text-info">
                      Shadows built-in <strong>{selected?.name}</strong> for this project.
                    </p>
                  )}
                  <SkillFolderEditor
                    // Remount on skill change so the editor re-seeds from the
                    // newly selected skill's frontmatter + files.
                    key={selected?.documentId ?? selected?.id ?? 'new'}
                    skill={selected}
                    projectDocumentId={projectId}
                    readOnly={selectedIsGlobal}
                    onSave={handleSave}
                    onCancel={() => {
                      setInteracted(true);
                      setCreating(false);
                      setSelectedId(null);
                    }}
                    saving={saving}
                  />
                  {saveError && (
                    <p className="mt-2 text-[10px] uppercase tracking-widest text-error">
                      {formatApiError(saveError)}
                    </p>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-outline-variant/30 px-4 py-12 text-center text-xs text-outline">
                  Select a skill to edit, or create a new one.
                </div>
              )}

              {selected?.changelog && selected.changelog.length > 0 && (
                <div className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-4">
                  <SkillHistory
                    changelog={selected.changelog}
                    currentVersion={String(selected.version ?? 1)}
                  />
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function SkillsPage() {
  // Suspense boundary keeps useSearchParams() (deep-link `?skill=` hydration)
  // from forcing fully-dynamic prerender under Next 16.
  return (
    <Suspense fallback={null}>
      <SkillsPageInner />
    </Suspense>
  );
}
