'use client';

import { useState } from 'react';
import { Save, X, FileDiff } from 'lucide-react';
import type { Skill } from '../types';
import { SkillDiffView } from './skill-diff-view';

interface SkillEditorProps {
  skill?: Skill | null;
  projectDocumentId?: string;
  onSave: (data: {
    name: string;
    description: string;
    skillMd: string;
    target: 'dev' | 'cloud' | 'all';
    isGlobal: boolean;
  }) => void;
  onCancel: () => void;
  saving?: boolean;
  /** When the skill is a project override of a global, pass the global SKILL.md to enable diff. */
  globalSkillMd?: string | null;
}

export function SkillEditor({ skill, onSave, onCancel, saving, globalSkillMd }: SkillEditorProps) {
  const [name, setName] = useState(skill?.name || '');
  const [description, setDescription] = useState(skill?.description || '');
  const [skillMd, setSkillMd] = useState(skill?.skillMd || '');
  const [target, setTarget] = useState<'dev' | 'cloud' | 'all'>(skill?.target || 'dev');
  const [isGlobal, setIsGlobal] = useState(skill?.isGlobal || false);
  const [showDiff, setShowDiff] = useState(false);

  const isEdit = !!skill;
  const canSave = name.trim() && description.trim() && skillMd.trim();
  const canDiff = !!globalSkillMd && (skillMd ?? '') !== globalSkillMd;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    onSave({ name: name.trim(), description: description.trim(), skillMd, target, isGlobal });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-on-surface">
          {isEdit ? 'Edit Skill' : 'New Skill'}
        </h3>
        <button type="button" onClick={onCancel} className="text-outline hover:text-on-surface-variant">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-on-surface-variant">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isEdit}
            placeholder="my-skill"
            className="w-full rounded border border-outline-variant/30 px-2.5 py-1.5 text-sm disabled:bg-surface-container-low"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-on-surface-variant">Target</label>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value as 'dev' | 'cloud' | 'all')}
            className="w-full rounded border border-outline-variant/30 px-2.5 py-1.5 text-sm"
          >
            <option value="dev">Dev (full content synced locally)</option>
            <option value="cloud">Cloud (thin guide locally, full content via API)</option>
            <option value="all">All (guide locally + full on cloud agents)</option>
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-on-surface-variant">Description</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this skill does..."
          className="w-full rounded border border-outline-variant/30 px-2.5 py-1.5 text-sm"
        />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="block text-xs font-medium text-on-surface-variant">SKILL.md Content</label>
          {canDiff && (
            <button
              type="button"
              onClick={() => setShowDiff((v) => !v)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-info hover:bg-info-surface/20"
            >
              <FileDiff className="h-3 w-3" />
              {showDiff ? 'Hide diff' : 'Diff vs global'}
            </button>
          )}
        </div>
        {showDiff && globalSkillMd ? (
          <SkillDiffView base={globalSkillMd} current={skillMd} />
        ) : (
          <textarea
            value={skillMd}
            onChange={(e) => setSkillMd(e.target.value)}
            rows={16}
            placeholder="# My Skill\n\nInstructions for the agent..."
            className="w-full rounded border border-outline-variant/30 px-2.5 py-1.5 font-mono text-sm"
          />
        )}
      </div>

      {(target === 'cloud' || target === 'all') && (
        <div className="rounded border border-info/30 bg-info-surface/20 p-3">
          <p className="text-xs text-info">
            <strong>Cloud guide preview:</strong> Local .claude/skills/{name}/SKILL.md will contain a thin guide
            that instructs the agent to call <code className="bg-info-surface/30 px-1 rounded">forge_skills get {name}</code> for
            the full content.
          </p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-on-surface-variant">
          <input
            type="checkbox"
            checked={isGlobal}
            onChange={(e) => setIsGlobal(e.target.checked)}
            className="rounded"
          />
          Global (available to all projects)
        </label>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-1.5 text-xs text-primary-fixed hover:bg-surface-container-high"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSave || saving}
          className="inline-flex items-center gap-1 rounded bg-on-primary px-3 py-1.5 text-xs text-on-surface hover:bg-surface-container disabled:opacity-50"
        >
          <Save className="h-3 w-3" />
          {saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}
        </button>
      </div>
    </form>
  );
}
