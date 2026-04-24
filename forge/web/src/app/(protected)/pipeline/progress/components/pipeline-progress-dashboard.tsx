'use client';

import { UnimplementedBanner } from '@/components/common/unimplemented-banner';

export function PipelineProgressDashboard() {
  return (
    <UnimplementedBanner
      feature="Pipeline progress"
      hint="Pipeline timing/gate analytics depend on endpoints not yet on forge/core. Returns once analytics are re-implemented."
    />
  );
}

export default PipelineProgressDashboard;
