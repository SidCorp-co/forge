'use client';

import { Shell } from '@/components/layout/shell';
import { PipelineProgressDashboard } from './components/pipeline-progress-dashboard';
import { useSetPageTitle } from '@/hooks/use-page-title';

export default function PipelineProgressPage() {
  useSetPageTitle('Pipeline Progress');
  return (
    <Shell>
      <PipelineProgressDashboard />
    </Shell>
  );
}
