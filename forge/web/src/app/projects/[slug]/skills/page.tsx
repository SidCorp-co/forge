'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import {
  useCreateSkill,
  useUpdateSkill,
  useDeleteSkill,
  useSkillSyncStatus,
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
import { SkillEditor } from '@/features/skill/components/skill-editor';
import { SkillSyncPanel } from '@/features/skill/components/skill-sync-panel';
import { SkillHistory } from '@/features/skill/components/skill-history';
import { Skeleton } from '@/components/ui/skeleton';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { formatApiError } from '@/lib/api/error';
import type { Skill, EffectiveSkill } from '@/features/skill/types';
import { RotateCcw } from 'lucide-react';

export default function SkillsPage() {
  useSetPageTitle('Skills');
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);
  const projectId = project?.id;

  // EPIC 6 (ISS-290) — `/effective` returns globals merged with this project's
  // overrides. Each row carries `isOverridden` + `globalSkillMd` for diff view.
  const skillsQuery = useEffectiveSkills(projectId);
  const syncQuery = useSkillSyncStatus(projectId);
  const createSkill = useCreateSkill();
  const updateSkill = useUpdateSkill();
  const deleteSkill = useDeleteSkill();
  const bulkPush = useBulkPushSkills();
  const upsertOverride = useUpsertSkillOverride();
  const deleteOverride = useDeleteSkillOverride();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const skills = skillsQuery.data?.data ?? [];
  const syncStatuses = syncQuery.data?.data ?? [];

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

  const selected = useMemo(
    () => skills.find((s) => (s.documentId ?? s.id) === selectedId) ?? null,
    [skills, selectedId],
  );

  function handleSort(field: SortField) {
    if (field === sortField) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  }

  function handleSave(data: {
    name: string;
    description: string;
    skillMd: string;
    target: 'dev' | 'cloud' | 'all';
    isGlobal: boolean;
  }) {
    if (selected) {
      // Editing a global skill in a project context = create/update an override
      // (server stores in `project_skill_overrides`, not the global `skills` row).
      const isGlobalRow = selected.scope === 'global';
      if (isGlobalRow && projectId) {
        upsertOverride.mutate(
          { projectId, skillId: selected.id, skillMdOverride: data.skillMd },
          { onSuccess: () => setSelectedId(null) },
        );
      } else {
        updateSkill.mutate(
          { documentId: selected.documentId ?? selected.id, data },
          { onSuccess: () => setSelectedId(null) },
        );
      }
    } else if (projectId) {
      createSkill.mutate(
        { ...data, projectId: data.isGlobal ? undefined : projectId },
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
        if (selectedId === id) setSelectedId(null);
      },
    });
  }

  function handleResetOverride(skill: Skill) {
    if (!projectId) return;
    deleteOverride.mutate(
      { projectId, skillId: skill.id },
      {
        onSuccess: () => {
          if (selectedId === (skill.documentId ?? skill.id)) setSelectedId(null);
        },
      },
    );
  }

  function handleSyncAll() {
    if (!projectId) return;
    bulkPush.mutate({ targets: ['dev'], projectDocumentId: projectId });
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
            syncStatuses={syncStatuses}
            onSyncAll={handleSyncAll}
            syncing={bulkPush.isPending}
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
                  <SkillEditor
                    skill={selected}
                    projectDocumentId={projectId}
                    globalSkillMd={editorGlobalSkillMd}
                    onSave={handleSave}
                    onCancel={() => {
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
