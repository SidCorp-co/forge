'use client';

import { useParams } from 'next/navigation';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { MemoryView } from './components/memory-view';

export default function MemoryPage() {
  useSetPageTitle('Memory');
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);

  return (
    <div className="p-6">
      <MemoryView projectDocumentId={project?.id} />
    </div>
  );
}
