'use client';

import { UnimplementedBanner } from '@/components/common/unimplemented-banner';
import { useSetPageTitle } from '@/hooks/use-page-title';

/**
 * Phase 2.6-F2 replaces the agent session viewer with a jobs module. The
 * new `features/job/` package provides the data layer; a finished job viewer
 * UI lands in a follow-up. Until then this route renders a banner so
 * navigation does not break.
 */
export default function AgentPage() {
  useSetPageTitle('Agent (deprecated — jobs view coming)');
  return (
    <div className="p-6">
      <UnimplementedBanner
        feature="Agent session viewer"
        hint="Replaced by the jobs viewer (features/job). The rich UI ships next; the data layer (apiClient-backed hooks) is already in place."
      />
    </div>
  );
}
