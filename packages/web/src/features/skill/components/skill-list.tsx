'use client';

import { ArrowDown, ArrowUp, ArrowUpDown, Code2, Globe, Monitor, Laptop, Search, Trash2 } from 'lucide-react';
import type { Skill, EffectiveSkill } from '../types';

const TARGET_CONFIG: Record<string, { label: string; icon: typeof Globe; className: string }> = {
  dev: { label: 'Dev', icon: Monitor, className: 'bg-surface-container-high text-on-surface-variant' },
  cloud: { label: 'Cloud', icon: Globe, className: 'bg-info-surface/30 text-info' },
  all: { label: 'All', icon: Laptop, className: 'bg-surface-variant text-tertiary' },
};

export type SortField = 'name' | 'version';
export type SortDirection = 'asc' | 'desc';

interface SkillListProps {
  skills: Skill[] | EffectiveSkill[];
  onSelect: (skill: Skill) => void;
  onDelete: (skill: Skill) => void;
  selectedId?: string;
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
  filter: string;
  onFilterChange: (value: string) => void;
}

type ScopeKind = 'default' | 'shadow' | 'project';

// ISS-388 — a row is a read-only built-in default (global), an editable project
// skill, or a project skill that shadows a same-name built-in default.
function scopeKind(s: Skill | EffectiveSkill): ScopeKind {
  if (s.scope === 'global') return 'default';
  return (s as EffectiveSkill).shadowsGlobal ? 'shadow' : 'project';
}

const SCOPE_BADGE: Record<ScopeKind, { label: string; title: string; className: string }> = {
  default: {
    label: 'Default',
    title: 'Built-in template (read-only). Apply default to create an editable project copy.',
    className: 'bg-warning-dim/20 text-warning',
  },
  shadow: {
    label: 'Shadows default',
    title: 'Project skill shadowing a same-name built-in default for this project.',
    className: 'bg-info-surface/30 text-info',
  },
  project: {
    label: 'Project',
    title: 'Project-scoped skill.',
    className: 'bg-surface-variant text-tertiary',
  },
};

function SortIcon({ field, activeField, direction }: { field: SortField; activeField: SortField; direction: SortDirection }) {
  if (field !== activeField) return <ArrowUpDown className="h-3 w-3 text-outline" />;
  return direction === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
}

export function SkillList({ skills, onSelect, onDelete, selectedId, sortField, sortDirection, onSort, filter, onFilterChange }: SkillListProps) {
  if (skills.length === 0 && !filter) {
    return (
      <div className="rounded-lg border border-dashed border-outline-variant px-4 py-8 text-center">
        <Code2 className="mx-auto h-8 w-8 text-outline" />
        <p className="mt-2 text-sm text-primary-fixed">No skills yet</p>
        <p className="text-xs text-outline">Create a skill to get started.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-outline" />
        <input
          type="text"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Filter skills..."
          className="w-full rounded-lg border border-outline-variant/30 bg-surface-container-low py-2 pl-9 pr-3 text-sm text-on-surface-variant placeholder-gray-400 outline-none focus:border-outline-variant focus:ring-1 focus:ring-outline-variant"
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-outline-variant/30">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-outline-variant/20 bg-surface-container-low text-xs text-primary-fixed">
              <th
                className="cursor-pointer px-4 py-2.5 font-medium hover:text-on-surface-variant"
                onClick={() => onSort('name')}
              >
                <span className="inline-flex items-center gap-1">
                  Name
                  <SortIcon field="name" activeField={sortField} direction={sortDirection} />
                </span>
              </th>
              <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Description</th>
              <th
                className="cursor-pointer px-4 py-2.5 font-medium hover:text-on-surface-variant"
                onClick={() => onSort('version')}
              >
                <span className="inline-flex items-center gap-1">
                  Version
                  <SortIcon field="version" activeField={sortField} direction={sortDirection} />
                </span>
              </th>
              <th className="px-4 py-2.5 font-medium">Target</th>
              <th className="px-4 py-2.5 font-medium">Scope</th>
              <th className="px-4 py-2.5 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {skills.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-outline">
                  No skills match your filter.
                </td>
              </tr>
            ) : (
              skills.map((skill) => {
                const target = TARGET_CONFIG[skill.target ?? 'dev'] || TARGET_CONFIG.dev;
                const TargetIcon = target.icon;
                const isSelected = skill.documentId === selectedId;
                return (
                  <tr
                    key={skill.documentId}
                    onClick={() => onSelect(skill)}
                    className={`cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-info-surface/20'
                        : 'bg-surface-container-low hover:bg-surface-container-low'
                    }`}
                  >
                    <td className="min-w-0 px-4 py-2.5">
                      <span className="font-medium text-on-surface">{skill.name}</span>
                    </td>
                    <td className="hidden max-w-[200px] truncate px-4 py-2.5 text-xs text-outline sm:table-cell">
                      {skill.description}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-primary-fixed">v{skill.version}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium ${target.className}`}>
                        <TargetIcon className="h-2.5 w-2.5" />
                        {target.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {(() => {
                        const badge = SCOPE_BADGE[scopeKind(skill)];
                        return (
                          <span
                            title={badge.title}
                            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}
                          >
                            {badge.label}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-2.5">
                      {skill.scope !== 'global' && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onDelete(skill); }}
                          className="rounded p-1 text-outline hover:bg-danger-surface hover:text-danger"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
