'use client';

import { Shell } from '@/components/layout/shell';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { PipelineRunsList } from './components/pipeline-runs-list';

export default function PipelineRunsPage() {
  useSetPageTitle('Pipeline runs');
  return (
    <Shell>
      <PipelineRunsList />
    </Shell>
  );
}
