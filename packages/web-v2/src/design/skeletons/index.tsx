import { Skeleton } from "@/design/primitives/skeleton";
import { Card } from "@/design/primitives/card";

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
    <Card>
      <div className="flex items-center gap-3 border-b border-line-subtle px-5 py-4">
        <Skeleton className="size-9 rounded-md" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="ml-auto h-5 w-20 rounded-pill" />
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        <Skeleton variant="text" className="w-3/4" />
        <div className="flex gap-4">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-14" />
        </div>
      </div>
    </Card>
  );
}
