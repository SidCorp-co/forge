import { useListKeys } from "@/design/hooks/use-list-keys";
import { Skeleton } from "@/design/primitives/skeleton";
import { PageSection } from "@/design/primitives/page-section";

/* Layout-mirroring skeletons — show these on cold load instead of a centered
   spinner, so the page keeps its shape while data arrives. */

export function BoardRowSkeleton() {
  return (
    <div className="flex items-center gap-3 border-b border-line-subtle px-4 py-3 last:border-0">
      <Skeleton className="h-4 w-14" />
      <Skeleton variant="text" className="w-1/2" />
      <Skeleton className="ml-auto h-2 w-28" />
      <Skeleton className="h-5 w-16 rounded-pill" />
      <Skeleton variant="circle" className="size-5" />
    </div>
  );
}

export function KanbanCardSkeleton() {
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-line bg-surface p-3">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-14" />
        <Skeleton variant="circle" className="size-5" />
      </div>
      <Skeleton variant="text" className="w-full" />
      <Skeleton variant="text" className="w-2/3" />
      <Skeleton className="mt-1 h-3 w-full" />
    </div>
  );
}

export function KanbanColumnSkeleton({ cards = 3 }: { cards?: number }) {
  const placeholders = useListKeys(cards);
  return (
    <div className="flex w-full flex-col gap-3">
      <Skeleton className="h-4 w-20" />
      {placeholders.keys.map((key) => (
        <KanbanCardSkeleton key={key} />
      ))}
    </div>
  );
}

export function SessionRowSkeleton() {
  return (
    <div className="flex items-center gap-3 border-b border-line-subtle px-4 py-3 last:border-0">
      <Skeleton className="h-4 w-16" />
      <Skeleton variant="text" className="w-1/3" />
      <Skeleton className="ml-auto h-5 w-20 rounded-pill" />
      <Skeleton className="h-3 w-12" />
      <Skeleton className="h-3 w-14" />
    </div>
  );
}

export function ProjectCardSkeleton() {
  return (
    <PageSection className="border-t border-line-subtle">
      <div className="flex items-center gap-3 pt-4">
        <Skeleton className="size-9 rounded-md" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="ml-auto h-5 w-20 rounded-pill" />
      </div>
      <div className="flex flex-col gap-3 py-4">
        <Skeleton variant="text" className="w-3/4" />
        <div className="flex gap-4">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-14" />
        </div>
      </div>
    </PageSection>
  );
}
