'use client';

import { useSetPageTitle } from '@/hooks/use-page-title';
import { AgentView } from './components';

export default function AgentPage() {
  useSetPageTitle('Chat');
  return <AgentView />;
}
