'use client';

import { useSetPageTitle } from '@/hooks/use-page-title';

export default function SessionsSettingsPage() {
  useSetPageTitle('Settings · Sessions');
  return (
    <div className="mx-auto max-w-3xl p-6 md:p-12">
      <h1 className="mb-4 text-3xl font-black uppercase tracking-tighter text-primary">
        Sessions
      </h1>
      <p className="text-sm text-on-surface-variant">
        Coming soon — tracked in a separate issue.
      </p>
    </div>
  );
}
