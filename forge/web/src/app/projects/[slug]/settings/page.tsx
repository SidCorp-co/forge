'use client';

import { useParams } from 'next/navigation';
import { UnimplementedBanner } from '@/components/common/unimplemented-banner';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { useSetPageTitle } from '@/hooks/use-page-title';

/**
 * Phase 2.6-F2: the rich settings page is rewritten incrementally. Members
 * + invitations CRUD lands in a follow-up; the runtime tab is gated here.
 * Until the rewrite completes the page renders a placeholder so routing and
 * breadcrumbs keep working.
 */
export default function ProjectSettingsPage() {
  useSetPageTitle('Project settings');
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);

  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">
        {project?.name ?? 'Project settings'}
      </h1>
      <UnimplementedBanner
        feature="Project settings"
        hint="The full settings surface (members, invitations, labels, runtime) is being rewired onto forge/core. Members + invitations ship next; devices remain gated until their core endpoints land."
      />
    </div>
  );
}
