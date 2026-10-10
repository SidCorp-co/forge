import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useEffect } from 'react';
import { useRouter } from "@/lib/navigation/router";
import { useAuth } from '@/providers/auth-provider';

function AuthLayout() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && user) router.replace('/');
  }, [isLoading, user, router]);

  return <Outlet />;
}

export const Route = createFileRoute("/_auth")({ component: AuthLayout });
