'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { returnPathFromSearch } from '@/features/auth/return-path';
import { useLocationSearch } from '@/lib/utils/use-location-search';
import { useAuth } from '@/providers/auth-provider';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const search = useLocationSearch();

  useEffect(() => {
    if (!isLoading && user) router.replace(returnPathFromSearch(search));
  }, [isLoading, user, router, search]);

  return <>{children}</>;
}
