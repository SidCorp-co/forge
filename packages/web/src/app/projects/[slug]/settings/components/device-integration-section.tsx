'use client';

import { UnimplementedBanner } from '@/components/common/unimplemented-banner';

export function DeviceIntegrationSection() {
  return (
    <UnimplementedBanner
      feature="Device integration"
      hint="Per-project device pairing returns under ISS-211 (admin pages + device listing)."
    />
  );
}

export default DeviceIntegrationSection;
