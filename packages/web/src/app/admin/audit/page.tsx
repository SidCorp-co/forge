'use client';

import { useState } from 'react';
import { useAdminAudit } from '@/features/admin/hooks/use-admin';

const PAGE_SIZE = 50;

export default function AdminAuditPage() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useAdminAudit({
    action: action || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <input
          type="search"
          placeholder="Filter by action (e.g. issue.created)…"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(1);
          }}
          className="w-96 rounded-sm border border-outline-variant/50 bg-surface-container-low px-3 py-2 text-sm focus:border-primary focus:outline-none"
        />
        <div className="text-[10px] uppercase tracking-widest text-outline">
          {data?.totalCount ?? 0} event{(data?.totalCount ?? 0) === 1 ? '' : 's'}
        </div>
      </div>

      {error && <p className="text-sm text-danger">Failed to load audit log</p>}

      <div className="overflow-hidden rounded-sm border border-outline-variant/20 bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-container-low text-[10px] uppercase tracking-widest text-on-surface-variant">
            <tr>
              <th className="px-4 py-2 text-left">At</th>
              <th className="px-4 py-2 text-left">Action</th>
              <th className="px-4 py-2 text-left">Actor</th>
              <th className="px-4 py-2 text-left">Issue</th>
              <th className="px-4 py-2 text-left">Payload</th>
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
                  No audit events.
                </td>
              </tr>
            ) : (
              data?.items.map((a) => (
                <tr key={a.id} className="border-t border-outline-variant/20 align-top">
                  <td className="px-4 py-2 font-mono text-[10px] text-outline whitespace-nowrap">
                    {new Date(a.createdAt).toISOString()}
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px] text-primary">{a.action}</td>
                  <td className="px-4 py-2 font-mono text-[10px] text-outline">
                    {a.actorType}:{a.actorId.slice(0, 8)}
                  </td>
                  <td className="px-4 py-2 font-mono text-[10px] text-outline">
                    {a.issueId.slice(0, 8)}
                  </td>
                  <td className="px-4 py-2 font-mono text-[10px] text-on-surface-variant">
                    <pre className="max-w-md overflow-x-auto whitespace-pre-wrap">
                      {JSON.stringify(a.payload, null, 0)}
                    </pre>
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
