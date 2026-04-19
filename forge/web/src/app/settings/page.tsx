'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Shell } from '@/components/layout/shell';
import { useAuth } from '@/providers/auth-provider';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { projectApi } from '@/features/project/api/project-api';
import type { Project } from '@/features/project/types';
import { Settings, User, Monitor, FolderKanban, ChevronRight, Sun, Moon, Laptop } from 'lucide-react';
import { useThemePreference } from '@/hooks/use-theme-preference';

export default function SettingsPage() {
  const { user } = useAuth();
  useSetPageTitle('Settings');
  const [projects, setProjects] = useState<Project[]>([]);
  const { theme, saveTheme } = useThemePreference();

  useEffect(() => {
    projectApi.getAll()
      .then((res) => setProjects(res.data || []))
      .catch(() => {});
  }, []);

  return (
    <Shell>
      <div className="h-full overflow-y-auto bg-background">
        <div className="max-w-5xl mx-auto p-6 md:p-12">
          {/* Header */}
          <header className="mb-12">
            <div className="flex items-baseline justify-between mb-2">
              <h1 className="text-4xl font-black tracking-tighter text-primary uppercase">Account Settings</h1>
              <span className="text-[0.6875rem] font-mono text-outline uppercase tracking-widest">
                {user?.username ?? 'SYSTEM'}
              </span>
            </div>
            <p className="text-on-surface-variant max-w-xl text-sm leading-relaxed">
              Manage your identity, connected devices, and project distribution across the Forge engine.
            </p>
          </header>

          <div className="grid grid-cols-12 gap-8">
            {/* Left Column — Identity & Projects */}
            <section className="col-span-12 lg:col-span-7 space-y-4">
              {/* Identity Card */}
              <div className="bg-surface-dim border border-outline-variant/20 rounded-sm p-6 flex flex-col gap-6">
                <div className="flex justify-between items-start border-b border-outline-variant/20 pb-4">
                  <div>
                    <h3 className="text-[0.6875rem] uppercase tracking-[0.2em] text-outline mb-1">Identity</h3>
                    <p className="text-xl font-bold text-primary tracking-tight">{user?.username ?? '—'}</p>
                  </div>
                  <div className="w-8 h-8 bg-surface-container-highest rounded-sm flex items-center justify-center">
                    <User className="h-4 w-4 text-on-surface-variant" />
                  </div>
                </div>
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-[0.6875rem] uppercase tracking-[0.2em] text-outline mb-1">Communication</h3>
                    <p className="text-xl font-bold text-primary tracking-tight">{user?.email ?? '—'}</p>
                  </div>
                </div>
              </div>

              {/* Project Distribution */}
              <div className="bg-surface-dim border border-outline-variant/20 rounded-sm">
                <div className="px-6 py-4 border-b border-outline-variant/20 flex justify-between items-center">
                  <h3 className="text-[0.6875rem] uppercase tracking-[0.2em] text-outline">Project Distribution</h3>
                  <span className="text-[10px] font-mono text-outline">{projects.length} TOTAL</span>
                </div>
                {projects.length === 0 ? (
                  <div className="px-6 py-8 text-center">
                    <FolderKanban className="h-5 w-5 text-outline mx-auto mb-2" />
                    <p className="text-[10px] font-bold tracking-widest uppercase text-on-surface-variant">No projects yet</p>
                  </div>
                ) : (
                  <div className="divide-y divide-outline-variant/10">
                    {projects.map((p) => (
                      <div
                        key={p.documentId}
                        className="px-6 py-4 flex items-center justify-between hover:bg-surface-container-low transition-colors"
                      >
                        <div className="flex items-center gap-4 min-w-0">
                          <div className="w-2 h-2 bg-primary shrink-0" />
                          <div className="min-w-0">
                            <Link href={`/projects/${p.slug}`} className="text-sm font-bold text-primary tracking-tight hover:underline">
                              {p.name}
                            </Link>
                            <div className="flex gap-3 text-[10px] text-outline uppercase tracking-wider">
                              {p.baseBranch && <span>branch: {p.baseBranch}</span>}
                              {p.defaultProvider && <span>provider: {p.defaultProvider}</span>}
                            </div>
                          </div>
                        </div>
                        <Link
                          href={`/projects/${p.slug}/settings`}
                          className="text-[10px] uppercase tracking-widest text-outline hover:text-on-surface font-bold flex items-center gap-1 shrink-0"
                        >
                          Settings
                          <ChevronRight className="h-3 w-3" />
                        </Link>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* Right Column — Devices & Quick Actions */}
            <section className="col-span-12 lg:col-span-5 space-y-6">
              {/* Devices Card */}
              <div className="bg-surface-container-low border border-outline-variant/20 rounded-sm p-6 relative overflow-hidden">
                <div className="absolute top-0 right-0 p-2 opacity-10">
                  <Monitor className="h-16 w-16" />
                </div>
                <h3 className="text-[0.6875rem] uppercase tracking-[0.2em] text-outline mb-4">Hardware Matrix</h3>
                <p className="text-[10px] text-on-surface-variant leading-relaxed mb-6">
                  Desktop devices that run Claude CLI agents. Configure device names, project root folders, and pool assignments.
                </p>
                <Link
                  href="/devices"
                  className="block w-full border border-outline-variant/40 py-2 text-[0.6875rem] uppercase tracking-widest font-bold hover:bg-surface-container-highest transition-colors text-center"
                >
                  Manage All Nodes
                </Link>
              </div>

              {/* System Info Terminal */}
              <div className="bg-surface-container-lowest border border-outline-variant/30 rounded-sm p-4 font-mono text-[10px] text-outline leading-tight">
                <div className="flex items-center gap-2 mb-2 text-primary">
                  <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
                  <span className="uppercase font-bold tracking-widest">System Info</span>
                </div>
                <div className="space-y-1">
                  <p>[SYS] Forge — AI-powered project management</p>
                  <p>[SYS] User: {user?.username ?? '—'}</p>
                  <p>[SYS] Projects: {projects.length} loaded</p>
                  <p className="text-on-surface-variant/40">[SYS] All systems nominal</p>
                </div>
              </div>

              {/* Appearance */}
              <div className="bg-surface-container-low border border-outline-variant/20 rounded-sm p-6">
                <h3 className="text-[0.6875rem] uppercase tracking-[0.2em] text-outline mb-4">Appearance</h3>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { value: 'light', label: 'Light', Icon: Sun },
                    { value: 'dark', label: 'Dark', Icon: Moon },
                    { value: 'system', label: 'System', Icon: Laptop },
                  ] as const).map(({ value, label, Icon }) => (
                    <button
                      key={value}
                      onClick={() => saveTheme(value)}
                      className={`flex flex-col items-center gap-2 py-3 rounded-sm border transition-colors ${
                        theme === value
                          ? 'border-primary bg-surface-variant text-primary'
                          : 'border-outline-variant/20 text-outline hover:text-on-surface hover:bg-surface-container-high'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      <span className="text-[10px] uppercase font-bold tracking-widest">{label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Quick Actions */}
              <div className="grid grid-cols-2 gap-4">
                <Link
                  href="/devices"
                  className="bg-surface-dim border border-outline-variant/20 rounded-sm p-4 text-left hover:bg-surface-container-low transition-colors group"
                >
                  <Monitor className="h-4 w-4 text-outline group-hover:text-on-surface transition-colors mb-2" />
                  <p className="text-[10px] uppercase font-bold tracking-widest text-primary">Devices</p>
                </Link>
                <Link
                  href="/dashboard"
                  className="bg-surface-dim border border-outline-variant/20 rounded-sm p-4 text-left hover:bg-surface-container-low transition-colors group"
                >
                  <Settings className="h-4 w-4 text-outline group-hover:text-on-surface transition-colors mb-2" />
                  <p className="text-[10px] uppercase font-bold tracking-widest text-primary">Dashboard</p>
                </Link>
              </div>
            </section>
          </div>
        </div>
      </div>
    </Shell>
  );
}
