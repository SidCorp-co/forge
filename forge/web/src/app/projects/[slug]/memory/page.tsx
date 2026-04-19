'use client';

import { useParams } from 'next/navigation';
import { useProject } from '@/features/project/hooks/use-projects';
import { MemoryView } from './components/memory-view';

export default function MemoryPage() {
  const { slug } = useParams<{ slug: string }>();
  const { data: projectData } = useProject(slug);
  const projectDocId = projectData?.data?.documentId;

  return <MemoryView projectDocumentId={projectDocId} />;
}
