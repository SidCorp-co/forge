'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { useMounted } from '@/hooks/use-mounted';
import {
  ChevronRight,
  FolderKanban,
  KeyRound,
  Laptop,
  Loader2,
  Monitor,
  Moon,
  Save,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  Sun,
  User as UserIcon,
} from 'lucide-react';
import { Shell } from '@/components/layout/shell';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { Skeleton } from '@/components/ui/skeleton';
import { formatApiError } from '@/lib/api/error';
import { useProjects } from '@/features/project/hooks/use-projects';
import {
  useMePreferences,
  useMeProfile,
  useUpdateMePreferences,
} from '@/features/me/hooks/use-me';
import type { Language, Theme } from '@/features/me/types';

const LANGUAGE_OPTIONS: Array<{ value: Language; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'vi', label: 'Tiếng Việt' },
];

export default function SettingsPage() {
  useSetPageTitle('Settings');
  const profile = useMeProfile();

  return (
    <Shell>
      <div className="h-full overflow-y-auto bg-background">
        <div className="mx-auto max-w-5xl p-6 md:p-12">
          <header className="mb-12">
            <div className="mb-2 flex items-baseline justify-between">
              <h1 className="text-4xl font-black tracking-tighter text-primary uppercase">
                Account Settings
              </h1>
              <span className="font-mono text-[0.6875rem] uppercase tracking-widest text-outline">
                {profile.data?.email ?? 'SYSTEM'}
              </span>
            </div>
            <p className="max-w-xl text-sm leading-relaxed text-on-surface-variant">
              Manage your identity, connected devices, and project distribution across the Forge engine.
            </p>
          </header>

          <div className="grid grid-cols-12 gap-8">
            <section className="col-span-12 space-y-4 lg:col-span-7">
              <IdentityCard />
              <ProjectDistributionCard />
            </section>

            <section className="col-span-12 space-y-6 lg:col-span-5">
              <DevicesCard />
              <TokensCard />
              <SystemInfoCard />
              <AppearanceCard />
              <LanguageCard />
              <QuickActionsCard />
            </section>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function IdentityCard() {
  const { data, isLoading, error } = useMeProfile();

  return (
    <div className="flex flex-col gap-6 rounded-sm border border-outline-variant/20 bg-surface-dim p-6">
      <div className="flex items-start justify-between border-b border-outline-variant/20 pb-4">
        <div className="min-w-0">
          <h3 className="mb-1 text-[0.6875rem] uppercase tracking-[0.2em] text-outline">
            Identity
          </h3>
          {isLoading && <Skeleton className="h-6 w-40" />}
          {error && <p className="text-sm text-error">{formatApiError(error)}</p>}
          {data && (
            <p className="truncate text-xl font-bold tracking-tight text-primary">
              {data.email}
            </p>
          )}
        </div>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-surface-container-highest">
          <UserIcon className="h-4 w-4 text-on-surface-variant" />
        </div>
      </div>
      {data && (
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <h3 className="mb-1 text-[0.6875rem] uppercase tracking-[0.2em] text-outline">
              Verification
            </h3>
            {data.emailVerifiedAt ? (
              <p className="flex items-center gap-1.5 font-medium text-success">
                <ShieldCheck className="h-4 w-4" />
                <span>{new Date(data.emailVerifiedAt).toLocaleDateString()}</span>
              </p>
            ) : (
              <p className="flex items-center gap-1.5 font-medium text-warning">
                <ShieldAlert className="h-4 w-4" />
                <span>Not verified</span>
              </p>
            )}
          </div>
          <div>
            <h3 className="mb-1 text-[0.6875rem] uppercase tracking-[0.2em] text-outline">
              Joined
            </h3>
            <p className="font-medium text-on-surface">
              {new Date(data.createdAt).toLocaleDateString()}
            </p>
          </div>
          {data.isCeo && (
            <div className="col-span-2">
              <span className="inline-flex rounded-sm bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-primary">
                CEO
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectDistributionCard() {
  const { data, isLoading } = useProjects();
  const projects = data ?? [];

  return (
    <div className="rounded-sm border border-outline-variant/20 bg-surface-dim">
      <div className="flex items-center justify-between border-b border-outline-variant/20 px-6 py-4">
        <h3 className="text-[0.6875rem] uppercase tracking-[0.2em] text-outline">
          Project Distribution
        </h3>
        <span className="font-mono text-[10px] text-outline">
          {projects.length} TOTAL
        </span>
      </div>
      {isLoading ? (
        <div className="space-y-2 p-6">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : projects.length === 0 ? (
        <div className="px-6 py-8 text-center">
          <FolderKanban className="mx-auto mb-2 h-5 w-5 text-outline" />
          <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
            No projects yet
          </p>
        </div>
      ) : (
        <div className="divide-y divide-outline-variant/10">
          {projects.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between px-6 py-4 transition-colors hover:bg-surface-container-low"
            >
              <div className="flex min-w-0 items-center gap-4">
                <div className="h-2 w-2 shrink-0 bg-primary" />
                <div className="min-w-0">
                  <Link
                    href={`/projects/${p.slug}`}
                    className="text-sm font-bold tracking-tight text-primary hover:underline"
                  >
                    {p.name}
                  </Link>
                  <div className="flex gap-3 text-[10px] uppercase tracking-wider text-outline">
                    <span>slug: {p.slug}</span>
                  </div>
                </div>
              </div>
              <Link
                href={`/projects/${p.slug}/settings`}
                className="flex shrink-0 items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-outline hover:text-on-surface"
              >
                Settings
                <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DevicesCard() {
  return (
    <div className="relative overflow-hidden rounded-sm border border-outline-variant/20 bg-surface-container-low p-6">
      <div className="absolute right-0 top-0 p-2 opacity-10">
        <Monitor className="h-16 w-16" />
      </div>
      <h3 className="mb-4 text-[0.6875rem] uppercase tracking-[0.2em] text-outline">
        Hardware Matrix
      </h3>
      <p className="mb-6 text-[10px] leading-relaxed text-on-surface-variant">
        Desktop devices that run Claude CLI agents. Configure device names, project
        root folders, and pool assignments.
      </p>
      <Link
        href="/devices"
        className="block w-full border border-outline-variant/40 py-2 text-center text-[0.6875rem] font-bold uppercase tracking-widest transition-colors hover:bg-surface-container-highest"
      >
        Manage All Nodes
      </Link>
    </div>
  );
}

function TokensCard() {
  return (
    <div className="relative overflow-hidden rounded-sm border border-outline-variant/20 bg-surface-container-low p-6">
      <div className="absolute right-0 top-0 p-2 opacity-10">
        <KeyRound className="h-16 w-16" />
      </div>
      <h3 className="mb-4 text-[0.6875rem] uppercase tracking-[0.2em] text-outline">
        Personal Access Tokens
      </h3>
      <p className="mb-6 text-[10px] leading-relaxed text-on-surface-variant">
        Authenticate MCP clients and API integrations outside the browser
        session. Scope per project, rotate, and revoke at any time.
      </p>
      <Link
        href="/settings/tokens"
        className="block w-full border border-outline-variant/40 py-2 text-center text-[0.6875rem] font-bold uppercase tracking-widest transition-colors hover:bg-surface-container-highest"
      >
        Manage Tokens
      </Link>
    </div>
  );
}

function SystemInfoCard() {
  const { data: profile } = useMeProfile();
  const { data: projects } = useProjects();
  return (
    <div className="rounded-sm border border-outline-variant/30 bg-surface-container-lowest p-4 font-mono text-[10px] leading-tight text-outline">
      <div className="mb-2 flex items-center gap-2 text-primary">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        <span className="font-bold uppercase tracking-widest">System Info</span>
      </div>
      <div className="space-y-1">
        <p>[SYS] Forge — AI-powered project management</p>
        <p>[SYS] User: {profile?.email ?? '—'}</p>
        <p>[SYS] Projects: {projects?.length ?? 0} loaded</p>
        <p className="text-on-surface-variant/40">[SYS] All systems nominal</p>
      </div>
    </div>
  );
}

function AppearanceCard() {
  // Theme is dual-tracked: next-themes drives the live UI, the server
  // preferences row persists across devices. Saving via next-themes also
  // PATCHes the server so a fresh login on another machine reflects the
  // last choice. Optimistic — the local state flips first.
  const { theme: appliedTheme, setTheme } = useTheme();
  const prefs = useMePreferences();
  const update = useUpdateMePreferences();
  const mounted = useMounted();

  // Hydrate next-themes from the server prefs once they load — useful when
  // the user signs in fresh and the cookie hasn't been set yet.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!hydrated && prefs.data?.theme) {
      setTheme(prefs.data.theme);
      setHydrated(true);
    }
  }, [hydrated, prefs.data, setTheme]);

  // Until mounted, render with a stable null choice so SSR markup matches the
  // first hydration paint (avoids React #418 — see ISS-309).
  const current = mounted ? ((appliedTheme ?? prefs.data?.theme ?? 'system') as Theme) : null;

  function pick(value: Theme) {
    setTheme(value);
    update.mutate({ theme: value });
  }

  return (
    <div className="rounded-sm border border-outline-variant/20 bg-surface-container-low p-6">
      <h3 className="mb-4 text-[0.6875rem] uppercase tracking-[0.2em] text-outline">
        Appearance
      </h3>
      <div className="grid grid-cols-3 gap-2">
        {(
          [
            { value: 'light', label: 'Light', Icon: Sun },
            { value: 'dark', label: 'Dark', Icon: Moon },
            { value: 'system', label: 'System', Icon: Laptop },
          ] as const
        ).map(({ value, label, Icon }) => {
          const active = current === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => pick(value)}
              disabled={update.isPending}
              className={`flex flex-col items-center gap-2 rounded-sm border py-3 transition-colors disabled:opacity-50 ${
                active
                  ? 'border-primary bg-surface-variant text-primary'
                  : 'border-outline-variant/20 text-outline hover:bg-surface-container-high hover:text-on-surface'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span className="text-[10px] font-bold uppercase tracking-widest">
                {label}
              </span>
            </button>
          );
        })}
      </div>
      {update.error && (
        <p className="mt-2 text-[10px] text-error">
          {formatApiError(update.error)}
        </p>
      )}
    </div>
  );
}

function LanguageCard() {
  const prefs = useMePreferences();
  const update = useUpdateMePreferences();
  const [language, setLanguage] = useState<Language>('en');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (prefs.data) setLanguage(prefs.data.language);
  }, [prefs.data]);

  const dirty = !!prefs.data && prefs.data.language !== language;

  function save() {
    update.mutate(
      { language },
      {
        onSuccess: () => {
          setSavedAt(Date.now());
          setTimeout(() => setSavedAt(null), 2000);
        },
      },
    );
  }

  return (
    <div className="rounded-sm border border-outline-variant/20 bg-surface-container-low p-6">
      <h3 className="mb-4 text-[0.6875rem] uppercase tracking-[0.2em] text-outline">
        Language
      </h3>
      {prefs.isLoading ? (
        <Skeleton className="h-9 w-full" />
      ) : (
        <>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
            className="w-full rounded-sm border border-outline-variant/40 bg-surface px-3 py-1.5 text-sm text-on-surface focus:border-primary focus:outline-none"
          >
            {LANGUAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={!dirty || update.isPending}
              className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {update.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save
            </button>
            {savedAt && <span className="text-[10px] text-success">Saved.</span>}
          </div>
        </>
      )}
    </div>
  );
}

function QuickActionsCard() {
  return (
    <div className="grid grid-cols-2 gap-4">
      <Link
        href="/devices"
        className="group rounded-sm border border-outline-variant/20 bg-surface-dim p-4 text-left transition-colors hover:bg-surface-container-low"
      >
        <Monitor className="mb-2 h-4 w-4 text-outline transition-colors group-hover:text-on-surface" />
        <p className="text-[10px] font-bold uppercase tracking-widest text-primary">
          Devices
        </p>
      </Link>
      <Link
        href="/dashboard"
        className="group rounded-sm border border-outline-variant/20 bg-surface-dim p-4 text-left transition-colors hover:bg-surface-container-low"
      >
        <SettingsIcon className="mb-2 h-4 w-4 text-outline transition-colors group-hover:text-on-surface" />
        <p className="text-[10px] font-bold uppercase tracking-widest text-primary">
          Dashboard
        </p>
      </Link>
    </div>
  );
}
