'use client';

import { useParams } from 'next/navigation';
import { AgentStreamProvider } from '@/hooks/agent-stream-context';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { AgentView } from './components';

export default function AgentPage() {
  useSetPageTitle('Agent');
  const { slug } = useParams<{ slug: string }>();

  return (
    <AgentStreamProvider projectSlug={slug}>
      <AgentView />
    </AgentStreamProvider>
  );
}
