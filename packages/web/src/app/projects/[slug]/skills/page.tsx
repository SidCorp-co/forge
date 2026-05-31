'use client';

import { Suspense, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import {
  useCreateSkill,
  useUpdateSkill,
  useDeleteSkill,
  useProjectSkillSyncStatus,
  useBulkPushSkills,
  useEffectiveSkills,
  useUpsertSkillOverride,
  useDeleteSkillOverride,
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
import { RotateCcw } from 'lucide-react';

function SkillsPageInner() {
  useSetPageTitle('Skills');
  const { slug } = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const project = useProjectBySlug(slug);
  const projectId = project?.id;

  // EPIC 6 (ISS-290) — `/effective` returns globals merged with this project's
  // overrides. Each row carries `isOverridden` + `globalSkillMd` for diff view.
  const skillsQuery = useEffectiveSkills(projectId);
  const syncQuery = useProjectSkillSyncStatus(projectId);
  const createSkill = useCreateSkill();
  const updateSkill = useUpdateSkill();
  const deleteSkill = useDeleteSkill();
  const bulkPush = useBulkPushSkills();
  const upsertOverride = useUpsertSkillOverride();
  const deleteOverride = useDeleteSkillOverride();

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
    if (selected) {
      // Editing a global skill in a project context = create/update an override
      // (server stores in `project_skill_overrides`, not the global `skills` row).
      const isGlobalRow = selected.scope === 'global';
      if (isGlobalRow && projectId) {
        upsertOverride.mutate(
          {
            projectId,
            skillId: selected.id,
            skillMdOverride: data.skillMd,
            files: data.files,
          },
          { onSuccess: () => setSelectedId(null) },
        );
      } else {
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
      }
    } else if (projectId) {
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
    // Don't allow deleting a global builtin from a project page; prompt for
    // "reset to global" instead via handleResetOverride.
    if (skill.scope === 'global') {
      if (
        (skill as EffectiveSkill).isOverridden &&
        projectId &&
        confirm(`Reset override for "${skill.name}" back to the global skill?`)
      ) {
        handleResetOverride(skill);
      }
      return;
    }
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

  function handleResetOverride(skill: Skill) {
    if (!projectId) return;
    deleteOverride.mutate(
      { projectId, skillId: skill.id },
      {
        onSuccess: () => {
          if (activeSelectedId === (skill.documentId ?? skill.id)) {
            setInteracted(true);
            setSelectedId(null);
          }
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

  const saving =
    createSkill.isPending || updateSkill.isPending || upsertOverride.isPending;
  const editorOpen = creating || !!selected;
  const saveError =
    createSkill.error || updateSkill.error || upsertOverride.error;
  const selectedEffective = selected as EffectiveSkill | null;
  const editorGlobalSkillMd =
    selectedEffective?.isOverridden && selectedEffective.globalSkillMd
      ? selectedEffective.globalSkillMd
      : null;

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
                  {selectedEffective?.isOverridden && projectId && (
                    <div className="mb-3 flex items-center justify-between rounded border border-info/30 bg-info-surface/20 px-3 py-2 text-xs text-info">
                      <span>
                        <strong>Override active.</strong> This project replaces the global skill content.
                      </span>
                      <button
                        type="button"
                        onClick={() => handleResetOverride(selected!)}
                        disabled={deleteOverride.isPending}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium text-info hover:bg-info-surface/30 disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Reset to global
                      </button>
                    </div>
                  )}
                  {selected?.scope === 'global' && !selectedEffective?.isOverridden && (
                    <p className="mb-3 rounded border border-outline-variant/30 bg-surface-container-low p-3 text-xs text-on-surface-variant">
                      Editing this <strong>global</strong> skill creates a per-project override. The original global skill is unaffected.
                    </p>
                  )}
                  <SkillFolderEditor
                    // Remount on skill change so the editor re-seeds from the
                    // newly selected skill's frontmatter + files.
                    key={selected?.documentId ?? selected?.id ?? 'new'}
                    skill={selected}
                    projectDocumentId={projectId}
                    globalSkillMd={editorGlobalSkillMd}
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
