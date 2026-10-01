"use client";

import { Breadcrumb, type Crumb } from "@/design";

export function PageCrumbs({ crumbs, onNavigate }: { crumbs: Crumb[]; onNavigate: (href: string) => void }) {
  if (crumbs.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-[1720px] px-4 pt-3 sm:px-8" data-testid="page-crumbs">
      <Breadcrumb items={crumbs} onNavigate={onNavigate} />
    </div>
  );
}
