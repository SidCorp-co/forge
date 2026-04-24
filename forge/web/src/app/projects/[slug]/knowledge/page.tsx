'use client';

import { UnimplementedBanner } from '@/components/common/unimplemented-banner';

export default function KnowledgePage() {
  return (
    <div className="p-6">
      <UnimplementedBanner feature="Project knowledge graph" />
    </div>
  );
}
