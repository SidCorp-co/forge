'use client';

import { useSetPageTitle } from '@/hooks/use-page-title';

export default function NotificationsSettingsPage() {
  useSetPageTitle('Settings · Notifications');
  return (
    <div className="mx-auto max-w-3xl p-6 md:p-12">
      <h1 className="mb-4 text-3xl font-black uppercase tracking-tighter text-primary">
        Notifications
      </h1>
      <p className="text-sm text-on-surface-variant">
        Coming soon — tracked in a separate issue.
      </p>
    </div>
  );
}
