'use client';

import { Shell } from '@/components/layout/shell';
import { WhatsNewScreen } from '@/features/whats-new/components/whats-new-screen';
import { useSetPageTitle } from '@/hooks/use-page-title';

export default function WhatsNewPage() {
  useSetPageTitle("What's New");
  return (
    <Shell>
      <WhatsNewScreen />
    </Shell>
  );
}
