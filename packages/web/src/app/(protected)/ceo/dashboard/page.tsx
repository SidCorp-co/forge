'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/layout/shell';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { useAuth } from '@/providers/auth-provider';
import { CeoBriefing } from '@/features/dashboard/components/ceo-briefing';

export default function CeoDashboardPage() {
  useSetPageTitle('CEO Dashboard');
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user?.isCEO) {
      router.replace('/dashboard');
    }
  }, [isLoading, user, router]);

  if (isLoading || !user?.isCEO) {
    return null;
  }

  return (
    <Shell>
      <div className="max-w-6xl mx-auto space-y-6">
        <CeoBriefing />
      </div>
    </Shell>
  );
}
