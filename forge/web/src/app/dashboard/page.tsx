'use client';

import { Shell } from '@/components/layout/shell';
import { UnimplementedBanner } from '@/components/common/unimplemented-banner';
import { useSetPageTitle } from '@/hooks/use-page-title';

export default function DashboardPage() {
  useSetPageTitle('Dashboard');
  return (
    <Shell>
      <div className="p-6">
        <UnimplementedBanner
          feature="Dashboard"
          hint="The global dashboard aggregates data from features whose core endpoints have not yet landed. It will return once the underlying queries are ported."
        />
      </div>
    </Shell>
  );
}
