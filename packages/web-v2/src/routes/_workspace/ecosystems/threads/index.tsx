import { createFileRoute } from "@tanstack/react-router";
// The Threads inbox across every ecosystem (`/ecosystems/threads`), viewed by `?view=` and narrowed by
// `?ecosystem=`, `?project=` and `?type=`; built by `ecosystemRoutes.threads`.
import { usePathname, useRouter, useSearchParams } from "@/lib/navigation/router";
import { Suspense } from "react";
import { PageContainer } from "@/design";
import { ThreadsScreen, type ThreadsFilters } from "@/features/ecosystem/components/threads-screen";

function Threads() {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const read = (k: keyof ThreadsFilters) => search?.get(k) || null;
  const onParam = (key: keyof ThreadsFilters, value: string | null) => {
    const next = new URLSearchParams(search?.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const q = next.toString();
    router.replace(q ? `${pathname}?${q}` : pathname);
  };
  return (
    <PageContainer className="min-w-0">
      <ThreadsScreen
        filters={{ view: read("view"), ecosystem: read("ecosystem"), project: read("project"), type: read("type") }}
        onParam={onParam}
      />
    </PageContainer>
  );
}

function ThreadsPage() {
  return (
    <Suspense fallback={null}>
      <Threads />
    </Suspense>
  );
}

export const Route = createFileRoute("/_workspace/ecosystems/threads/")({ component: ThreadsPage });
