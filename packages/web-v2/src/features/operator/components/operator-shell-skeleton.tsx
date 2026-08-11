import { Skeleton } from "@/design";

/** Shell-shaped loading fallback for `app/admin/loading.tsx` — mirrors
 *  `OperatorShell`'s layout so the gate check never renders a blank flash. */
export function OperatorShellSkeleton() {
  return (
    <div className="flex h-dvh overflow-hidden bg-app">
      <div className="hidden h-full w-[232px] flex-none flex-col gap-5 border-r border-line bg-surface px-3 py-4 md:flex">
        <Skeleton className="size-7 rounded-md" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 flex-none items-center border-b border-line bg-surface px-5">
          <Skeleton variant="text" className="h-4 w-32" />
        </div>
        <div className="flex-1 space-y-3 p-6">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  );
}
