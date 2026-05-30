import { Skeleton } from "@/design/primitives/skeleton";

export default function SandboxLoading() {
  return (
    <div className="mx-auto max-w-[900px] px-6 py-10">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="mt-3 h-7 w-56" />
      <Skeleton variant="text" className="mt-3 w-2/3" />
      <div className="mt-6 rounded-lg border border-line bg-surface p-6">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="mt-4 h-7 w-full" />
      </div>
    </div>
  );
}
