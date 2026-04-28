'use client';

import { useState } from 'react';
import { useAdminUsers } from '@/features/admin/hooks/use-admin';

const PAGE_SIZE = 50;

export default function AdminUsersPage() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useAdminUsers({
    q: q || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <input
          type="search"
          placeholder="Search email…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          className="w-80 rounded-sm border border-outline-variant/50 bg-surface-container-low px-3 py-2 text-sm focus:border-primary focus:outline-none"
        />
        <div className="text-[10px] uppercase tracking-widest text-outline">
          {data?.totalCount ?? 0} user{(data?.totalCount ?? 0) === 1 ? '' : 's'}
        </div>
      </div>

      {error && (
        <p className="text-sm text-danger">Failed to load users</p>
      )}

      <div className="overflow-hidden rounded-sm border border-outline-variant/20 bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-container-low text-[10px] uppercase tracking-widest text-on-surface-variant">
            <tr>
              <th className="px-4 py-2 text-left">Email</th>
              <th className="px-4 py-2 text-left">Verified</th>
              <th className="px-4 py-2 text-left">Created</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-xs text-outline">
                  Loading…
                </td>
              </tr>
            ) : data?.items.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-xs text-outline">
                  No users.
                </td>
              </tr>
            ) : (
              data?.items.map((u) => (
                <tr key={u.id} className="border-t border-outline-variant/20">
                  <td className="px-4 py-2 font-medium">{u.email}</td>
                  <td className="px-4 py-2 text-[10px] uppercase tracking-widest">
                    {u.emailVerifiedAt ? 'yes' : 'no'}
                  </td>
                  <td className="px-4 py-2 font-mono text-[10px] text-outline">
                    {new Date(u.createdAt).toISOString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        setPage={setPage}
        totalCount={data?.totalCount ?? 0}
        pageSize={PAGE_SIZE}
      />
    </div>
  );
}

function Pagination({
  page,
  setPage,
  totalCount,
  pageSize,
}: {
  page: number;
  setPage: (p: number) => void;
  totalCount: number;
  pageSize: number;
}) {
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  return (
    <div className="flex items-center justify-end gap-2 text-[10px] uppercase tracking-widest">
      <button
        type="button"
        onClick={() => setPage(Math.max(1, page - 1))}
        disabled={page === 1}
        className="rounded-sm border border-outline-variant/30 bg-surface-container-high px-3 py-1 disabled:opacity-50"
      >
        Prev
      </button>
      <span>
        {page} / {pageCount}
      </span>
      <button
        type="button"
        onClick={() => setPage(Math.min(pageCount, page + 1))}
        disabled={page >= pageCount}
        className="rounded-sm border border-outline-variant/30 bg-surface-container-high px-3 py-1 disabled:opacity-50"
      >
        Next
      </button>
    </div>
  );
}
