'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Crown } from 'lucide-react';
import { Shell } from '@/components/layout/shell';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { useAuth } from '@/providers/auth-provider';
import { projectApi } from '@/features/project/api/project-api';
import type { Project } from '@/features/project/types';

export default function CeoPage() {
  useSetPageTitle('CEO');
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [ceoProject, setCeoProject] = useState<Project | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user?.isCEO) {
      router.replace('/dashboard');
      return;
    }
    projectApi.getAll().then((res) => {
      const ceo = res.data.find((p) => p.crossProjectAccess);
      if (ceo) {
        setCeoProject(ceo);
        router.replace(`/projects/${ceo.slug}/agent`);
      } else {
        setLoading(false);
      }
    }).catch(() => setLoading(false));
  }, [router, user, authLoading]);

  if (loading || ceoProject) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-on-surface-variant" />
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-lg mx-auto py-24 text-center space-y-4">
        <Crown className="h-12 w-12 mx-auto text-on-surface-variant" />
        <h1 className="text-xl font-semibold text-on-surface">No CEO Project Found</h1>
        <p className="text-sm text-on-surface-variant">
          Create a project with <code className="px-1 py-0.5 rounded bg-surface-variant text-on-surface-variant text-xs">crossProjectAccess: true</code> to enable the CEO agent.
          This project acts as the cross-project hub for delegation, briefing, and directives.
        </p>
      </div>
    </Shell>
  );
}
