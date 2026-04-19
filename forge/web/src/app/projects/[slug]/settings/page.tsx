'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAddMember, useRemoveMember } from '@/features/project/hooks/use-projects';
import { useAuth } from '@/providers/auth-provider';
import { projectApi } from '@/features/project/api/project-api';
import { WidgetSnippetSection } from './components/widget-snippet-section';
import type { ProjectUser, Device } from '@/features/project/types';
import { useSettingsForm } from './hooks';
import { SettingsView } from './components/settings-view';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:1337/api';

export default function ProjectSettingsPage() {
  const { user } = useAuth();
  const { slug } = useParams<{ slug: string }>();
  const form = useSettingsForm(slug);
  const { isLoading, project } = form;

  const addMember = useAddMember();
  const removeMember = useRemoveMember();
  const [memberSearch, setMemberSearch] = useState('');
  const [searchResults, setSearchResults] = useState<ProjectUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);

  useEffect(() => {
    projectApi.getDevices().then((res) => setDevices(res.data || [])).catch(() => {});
  }, []);

  const searchTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const handleMemberSearch = useCallback((query: string) => {
    setMemberSearch(query);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!query.trim()) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const users = await projectApi.getUsers(query);
        const memberIds = new Set(project?.members?.map((m) => m.id) ?? []);
        if (project?.owner) memberIds.add(project.owner.id);
        setSearchResults((users || []).filter((u) => !memberIds.has(u.id)));
      } catch {
        setSearchResults([]);
      }
      setSearching(false);
    }, 300);
  }, [project?.members, project?.owner]);

  const handleAddMember = (userDocId: string) => {
    if (!project) return;
    addMember.mutate({ projectDocId: project.documentId, userDocId });
    setMemberSearch('');
    setSearchResults([]);
  };

  const handleRemoveMember = (userDocId: string) => {
    if (!project) return;
    removeMember.mutate({ projectDocId: project.documentId, userDocId });
  };

  if (isLoading) return <p className="text-sm text-primary-fixed">Loading...</p>;
  if (!project) return <p className="text-sm text-primary-fixed">Project not found.</p>;

  const isOwner = project.owner?.id === user?.id;

  const generalExtra = (
    <>
      {isOwner && (
        <section className="space-y-6">
          <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
            <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">Members</h2>
            <span className="text-[9px] font-mono text-outline">MBR_CFG</span>
          </div>
          <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
            <div>
              <label className="mb-1 block text-sm font-medium text-on-surface-variant">Owner</label>
              <span className="inline-flex items-center bg-surface-container-high px-3 py-1 text-sm text-on-surface-variant">
                {project.owner!.username}
              </span>
            </div>

            {(project.members?.length ?? 0) > 0 && (
              <div>
                <label className="mb-1 block text-sm font-medium text-on-surface-variant">Members</label>
                <div className="space-y-2">
                  {project.members.map((m) => (
                    <div key={m.documentId} className="flex items-center justify-between border border-outline-variant/20 px-3 py-2">
                      <span className="text-sm text-on-surface-variant">{m.username} ({m.email})</span>
                      <button
                        onClick={() => handleRemoveMember(m.documentId)}
                        className="text-sm text-danger hover:text-danger"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="mb-1 block text-sm font-medium text-on-surface-variant">Add Member</label>
              <input
                type="text"
                value={memberSearch}
                onChange={(e) => handleMemberSearch(e.target.value)}
                placeholder="Search by username..."
                className="bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface placeholder:text-outline/40 focus:outline-none focus:border-b-primary focus:ring-0 transition-colors w-full"
              />
              {searchResults.length > 0 && (
                <div className="mt-1 border border-outline-variant/20 bg-surface-container-low">
                  {searchResults.map((u) => (
                    <button
                      key={u.documentId}
                      onClick={() => handleAddMember(u.documentId)}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-container-low"
                    >
                      {u.username} ({u.email})
                    </button>
                  ))}
                </div>
              )}
              {searching && <p className="mt-1 text-xs text-outline">Searching...</p>}
            </div>
          </div>
        </section>
      )}

      {isOwner && (
        <section className="space-y-6">
          <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
            <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">Default Device</h2>
            <span className="text-[9px] font-mono text-outline">DEV_CFG</span>
          </div>
          <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
          <p className="text-[10px] text-outline">
            Select which desktop device handles agent sessions for this project.
          </p>
          <div className="relative">
            <select
              value={project.defaultDevice?.documentId ?? ''}
              onChange={(e) => {
                const docId = e.target.value || null;
                projectApi.setDefaultDevice(project.documentId, docId).then(() => {
                  form.updateProject.mutate({ id: project.documentId, data: {} });
                });
              }}
              className="w-full bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface focus:outline-none focus:border-b-primary focus:ring-0 appearance-none"
            >
              <option value="">None</option>
              {devices.map((d) => (
                <option key={d.documentId} value={d.documentId}>
                  {d.name} {d.lastSeen ? `(last seen ${new Date(d.lastSeen).toLocaleDateString()})` : ''}
                </option>
              ))}
            </select>
          </div>
          </div>
        </section>
      )}

      {isOwner && (
        <section className="space-y-6">
          <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
            <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">Device Pool</h2>
            <span className="text-[9px] font-mono text-outline">DPL_CFG</span>
          </div>
          <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
          <p className="text-[10px] text-outline">
            Add multiple devices to run pipeline steps in parallel. When a session starts, the system picks a free device from this pool before falling back to the default device.
          </p>
          <div className="space-y-2">
            {devices.map((d) => {
              const inPool = (project.devices ?? []).some((pd) => pd.documentId === d.documentId);
              return (
                <div key={d.documentId} className="flex items-center justify-between border border-outline-variant/20 px-3 py-2">
                  <span className="text-sm text-on-surface-variant">{d.name}</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        const data = inPool
                          ? { devices: { disconnect: [d.documentId] } }
                          : { devices: { connect: [d.documentId] } };
                        projectApi.update(project.documentId, data as any).then(() => {
                          form.updateProject.mutate({ id: project.documentId, data: {} });
                        });
                      }}
                      className={`px-2 py-0.5 text-xs font-medium ${inPool ? 'bg-info-surface/30 text-info hover:bg-info-surface/30' : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-variant'}`}
                    >
                      {inPool ? 'In Pool' : 'Add'}
                    </button>
                    <button
                      onClick={async () => {
                        if (!window.confirm(`Delete device "${d.name}"? It will be removed from all projects.`)) return;
                        await projectApi.deleteDevice(d.documentId);
                        setDevices((prev) => prev.filter((dev) => dev.documentId !== d.documentId));
                        form.updateProject.mutate({ id: project.documentId, data: {} });
                      }}
                      className="px-2 py-0.5 text-xs font-medium text-danger hover:bg-danger-surface"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
            {devices.length === 0 && (
              <p className="text-[10px] text-outline">No devices registered. Connect a desktop app first.</p>
            )}
          </div>
          </div>
        </section>
      )}

    </>
  );

  const integrationsExtra = (
    <WidgetSnippetSection
      apiKey={project.apiKey}
      apiUrl={API_URL}
      projectName={project.name}
    />
  );

  return (
    <SettingsView
      {...form}
      projectDocumentId={project.documentId}
      projectName={project.name}
      projectSlug={project.slug}
      devices={devices}
      generalExtra={generalExtra}
      integrationsExtra={integrationsExtra}
    />
  );
}
