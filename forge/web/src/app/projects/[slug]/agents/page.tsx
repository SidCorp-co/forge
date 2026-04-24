'use client';

import { UnimplementedBanner } from '@/components/common/unimplemented-banner';

export default function AgentsPage() {
  return (
    <div className="p-6">
      <UnimplementedBanner
        feature="Project agents"
        hint="Agent CRUD has no core endpoint yet; the per-project agents tab returns once agents move over."
      />
    </div>
  );
}
