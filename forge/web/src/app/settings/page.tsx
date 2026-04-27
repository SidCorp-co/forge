'use client';

import { useEffect, useState } from 'react';
import { Loader2, Save, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Shell } from '@/components/layout/shell';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { Skeleton } from '@/components/ui/skeleton';
import { formatApiError } from '@/lib/api/error';
import {
  useMePreferences,
  useMeProfile,
  useUpdateMePreferences,
} from '@/features/me/hooks/use-me';
import type { Language, Theme } from '@/features/me/types';

const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: 'system', label: 'Match system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const LANGUAGE_OPTIONS: Array<{ value: Language; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'vi', label: 'Tiếng Việt' },
];

export default function SettingsPage() {
  useSetPageTitle('Settings');
  return (
    <Shell>
      <div className="mx-auto max-w-2xl space-y-6 p-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
          <p className="mt-0.5 text-xs text-outline">
            Profile and global preferences. Project-level settings live on each project page.
          </p>
        </header>
        <ProfileCard />
        <PreferencesCard />
      </div>
    </Shell>
  );
}

function ProfileCard() {
  const { data, isLoading, error } = useMeProfile();

  return (
    <section className="rounded-sm border border-outline-variant/30 bg-surface-container-low p-5">
      <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
        Profile
      </h2>
      {isLoading && (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      )}
      {error && (
        <p className="mt-3 text-sm text-error">{formatApiError(error)}</p>
      )}
      {data && (
        <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
          <dt className="text-outline">Email</dt>
          <dd className="font-medium text-on-surface">{data.email}</dd>
          <dt className="text-outline">Verified</dt>
          <dd className="flex items-center gap-1.5">
            {data.emailVerifiedAt ? (
              <>
                <ShieldCheck className="h-4 w-4 text-success" />
                <span className="text-on-surface">
                  {new Date(data.emailVerifiedAt).toLocaleDateString()}
                </span>
              </>
            ) : (
              <>
                <ShieldAlert className="h-4 w-4 text-warning" />
                <span className="text-warning">Not verified</span>
              </>
            )}
          </dd>
          <dt className="text-outline">Joined</dt>
          <dd className="text-on-surface">
            {new Date(data.createdAt).toLocaleDateString()}
          </dd>
          {data.isCeo && (
            <>
              <dt className="text-outline">Role</dt>
              <dd className="font-medium text-primary">CEO</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}

function PreferencesCard() {
  const { data, isLoading, error } = useMePreferences();
  const update = useUpdateMePreferences();

  const [theme, setTheme] = useState<Theme>('system');
  const [language, setLanguage] = useState<Language>('en');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Hydrate local controls once the query resolves; React Query's data is
  // the source of truth on subsequent renders (form is uncontrolled w.r.t. it
  // until the user types). Keep theme/language in local state so we know
  // when the user has unsaved diff vs the server.
  useEffect(() => {
    if (data) {
      setTheme(data.theme);
      setLanguage(data.language);
    }
  }, [data]);

  const dirty = !!data && (theme !== data.theme || language !== data.language);

  function onSave() {
    update.mutate(
      {
        ...(data?.theme !== theme ? { theme } : {}),
        ...(data?.language !== language ? { language } : {}),
      },
      {
        onSuccess: () => {
          setSavedAt(Date.now());
          setTimeout(() => setSavedAt(null), 2000);
        },
      },
    );
  }

  return (
    <section className="rounded-sm border border-outline-variant/30 bg-surface-container-low p-5">
      <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
        Preferences
      </h2>
      {isLoading && (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      )}
      {error && (
        <p className="mt-3 text-sm text-error">{formatApiError(error)}</p>
      )}
      {data && (
        <div className="mt-3 space-y-4">
          <Select
            label="Theme"
            value={theme}
            onChange={(v) => setTheme(v as Theme)}
            options={THEME_OPTIONS}
          />
          <Select
            label="Language"
            value={language}
            onChange={(v) => setLanguage(v as Language)}
            options={LANGUAGE_OPTIONS}
          />
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty || update.isPending}
              className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-xs font-medium uppercase tracking-widest text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {update.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save
            </button>
            {savedAt && (
              <span className="text-xs text-success">Saved.</span>
            )}
            {update.error && (
              <span className="text-xs text-error">
                {formatApiError(update.error)}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Select<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <label className="block text-sm">
      <span className="block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="mt-1 w-full rounded-sm border border-outline-variant/40 bg-surface px-3 py-1.5 text-sm text-on-surface focus:border-primary focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
