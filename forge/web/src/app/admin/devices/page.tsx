'use client';

import { useState } from 'react';
import { useAdminDevices } from '@/features/admin/hooks/use-admin';

const PAGE_SIZE = 50;
type Status = 'all' | 'online' | 'offline' | 'revoked';

export default function AdminDevicesPage() {
  const [status, setStatus] = useState<Status>('all');
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useAdminDevices({
    ...(status === 'all' ? {} : { status }),
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as Status);
            setPage(1);
          }}
          className="rounded-sm border border-outline-variant/50 bg-surface-container-low px-3 py-2 text-sm"
        >
          <option value="all">All statuses</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="revoked">Revoked</option>
        </select>
        <div className="text-[10px] uppercase tracking-widest text-outline">
          {data?.totalCount ?? 0} device{(data?.totalCount ?? 0) === 1 ? '' : 's'}
        </div>
      </div>

      {error && <p className="text-sm text-danger">Failed to load devices</p>}

      <div className="overflow-hidden rounded-sm border border-outline-variant/20 bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-container-low text-[10px] uppercase tracking-widest text-on-surface-variant">
            <tr>
              <th className="px-4 py-2 text-left">Name</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Last seen</th>
              <th className="px-4 py-2 text-left">Owner</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-xs text-outline">
                  Loading…
                </td>
              </tr>
            ) : data?.items.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-xs text-outline">
                  No devices.
                </td>
              </tr>
            ) : (
              data?.items.map((d) => (
                <tr key={d.id} className="border-t border-outline-variant/20">
                  <td className="px-4 py-2 font-medium">{d.name}</td>
                  <td className="px-4 py-2 text-[10px] uppercase tracking-widest">
                    {d.status}
                  </td>
                  <td className="px-4 py-2 font-mono text-[10px] text-outline">
                    {d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : '—'}
                  </td>
                  <td className="px-4 py-2 font-mono text-[10px] text-outline">
                    {d.ownerId.slice(0, 8)}
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
