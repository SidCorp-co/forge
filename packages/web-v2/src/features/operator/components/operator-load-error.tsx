"use client";

import { useRouter } from "next/navigation";
import { ErrorState } from "@/design";

/** Rendered inline by `app/admin/layout.tsx` when the server-side whoami
 *  check itself fails (network/5xx) — a layout throw would escape past its
 *  own segment's error.tsx, so the gate returns a result instead of throwing.
 *  Retry calls router.refresh() to re-run the RSC gate. */
export function OperatorLoadError({ title, message }: { title?: string; message: string }) {
  const router = useRouter();
  return (
    <div className="flex h-dvh items-center justify-center bg-app">
      <ErrorState title={title} message={message} onRetry={() => router.refresh()} />
    </div>
  );
}
