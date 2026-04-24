'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAdminProjects } from '@/features/admin/hooks/use-admin';

const PAGE_SIZE = 50;

export default function AdminProjectsPage() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useAdminProjects({
    q: q || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <input
          type="search"
          placeholder="Search slug or name…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          className="w-80 rounded-sm border border-outline-variant/50 bg-surface-container-low px-3 py-2 text-sm focus:border-primary focus:outline-none"
        />
        <div className="text-[10px] uppercase tracking-widest text-outline">
          {data?.totalCount ?? 0} project{(data?.totalCount ?? 0) === 1 ? '' : 's'}
        </div>
      </div>

      {error && <p className="text-sm text-danger">Failed to load projects</p>}

      <div className="overflow-hidden rounded-sm border border-outline-variant/20 bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-container-low text-[10px] uppercase tracking-widest text-on-surface-variant">
            <tr>
              <th className="px-4 py-2 text-left">Slug</th>
              <th className="px-4 py-2 text-left">Name</th>
              <th className="px-4 py-2 text-left">Owner</th>
              <th className="px-4 py-2 text-right">Members</th>
              <th className="px-4 py-2 text-left">Created</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-xs text-outline">
                  Loading…
                </td>
              </tr>
            ) : data?.items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-xs text-outline">
                  No projects.
                </td>
              </tr>
            ) : (
              data?.items.map((p) => (
                <tr key={p.id} className="border-t border-outline-variant/20">
                  <td className="px-4 py-2 font-mono text-[11px]">
                    <Link href={`/projects/${p.slug}`} className="text-primary hover:underline">
                      {p.slug}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{p.name}</td>
                  <td className="px-4 py-2 text-[11px] text-on-surface-variant">
                    {p.ownerEmail ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[11px]">
                    {p.memberCount}
                  </td>
                  <td className="px-4 py-2 font-mono text-[10px] text-outline">
                    {new Date(p.createdAt).toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
