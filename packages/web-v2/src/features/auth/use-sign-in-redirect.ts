'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useLocationSearch } from '@/lib/utils/use-location-search';
import { loginHref } from './return-path';

/** Sends a signed-out visitor to `/login` carrying the address they opened; one who has just signed out gets the bare `/login`. */
export function useSignInRedirect({ signedIn, resolved }: { signedIn: boolean; resolved: boolean }) {
  const router = useRouter();
  const pathname = usePathname() || '/';
  const search = useLocationSearch();
  const wasSignedIn = useRef(false);

  useEffect(() => {
    if (signedIn) {
      wasSignedIn.current = true;
      return;
    }
    if (!resolved) return;
    router.replace(wasSignedIn.current ? '/login' : loginHref(`${pathname}${search}`));
  }, [signedIn, resolved, router, pathname, search]);
}
