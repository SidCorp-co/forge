'use client';

import { UnimplementedBanner } from '@/components/common/unimplemented-banner';

export function PipelineHealthDashboard() {
  return (
    <UnimplementedBanner
      feature="Pipeline health"
      hint="Runtime health metrics rely on antigravity-runner endpoints that were Strapi-only; a replacement lands in a later phase."
    />
  );
}

export default PipelineHealthDashboard;
