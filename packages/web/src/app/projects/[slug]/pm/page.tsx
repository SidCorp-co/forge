'use client';

import { PmConfigForm, PmDecisionsFeed, PmPoliciesList } from '@/features/pm';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { useParams } from 'next/navigation';

export default function PmAgentPage() {
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);

  if (!project) {
    return <p className="text-sm text-outline">Loading…</p>;
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-on-surface">PM Agent</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Configure the project-management coordinator agent: cadence, triggers,
          policies, and the audit log of past decisions.
        </p>
      </header>
      <PmConfigForm projectId={project.id} />
      <PmPoliciesList projectId={project.id} />
      <PmDecisionsFeed projectId={project.id} />
    </div>
  );
}
