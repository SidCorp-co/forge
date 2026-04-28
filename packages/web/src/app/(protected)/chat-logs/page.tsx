'use client';

import { Shell } from '@/components/layout/shell';
import { ChatLogsView } from './components';
import { useSetPageTitle } from '@/hooks/use-page-title';

export default function ChatLogsPage() {
  useSetPageTitle('Chat Logs');
  return (
    <Shell>
      <ChatLogsView />
    </Shell>
  );
}
