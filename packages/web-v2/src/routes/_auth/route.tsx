import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from 'react';
import { returnPathFrom } from "@/features/auth";
import { useRouter, useSearchParams } from "@/lib/navigation/router";
import { useAuth } from '@/providers/auth-provider';

/**
 * A person already signed in when a sign-in page opens goes on to the page `next` names, or Home.
 * It is decided once, when the session is first known: the router moves its location before the
 * next page draws, so a later read of `next` reads the destination's query, which carries none, and
 * would send the person on again to Home (ISS-529 c7). A sign-in made on the page goes on by the
 * form's own navigation, never by this one.
 */
function AuthLayout() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const back = returnPathFrom(useSearchParams());
  const decidedRef = useRef(false);

  useEffect(() => {
    if (isLoading || decidedRef.current) return;
    decidedRef.current = true;
    if (user) router.replace(back ?? '/');
  }, [isLoading, user, router, back]);

  return <Outlet />;
}

export const Route = createFileRoute("/_auth")({ component: AuthLayout });
