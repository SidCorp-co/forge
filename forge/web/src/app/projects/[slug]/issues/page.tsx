'use client';

import { Suspense } from 'react';
import { IssuesView } from './components';

export default function IssueListPage() {
  // Suspense boundary keeps useSearchParams() (used inside useIssuesPage)
  // happy with Next 16's prerender expectations.
  return (
    <Suspense fallback={null}>
      <IssuesView />
    </Suspense>
  );
}
