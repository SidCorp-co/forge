'use client';

import { useMemo, useState } from 'react';
import { Save, X, FileDiff } from 'lucide-react';
import type { Skill, SkillFile } from '../types';
import {
  fieldsFromFrontmatter,
  parseFrontmatter,
  serializeFrontmatter,
  type FrontmatterFields,
} from '../lib/frontmatter';
import { SkillFrontmatterForm } from './skill-frontmatter-form';
import { SkillFileTree, SKILL_MD_PATH } from './skill-file-tree';
import { SkillFileEditor } from './skill-file-editor';
import { SkillDiffView } from './skill-diff-view';

export interface SkillFolderSavePayload {
  name: string;
  description: string;
  skillMd: string;
  target: 'dev' | 'cloud' | 'all';
  isGlobal: boolean;
  files: SkillFile[];
}

interface SkillFolderEditorProps {
  skill?: Skill | null;
  projectDocumentId?: string;
  onSave: (data: SkillFolderSavePayload) => void;
  onCancel: () => void;
  saving?: boolean;
  /** When this is an override of a global, the global SKILL.md enables the diff. */
  globalSkillMd?: string | null;
}

type DiffMode = 'none' | 'global' | 'saved';

/**
 * Folder-first Skill Studio editor — replaces the legacy single-textarea
 * `SkillEditor`. Frontmatter is edited via a form (the raw YAML block never
 * surfaces); the SKILL.md body + every file in `files[]` are edited in a
 * CodeMirror pane chosen from a file tree. Saving serializes the form + body
 * back into one SKILL.md and emits it together with `files` so the server can
 * version-bump the whole folder.
 *
 * The parent is expected to remount this on skill change (via React `key`), so
 * the initial state is seeded once from the skill prop.
 */
export function SkillFolderEditor({
  skill,
  onSave,
  onCancel,
  saving,
  globalSkillMd,
}: SkillFolderEditorProps) {
  const isEdit = !!skill;

  const parsed = useMemo(() => parseFrontmatter(skill?.skillMd ?? ''), [skill]);

  const initialFields = useMemo(
    () =>
      fieldsFromFrontmatter(parsed.frontmatter, {
        name: skill?.name ?? '',
        description: skill?.description ?? '',
        target: skill?.target ?? 'dev',
        allowedTools: skill?.tools ?? [],
      }),
    [parsed, skill],
  );

  const [fields, setFields] = useState<FrontmatterFields>(() => initialFields);
  const [body, setBody] = useState(parsed.body);
  const [files, setFiles] = useState<SkillFile[]>(skill?.files ?? []);
  const [isGlobal, setIsGlobal] = useState(skill?.isGlobal ?? false);
  const [selectedPath, setSelectedPath] = useState<string>(SKILL_MD_PATH);
  const [diffMode, setDiffMode] = useState<DiffMode>('none');

  // Canonical "no user edits" serialization + files snapshot, captured once
  // (the parent remounts this on skill change via React `key`). Re-serialization
  // is NOT byte-identical to hand-authored YAML (known keys hoisted, quotes
  // stripped), so dirtiness is measured against this re-serialized baseline —
  // not the raw skill.skillMd — to avoid a spurious version-bump / diff on a
  // no-op save (review finding #1).
  const [baseline] = useState(() =>
    serializeFrontmatter(initialFields, parsed.body, parsed.frontmatter),
  );
  const [filesBaseline] = useState(() => JSON.stringify(skill?.files ?? []));

  const currentSkillMd = useMemo(
    () => serializeFrontmatter(fields, body, parsed.frontmatter),
    [fields, body, parsed.frontmatter],
  );

  const selectedFile =
    selectedPath === SKILL_MD_PATH ? null : files.find((f) => f.path === selectedPath) ?? null;
  // Selected path may dangle after a delete — fall back to SKILL.md.
  const effectivePath = selectedPath !== SKILL_MD_PATH && !selectedFile ? SKILL_MD_PATH : selectedPath;

  const isDirty =
    currentSkillMd !== baseline || JSON.stringify(files) !== filesBaseline;
  // On edit, block save when nothing changed vs baseline — a no-op PUT would
  // otherwise version-bump + write a changelog entry for an identical body.
  const canSave =
    !!fields.name.trim() && !!fields.description.trim() && !!body.trim() && (!isEdit || isDirty);
  const canDiffGlobal = !!globalSkillMd && globalSkillMd !== currentSkillMd;
  const canDiffSaved = isEdit && currentSkillMd !== baseline;

  function updateFileContent(content: string) {
    if (!selectedFile) return;
    setFiles((prev) => prev.map((f) => (f.path === selectedFile.path ? { ...f, content } : f)));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    onSave({
      name: fields.name.trim(),
      description: fields.description.trim(),
      skillMd: currentSkillMd,
      target: (fields.target || 'dev') as 'dev' | 'cloud' | 'all',
      isGlobal,
      files,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-on-surface">{isEdit ? 'Edit Skill' : 'New Skill'}</h3>
        <button type="button" onClick={onCancel} className="text-outline hover:text-on-surface-variant">
          <X className="h-4 w-4" />
        </button>
      </div>

      <SkillFrontmatterForm
        fields={fields}
        onChange={setFields}
        isEdit={isEdit}
        showGlobalToggle={!isEdit}
        isGlobal={isGlobal}
        onIsGlobalChange={setIsGlobal}
        disabled={saving}
      />

      {(fields.target === 'cloud' || fields.target === 'all') && (
        <div className="rounded border border-info/30 bg-info-surface/20 p-3">
          <p className="text-xs text-info">
            <strong>Cloud guide preview:</strong> Local .claude/skills/{fields.name || 'my-skill'}/SKILL.md
            will contain a thin guide that instructs the agent to call{' '}
            <code className="rounded bg-info-surface/30 px-1">forge_skills get {fields.name || 'my-skill'}</code>{' '}
            for the full content.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
        <SkillFileTree
          files={files}
          selectedPath={effectivePath}
          onSelectPath={setSelectedPath}
          onFilesChange={setFiles}
          readOnly={saving}
        />
        {effectivePath === SKILL_MD_PATH ? (
          <SkillFileEditor
            path={SKILL_MD_PATH}
            content={body}
            encoding="utf8"
            onChange={setBody}
            readOnly={saving}
          />
        ) : selectedFile ? (
          <SkillFileEditor
            path={selectedFile.path}
            content={selectedFile.content}
            encoding={selectedFile.encoding}
            onChange={updateFileContent}
            readOnly={saving}
          />
        ) : null}
      </div>

      {(canDiffGlobal || canDiffSaved) && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {canDiffGlobal && (
              <button
                type="button"
                onClick={() => setDiffMode((m) => (m === 'global' ? 'none' : 'global'))}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-info hover:bg-info-surface/20"
              >
                <FileDiff className="h-3 w-3" />
                {diffMode === 'global' ? 'Hide diff' : 'Diff vs global'}
              </button>
            )}
            {canDiffSaved && (
              <button
                type="button"
                onClick={() => setDiffMode((m) => (m === 'saved' ? 'none' : 'saved'))}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-info hover:bg-info-surface/20"
              >
                <FileDiff className="h-3 w-3" />
                {diffMode === 'saved' ? 'Hide diff' : 'Diff vs last saved'}
              </button>
            )}
          </div>
          {diffMode === 'global' && globalSkillMd && (
            <SkillDiffView base={globalSkillMd} current={currentSkillMd} />
          )}
          {diffMode === 'saved' && (
            <SkillDiffView base={baseline} current={currentSkillMd} />
          )}
        </div>
      )}

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
