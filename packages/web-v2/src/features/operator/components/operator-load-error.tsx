"use client";

import { useRouter } from "next/navigation";
import { ErrorState } from "@/design";
import { ApiError } from "@/lib/api/client";

/** `status` is the failed answer's, absent where nothing answered: it decides whether Retry is offered (ISS-1229 r50). */
export function OperatorLoadError({ title, message, status }: { title: string; message: string; status?: number }) {
  const router = useRouter();
  const error = status === undefined ? undefined : new ApiError(status, message);
  return (
    <div className="flex h-dvh items-center justify-center bg-app">
      <ErrorState level={1} title={title} message={message} error={error} onRetry={() => router.refresh()} />
    </div>
  );
}
