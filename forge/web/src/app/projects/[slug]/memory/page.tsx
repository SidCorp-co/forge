'use client';

import { UnimplementedBanner } from '@/components/common/unimplemented-banner';

export default function MemoryPage() {
  return (
    <div className="p-6">
      <UnimplementedBanner feature="Project memory" />
    </div>
  );
}
