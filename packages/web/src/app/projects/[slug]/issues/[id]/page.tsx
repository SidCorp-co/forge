'use client';

import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { useIssueByDisplay } from '@/features/issue/hooks/use-issues';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';

const DISPLAY_ID_RE = /^ISS-\d+$/i;

// Legacy v1 issue detail is retired — hand off to the web-v2 detail page.
// v2's detail endpoint (GET /api/issues/:id) is UUID-only, while v1 URLs in
// the wild use the friendly ISS-N displayId. Resolve displayId -> UUID here
// (v1 already owns the hooks) and forward only a UUID to v2. UUID ids redirect
// immediately. Cross-app hop uses window.location.replace (full navigation),
// never the Next client router.
export default function IssueDetailRedirect() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  const isDisplayId = DISPLAY_ID_RE.test(id);
  const project = useProjectBySlug(isDisplayId ? slug : undefined);
  const byDisplay = useIssueByDisplay(
    isDisplayId ? project?.id : undefined,
    isDisplayId ? id : undefined,
  );

  useEffect(() => {
    if (!isDisplayId) {
      window.location.replace(`/v2/projects/${slug}/issues/${id}`);
      return;
    }
    if (byDisplay.data?.id) {
      window.location.replace(`/v2/projects/${slug}/issues/${byDisplay.data.id}`);
    }
  }, [isDisplayId, slug, id, byDisplay.data?.id]);

  return (
    <div className="p-8 text-center text-xs font-mono text-outline-variant">
      Redirecting…
    </div>
  );
}
