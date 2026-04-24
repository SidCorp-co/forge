'use client';

import { UnimplementedBanner } from '@/components/common/unimplemented-banner';
import { useSetPageTitle } from '@/hooks/use-page-title';

export default function CloudflarePage() {
  useSetPageTitle('Cloudflare');
  return (
    <div className="p-6">
      <UnimplementedBanner feature="Cloudflare integration" />
    </div>
  );
}
