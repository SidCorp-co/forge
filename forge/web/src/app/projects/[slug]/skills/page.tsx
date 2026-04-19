'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Plus, RefreshCw } from 'lucide-react';
import { useProject } from '@/features/project/hooks/use-projects';
import { useSkills, useCreateSkill, useUpdateSkill, useDeleteSkill, useSkillSyncStatus, useBulkPushSkills } from '@/features/skill/hooks/use-skills';
import { SkillList, type SortField, type SortDirection } from '@/features/skill/components/skill-list';
import { SkillEditor } from '@/features/skill/components/skill-editor';
import { SkillHistory } from '@/features/skill/components/skill-history';
import type { Skill } from '@/features/skill/types';

export default function SkillsPage() {
  const { slug } = useParams<{ slug: string }>();
  const { data: projectData } = useProject(slug);
  const project = projectData?.data;
  const projectDocId = project?.documentId;

  const { data: skillsData, isLoading } = useSkills(projectDocId);
  const { data: syncData } = useSkillSyncStatus(projectDocId);
  const createSkill = useCreateSkill();
  const updateSkill = useUpdateSkill();
  const deleteSkill = useDeleteSkill();
  const bulkPush = useBulkPushSkills();

  const [mode, setMode] = useState<'list' | 'create' | 'edit'>('list');
  const [selected, setSelected] = useState<Skill | null>(null);
  const [needsSync, setNeedsSync] = useState(false);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [filterText, setFilterText] = useState('');

  const skills = skillsData?.data || [];
  const syncStatuses = syncData?.data || [];
  const hasDevices = syncStatuses.some((s) => s.devices.length > 0);
  // Show sync button if local state says so OR if server reports outdated devices
  const hasOutdated = syncStatuses.some((s) => s.devices.some((d) => !d.inSync));
  const showSync = needsSync || hasOutdated;

  const filteredAndSorted = useMemo(() => {
    let result = skills;
    if (filterText) {
      const lower = filterText.toLowerCase();
      result = result.filter((s) => s.name.toLowerCase().includes(lower) || s.description.toLowerCase().includes(lower));
    }
    result = [...result].sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      const cmp = aVal.localeCompare(bVal);
      return sortDirection === 'asc' ? cmp : -cmp;
    });
    return result;
  }, [skills, filterText, sortField, sortDirection]);

  function handleSort(field: SortField) {
    if (field === sortField) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  }

  function handleSelect(skill: Skill) {
    setSelected(skill);
    setMode('list');
  }

  function handleCreate(data: { name: string; description: string; skillMd: string; target: 'dev' | 'cloud' | 'all'; isGlobal: boolean }) {
    createSkill.mutate(
      { ...data, project: projectDocId ? { documentId: projectDocId } : undefined },
      { onSuccess: () => { setMode('list'); setNeedsSync(true); } },
    );
  }

  function handleUpdate(data: { name: string; description: string; skillMd: string; target: 'dev' | 'cloud' | 'all'; isGlobal: boolean }) {
    if (!selected) return;
    updateSkill.mutate(
      { documentId: selected.documentId, data },
      { onSuccess: () => { setMode('list'); setSelected(null); setNeedsSync(true); } },
    );
  }

  function handleDelete(skill: Skill) {
    if (!confirm(`Delete skill "${skill.name}"?`)) return;
    deleteSkill.mutate(skill.documentId, {
      onSuccess: () => {
        if (selected?.documentId === skill.documentId) setSelected(null);
        setNeedsSync(true);
      },
    });
  }

  function handleSyncAll() {
    if (!projectDocId) return;
    const deviceIds = new Set<string>();
    syncStatuses.forEach((s) => s.devices.forEach((d) => deviceIds.add(d.deviceId)));
    const targets = [...deviceIds].map((id) => `device:${id}`);
    if (targets.length) {
      bulkPush.mutate(
        { targets, projectDocumentId: projectDocId },
        { onSuccess: () => setNeedsSync(false) },
      );
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-on-surface">Skills</h1>
          <p className="text-sm text-primary-fixed">Manage skills for {project?.name || slug}</p>
        </div>
        <div className="flex items-center gap-2">
          {showSync && hasDevices && (
            <button
              onClick={handleSyncAll}
              disabled={bulkPush.isPending}
              className="inline-flex items-center gap-1 rounded bg-warning px-3 py-1.5 text-xs text-white hover:bg-warning-dim disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${bulkPush.isPending ? 'animate-spin' : ''}`} />
              {bulkPush.isPending ? 'Syncing...' : 'Sync to Devices'}
            </button>
          )}
          {mode === 'list' && (
            <button
              onClick={() => { setMode('create'); setSelected(null); }}
              className="inline-flex items-center gap-1 rounded bg-on-primary px-3 py-1.5 text-xs text-on-surface hover:bg-surface-container"
            >
              <Plus className="h-3 w-3" />
              New Skill
            </button>
          )}
        </div>
      </div>

      {mode === 'create' && (
        <div className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-4">
          <SkillEditor
            projectDocumentId={projectDocId}
            onSave={handleCreate}
            onCancel={() => setMode('list')}
            saving={createSkill.isPending}
          />
        </div>
      )}

      {mode === 'edit' && selected && (
        <div className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-4">
          <SkillEditor
            skill={selected}
            projectDocumentId={projectDocId}
            onSave={handleUpdate}
            onCancel={() => setMode('list')}
            saving={updateSkill.isPending}
          />
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-outline">Loading skills...</p>
      ) : (
        <SkillList
          skills={filteredAndSorted}
          onSelect={handleSelect}
          onDelete={handleDelete}
          selectedId={selected?.documentId}
          sortField={sortField}
          sortDirection={sortDirection}
          onSort={handleSort}
          filter={filterText}
          onFilterChange={setFilterText}
        />
      )}

      {selected && (
        <div className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-on-surface">{selected.name}</h3>
            <button
              onClick={() => setMode('edit')}
              className="rounded px-2 py-1 text-xs text-primary-fixed hover:bg-surface-container-high"
            >
              Edit
            </button>
          </div>

          <div className="mt-3 space-y-1 text-xs text-primary-fixed">
            <p>Version: v{selected.version}</p>
            <p>Target: {selected.target}</p>
            {selected.contentHash && (
              <p>Hash: {selected.contentHash.slice(0, 12)}...</p>
            )}
          </div>

          {selected.target !== 'dev' && selected.localGuide && (
            <div className="mt-3 rounded border border-info/20 bg-info-surface/20 p-2">
              <p className="text-[10px] font-medium text-info">Cloud Guide Preview</p>
              <pre className="mt-1 whitespace-pre-wrap text-[10px] text-info">{selected.localGuide}</pre>
            </div>
          )}

          <div className="mt-3">
            <SkillHistory
              changelog={selected.changelog || []}
              currentVersion={selected.version}
            />
          </div>
        </div>
      )}
    </div>
  );
}
