import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useEffect } from 'react';
import { returnPathFrom } from "@/features/auth";
import { useRouter, useSearchParams } from "@/lib/navigation/router";
import { useAuth } from '@/providers/auth-provider';

function AuthLayout() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const back = returnPathFrom(useSearchParams());

  useEffect(() => {
    if (!isLoading && user) router.replace(back ?? '/');
  }, [isLoading, user, router, back]);

  return <Outlet />;
}

export const Route = createFileRoute("/_auth")({ component: AuthLayout });
