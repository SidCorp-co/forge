'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import {
  useSkills,
  useCreateSkill,
  useUpdateSkill,
  useDeleteSkill,
  useSkillSyncStatus,
  useBulkPushSkills,
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
import type { Skill } from '@/features/skill/types';

export default function SkillsPage() {
  useSetPageTitle('Skills');
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);
  const projectId = project?.id;

  const skillsQuery = useSkills(projectId);
  const syncQuery = useSkillSyncStatus(projectId);
  const createSkill = useCreateSkill();
  const updateSkill = useUpdateSkill();
  const deleteSkill = useDeleteSkill();
  const bulkPush = useBulkPushSkills();

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
      updateSkill.mutate(
        { documentId: selected.documentId ?? selected.id, data },
        {
          onSuccess: () => {
            setSelectedId(null);
          },
        },
      );
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
    if (!confirm(`Delete skill "${skill.name}"?`)) return;
    const id = skill.documentId ?? skill.id;
    deleteSkill.mutate(id, {
      onSuccess: () => {
        if (selectedId === id) setSelectedId(null);
      },
    });
  }

  function handleSyncAll() {
    if (!projectId) return;
    bulkPush.mutate({ targets: ['dev'], projectDocumentId: projectId });
  }

  const saving = createSkill.isPending || updateSkill.isPending;
  const editorOpen = creating || !!selected;
  const saveError = createSkill.error || updateSkill.error;

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
                  <SkillEditor
                    skill={selected}
                    projectDocumentId={projectId}
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
