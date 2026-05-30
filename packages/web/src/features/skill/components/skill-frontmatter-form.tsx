'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import type { FrontmatterFields } from '../lib/frontmatter';

interface SkillFrontmatterFormProps {
  fields: FrontmatterFields;
  onChange: (fields: FrontmatterFields) => void;
  /** Name is locked once a skill exists (matches the legacy editor rule). */
  isEdit: boolean;
  /** Show the "Global" checkbox only when creating a brand-new skill. */
  showGlobalToggle: boolean;
  isGlobal: boolean;
  onIsGlobalChange: (v: boolean) => void;
  disabled?: boolean;
}

/**
 * Frontmatter-as-form: edits the four managed YAML keys (name, description,
 * allowed-tools, target) so the author never touches raw YAML. `allowed-tools`
 * is a free-text chip editor seeded from the parsed list — there is no
 * canonical tool registry in web (see issue Unknowns), so any tool name is
 * accepted. Unknown frontmatter keys are preserved by the serializer, not here.
 */
export function SkillFrontmatterForm({
  fields,
  onChange,
  isEdit,
  showGlobalToggle,
  isGlobal,
  onIsGlobalChange,
  disabled,
}: SkillFrontmatterFormProps) {
  const [toolDraft, setToolDraft] = useState('');

  function set<K extends keyof FrontmatterFields>(key: K, value: FrontmatterFields[K]) {
    onChange({ ...fields, [key]: value });
  }

  function commitTool() {
    const t = toolDraft.trim().replace(/,$/, '').trim();
    if (!t) return;
    if (!fields.allowedTools.includes(t)) {
      set('allowedTools', [...fields.allowedTools, t]);
    }
    setToolDraft('');
  }

  function removeTool(tool: string) {
    set(
      'allowedTools',
      fields.allowedTools.filter((t) => t !== tool),
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-on-surface-variant">Name</label>
          <input
            value={fields.name}
            onChange={(e) => set('name', e.target.value)}
            disabled={isEdit || disabled}
            placeholder="my-skill"
            className="w-full rounded border border-outline-variant/30 px-2.5 py-1.5 text-sm disabled:bg-surface-container-low"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-on-surface-variant">Target</label>
          <select
            value={fields.target}
            onChange={(e) => set('target', e.target.value as FrontmatterFields['target'])}
            disabled={disabled}
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
          value={fields.description}
          onChange={(e) => set('description', e.target.value)}
          disabled={disabled}
          placeholder="What this skill does..."
          className="w-full rounded border border-outline-variant/30 px-2.5 py-1.5 text-sm"
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-on-surface-variant">
          Allowed tools
        </label>
        <div className="flex flex-wrap items-center gap-1.5 rounded border border-outline-variant/30 px-2 py-1.5">
          {fields.allowedTools.map((tool) => (
            <span
              key={tool}
              className="inline-flex items-center gap-1 rounded bg-surface-container-high px-1.5 py-0.5 text-[11px] text-on-surface"
            >
              {tool}
              <button
                type="button"
                onClick={() => removeTool(tool)}
                disabled={disabled}
                className="text-outline hover:text-on-surface"
                aria-label={`Remove ${tool}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <input
            value={toolDraft}
            onChange={(e) => setToolDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commitTool();
              } else if (e.key === 'Backspace' && !toolDraft && fields.allowedTools.length) {
                removeTool(fields.allowedTools[fields.allowedTools.length - 1]);
              }
            }}
            onBlur={commitTool}
            disabled={disabled}
            placeholder={fields.allowedTools.length ? 'Add tool…' : 'Read, Write, Bash…'}
            className="min-w-[80px] flex-1 bg-transparent px-1 py-0.5 text-xs outline-none"
          />
        </div>
        <p className="mt-1 text-[10px] text-outline">
          Press Enter or comma to add. Leave empty to allow all tools.
        </p>
      </div>

      {showGlobalToggle && (
        <label className="flex items-center gap-1.5 text-xs text-on-surface-variant">
          <input
            type="checkbox"
            checked={isGlobal}
            onChange={(e) => onIsGlobalChange(e.target.checked)}
            disabled={disabled}
            className="rounded"
          />
          Global (available to all projects)
        </label>
      )}
    </div>
  );
}
