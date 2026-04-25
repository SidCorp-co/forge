'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Shell } from '@/components/layout/shell';
import { Button } from '@/components/ui/button';
import { CreateProjectModal } from '@/features/project/components/create-project-modal';
import { useProjects } from '@/features/project/hooks/use-projects';
import { useSetPageTitle } from '@/hooks/use-page-title';

export default function ProjectsPage() {
  useSetPageTitle('Projects');
  const { data: projects, isLoading, isError } = useProjects();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <Shell>
      <div className="p-6">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-primary">Projects</h1>
          <Button onClick={() => setCreateOpen(true)}>New Project</Button>
        </header>

        {isLoading && <p className="text-sm text-on-surface-variant">Loading projects...</p>}
        {isError && <p className="text-sm text-error">Failed to load projects.</p>}

        {!isLoading && !isError && projects && projects.length === 0 && (
          <div className="border border-outline-variant/20 bg-surface-container-low p-8 text-center">
            <p className="text-sm text-on-surface-variant">
              No projects yet. Create your first project to get started.
            </p>
            <div className="mt-4">
              <Button onClick={() => setCreateOpen(true)}>Create Project</Button>
            </div>
          </div>
        )}

        {projects && projects.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.slug}`}
                  className="block border border-outline-variant/20 bg-surface-container-low p-4 transition-colors hover:bg-surface-container-high"
                >
                  <h2 className="text-sm font-semibold text-on-surface">{p.name}</h2>
                  <p className="mt-1 text-xs text-on-surface-variant">/{p.slug}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <CreateProjectModal open={createOpen} onClose={() => setCreateOpen(false)} />
      </div>
    </Shell>
  );
}
