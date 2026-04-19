'use client';

import { useParams } from 'next/navigation';
import { ProjectDashboard } from '@/features/dashboard/components/project-dashboard';

export default function ProjectOverviewPage() {
  const { slug } = useParams<{ slug: string }>();

  return <ProjectDashboard slug={slug} />;
}
