'use client';

import { Suspense } from 'react';
import { Shell } from '@/components/layout/shell';
import { DocsScreen } from '@/features/docs/components/docs-screen';
import { useSetPageTitle } from '@/hooks/use-page-title';

export default function DocsPage() {
  useSetPageTitle('Help & Docs');
  return (
    <Shell>
      {/* DocsScreen reads `?path=` via useSearchParams — needs a Suspense
          boundary so the page can prerender without a CSR bailout (Next 16). */}
      <Suspense fallback={null}>
        <DocsScreen />
      </Suspense>
    </Shell>
  );
}
