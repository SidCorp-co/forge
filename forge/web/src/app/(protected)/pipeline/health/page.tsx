'use client';

import { Shell } from '@/components/layout/shell';
import { PipelineHealthDashboard } from './components/pipeline-health-dashboard';
import { useSetPageTitle } from '@/hooks/use-page-title';

export default function PipelineHealthPage() {
  useSetPageTitle('Pipeline Health');
  return (
    <Shell>
      <PipelineHealthDashboard />
    </Shell>
  );
}
