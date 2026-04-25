'use client';

import { useParams } from 'next/navigation';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { LabelsSection } from './components/labels-section';

export default function ProjectSettingsPage() {
  useSetPageTitle('Project settings');
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-on-surface">
          {project?.name ?? 'Project settings'}
        </h1>
        <p className="mt-1 text-xs text-outline">
          Members, invitations, and runtime settings ship in v0.1.x.
        </p>
      </div>

      {project ? (
        <LabelsSection projectId={project.id} />
      ) : (
        <p className="text-sm text-primary-fixed">Loading project…</p>
      )}
    </div>
  );
}
