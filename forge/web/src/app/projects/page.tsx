'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Shell } from '@/components/layout/shell';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Button } from '@/components/ui/button';
import { CreateProjectModal } from '@/features/project/components/create-project-modal';
import { useProjects } from '@/features/project/hooks/use-projects';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { ApiError } from '@/lib/api/client';
import { formatApiError } from '@/lib/api/error';

export default function ProjectsPage() {
  useSetPageTitle('Projects');
  const { data: projects, isLoading, isError, error } = useProjects();
  const router = useRouter();
  const searchParams = useSearchParams();
  const wantsCreate = searchParams?.get('new') === '1';
  const [manualOpen, setManualOpen] = useState(false);
  const createOpen = manualOpen || wantsCreate;

  const handleCloseCreate = () => {
    setManualOpen(false);
    if (wantsCreate) router.replace('/projects');
  };

  const isAuthError =
    isError &&
    error instanceof ApiError &&
    (error.code === 'UNAUTHENTICATED' || error.code === 'FORBIDDEN');

  return (
    <Shell>
      <div className="p-6">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-primary">Projects</h1>
          <Button onClick={() => setManualOpen(true)}>New Project</Button>
        </header>

        {isLoading && <p className="text-sm text-on-surface-variant">Loading projects...</p>}

        {isAuthError && (
          <div className="border border-outline-variant/20 bg-surface-container-low p-8 text-center">
            <p className="text-sm font-semibold text-on-surface">Sign in to view your projects</p>
            <p className="mt-2 text-xs text-on-surface-variant">
              Your session has expired or you need to sign in to access this workspace.
            </p>
            <div className="mt-4">
              <Link
                href="/login"
                className="inline-flex items-center justify-center rounded-sm bg-primary px-6 py-2 text-xs font-semibold uppercase tracking-widest text-on-primary transition-all hover:bg-tertiary active:scale-[0.98]"
              >
                Sign in
              </Link>
            </div>
          </div>
        )}

        {isError && !isAuthError && (
          <AlertBanner variant="error">{formatApiError(error)}</AlertBanner>
        )}

        {!isLoading && !isError && projects && projects.length === 0 && (
          <div className="border border-outline-variant/20 bg-surface-container-low p-8 text-center">
            <p className="text-sm text-on-surface-variant">
              No projects yet. Create your first project to get started.
            </p>
            <div className="mt-4">
              <Button onClick={() => setManualOpen(true)}>Create Project</Button>
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

        <CreateProjectModal open={createOpen} onClose={handleCloseCreate} />
      </div>
    </Shell>
  );
}
