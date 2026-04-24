'use client';

import { UnimplementedBanner } from '@/components/common/unimplemented-banner';
import { useSetPageTitle } from '@/hooks/use-page-title';

export default function SettingsPage() {
  useSetPageTitle('Settings');
  return (
    <div className="p-6">
      <UnimplementedBanner
        feature="User settings"
        hint="Global user settings (profile, preferences) will return once the corresponding user endpoints ship on forge/core."
      />
    </div>
  );
}
