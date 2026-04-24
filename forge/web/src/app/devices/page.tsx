'use client';

import { UnimplementedBanner } from '@/components/common/unimplemented-banner';
import { useSetPageTitle } from '@/hooks/use-page-title';

export default function DevicesPage() {
  useSetPageTitle('Devices');
  return (
    <div className="p-6">
      <UnimplementedBanner
        feature="Device management"
        hint="Per-user device management returns once admin endpoints ship under ISS-211 (Phase 2.6-F3)."
      />
    </div>
  );
}
