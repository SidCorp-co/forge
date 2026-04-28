'use client';

import { UnimplementedBanner } from '@/components/common/unimplemented-banner';

export default function CEOPage() {
  return (
    <div className="p-6">
      <UnimplementedBanner
        feature="CEO dashboard"
        hint="Cross-project CEO view depends on global roles — returns once the admin/role model ships (ISS-211)."
      />
    </div>
  );
}
