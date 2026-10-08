"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { type MovedPage, movedTarget } from "../moved";

/** The body of a removed page's route: it replaces itself with the place that holds its record now. */
export function MovedRedirect({ page }: { page: MovedPage }) {
  const router = useRouter();
  const slug = useParams<{ slug: string }>()?.slug;
  useEffect(() => {
    if (slug) router.replace(movedTarget(slug, page, new URLSearchParams(window.location.search)));
  }, [router, slug, page]);
  return null;
}
