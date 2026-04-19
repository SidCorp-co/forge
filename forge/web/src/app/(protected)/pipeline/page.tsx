'use client';

import { Shell } from '@/components/layout/shell';
import { PipelineMonitor } from './components/pipeline-monitor';
import { useSetPageTitle } from '@/hooks/use-page-title';

export default function PipelinePage() {
  useSetPageTitle('Pipeline');
  return (
    <Shell>
      <PipelineMonitor />
    </Shell>
  );
}
