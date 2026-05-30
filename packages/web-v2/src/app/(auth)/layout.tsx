'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/providers/auth-provider';

/**
 * Auth route group — sibling of `(workspace)`, so these pages render WITHOUT
 * the NavRail/TopBar shell. The pages own their own full-height centered
 * layout (`AuthShell`); this wrapper only bounces an already-authenticated
 * visitor back into the shell so a logged-in user never sits on /login.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && user) router.replace('/');
  }, [isLoading, user, router]);

  return <>{children}</>;
}
