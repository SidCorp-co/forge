'use client';

import { useMemo, useState } from 'react';
import { Brain, Search, Trash2 } from 'lucide-react';
import { useMemories, useDeleteMemory } from '@/features/memory/hooks/use-memories';
import type { Memory, MemoryCategory, MemoryRole } from '@/features/memory/types';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';

const CATEGORY_CONFIG: Record<MemoryCategory, { label: string; bg: string; text: string }> = {
  preference: { label: 'Preference', bg: 'bg-info/20', text: 'text-info' },
  correction: { label: 'Correction', bg: 'bg-warning/20', text: 'text-warning' },
  convention: { label: 'Convention', bg: 'bg-success/20', text: 'text-success' },
  tool_pattern: { label: 'Tool Pattern', bg: 'bg-tertiary/20', text: 'text-tertiary' },
};

const ROLE_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
  ceo: { label: 'CEO', bg: 'bg-error/20', text: 'text-error' },
  cto: { label: 'CTO', bg: 'bg-error/10', text: 'text-error' },
  pm: { label: 'PM', bg: 'bg-info/20', text: 'text-info' },
  po: { label: 'PO', bg: 'bg-info/10', text: 'text-info' },
  techlead: { label: 'Tech Lead', bg: 'bg-warning/20', text: 'text-warning' },
  dev: { label: 'Dev', bg: 'bg-success/20', text: 'text-success' },
  qa: { label: 'QA', bg: 'bg-tertiary/20', text: 'text-tertiary' },
  devops: { label: 'DevOps', bg: 'bg-primary/20', text: 'text-primary' },
};

const VISIBILITY_LABELS: Record<string, string> = {
  down: 'Down',
  same: 'Same',
  up: 'Up',
  all: 'All',
};

const ALL_CATEGORIES: { value: string; label: string }[] = [
  { value: 'all', label: 'All categories' },
  { value: 'preference', label: 'Preference' },
  { value: 'correction', label: 'Correction' },
  { value: 'convention', label: 'Convention' },
  { value: 'tool_pattern', label: 'Tool Pattern' },
];

const ALL_ROLES: { value: string; label: string }[] = [
  { value: 'all', label: 'All roles' },
  { value: 'ceo', label: 'CEO' },
  { value: 'cto', label: 'CTO' },
  { value: 'pm', label: 'PM' },
  { value: 'po', label: 'PO' },
  { value: 'techlead', label: 'Tech Lead' },
  { value: 'dev', label: 'Dev' },
  { value: 'qa', label: 'QA' },
  { value: 'devops', label: 'DevOps' },
];

function CategoryBadge({ category }: { category: MemoryCategory }) {
  const cfg = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.preference;
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${cfg.bg} ${cfg.text}`}>
      {cfg.label}
    </span>
  );
}

function ScopeBadge({ scope }: { scope: string }) {
  const colors = scope === 'global'
    ? 'bg-error/20 text-error'
    : scope === 'project'
      ? 'bg-primary/20 text-primary'
      : 'bg-outline/20 text-outline';
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${colors}`}>
      {scope}
    </span>
  );
}

function RoleBadge({ role }: { role?: string | null }) {
  if (!role) return <span className="text-outline">—</span>;
  const cfg = ROLE_CONFIG[role] || { label: role, bg: 'bg-outline/20', text: 'text-outline' };
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${cfg.bg} ${cfg.text}`}>
      {cfg.label}
    </span>
  );
}

function formatDate(iso: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

interface MemoryViewProps {
  projectDocumentId?: string;
}

export function MemoryView({ projectDocumentId }: MemoryViewProps) {
  const { data, isLoading } = useMemories(projectDocumentId);
  const deleteMemory = useDeleteMemory();
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');

  const memories = data?.data || [];

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { preference: 0, correction: 0, convention: 0, tool_pattern: 0 };
    for (const m of memories) {
      counts[m.category] = (counts[m.category] || 0) + 1;
    }
    return counts;
  }, [memories]);

  const filtered = useMemo(() => {
    let result = memories;
    if (categoryFilter !== 'all') {
      result = result.filter((m) => m.category === categoryFilter);
    }
    if (roleFilter !== 'all') {
      result = result.filter((m) => m.role === roleFilter);
    }
    if (search) {
      const lower = search.toLowerCase();
      result = result.filter((m) => m.content.toLowerCase().includes(lower));
    }
    return result;
  }, [memories, categoryFilter, roleFilter, search]);

  function handleDelete(memory: Memory) {
    if (!confirm('Delete this memory? This cannot be undone.')) return;
    deleteMemory.mutate(memory.documentId);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-on-surface">Memory</h1>
        <p className="text-sm text-primary-fixed">Agent memories that influence behavior</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard label="Total" value={memories.length} />
        <StatCard label="Preferences" value={categoryCounts.preference} accent="text-info" />
        <StatCard label="Corrections" value={categoryCounts.correction} accent="text-warning" />
        <StatCard label="Conventions" value={categoryCounts.convention} accent="text-success" />
        <StatCard label="Tool Patterns" value={categoryCounts.tool_pattern} accent="text-tertiary" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-outline" />
          <input
            type="text"
            placeholder="Search memories..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-full rounded border border-outline-variant/30 bg-surface-container-low pl-8 pr-3 text-xs text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="h-8 rounded border border-outline-variant/30 bg-surface-container-low px-2 text-xs text-on-surface focus:border-primary focus:outline-none"
        >
          {ALL_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="h-8 rounded border border-outline-variant/30 bg-surface-container-low px-2 text-xs text-on-surface focus:border-primary focus:outline-none"
        >
          {ALL_ROLES.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded bg-surface-container-low" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Brain className="h-8 w-8" />}
          title={memories.length === 0 ? 'No memories yet' : 'No memories match your filters'}
          description={memories.length === 0 ? 'Agent memories will appear here as the agent learns from conversations.' : 'Try adjusting your search or category filter.'}
        />
      ) : (
        <div className="overflow-x-auto rounded-sm border border-outline-variant/20">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-outline-variant/20 bg-surface-container-low text-[10px] uppercase tracking-wider text-primary-fixed">
                <th className="px-3 py-2 sm:px-4">Content</th>
                <th className="px-3 py-2">Category</th>
                <th className="hidden px-3 py-2 sm:table-cell">Scope</th>
                <th className="hidden px-3 py-2 md:table-cell">Role</th>
                <th className="hidden px-3 py-2 md:table-cell">Visibility</th>
                <th className="hidden px-3 py-2 md:table-cell">Source</th>
                <th className="hidden px-3 py-2 sm:table-cell">Retrievals</th>
                <th className="hidden px-3 py-2 md:table-cell">Created</th>
                <th className="w-10 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/10">
              {filtered.map((m) => (
                <tr key={m.documentId} className="group hover:bg-surface-container-low/50">
                  <td className="max-w-xs px-3 py-2.5 sm:px-4">
                    <p className="line-clamp-2 text-on-surface">{m.content}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 sm:hidden">
                      <CategoryBadge category={m.category} />
                      <ScopeBadge scope={m.scope} />
                      {m.role && <RoleBadge role={m.role} />}
                    </div>
                  </td>
                  <td className="hidden px-3 py-2.5 sm:table-cell">
                    <CategoryBadge category={m.category} />
                  </td>
                  <td className="hidden px-3 py-2.5 sm:table-cell">
                    <ScopeBadge scope={m.scope} />
                  </td>
                  <td className="hidden px-3 py-2.5 md:table-cell">
                    <RoleBadge role={m.role} />
                  </td>
                  <td className="hidden px-3 py-2.5 text-outline md:table-cell">
                    {m.visibility ? VISIBILITY_LABELS[m.visibility] || m.visibility : '—'}
                  </td>
                  <td className="hidden px-3 py-2.5 text-outline md:table-cell">{m.source}</td>
                  <td className="hidden px-3 py-2.5 tabular-nums text-outline sm:table-cell">{m.retrievalCount}</td>
                  <td className="hidden px-3 py-2.5 text-outline md:table-cell">{formatDate(m.createdAt)}</td>
                  <td className="px-3 py-2.5">
                    <button
                      onClick={() => handleDelete(m)}
                      disabled={deleteMemory.isPending}
                      className="rounded p-1 text-outline opacity-0 transition-opacity hover:bg-error/10 hover:text-error group-hover:opacity-100 disabled:opacity-50"
                      title="Delete memory"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
