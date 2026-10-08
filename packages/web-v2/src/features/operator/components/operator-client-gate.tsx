"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { formatApiError } from "@/lib/api/error";
import { ApiError } from "@/lib/api/client";
import { useOperatorWhoami } from "../hooks";
import { OperatorLoadError } from "./operator-load-error";
import { OperatorShell } from "./operator-shell";

/** The /admin gate for a request whose cookies the web host cannot see (split hosts: core's
 *  host-only cookie lives on core's origin). The browser holds it, so the browser asks core; core
 *  still refuses every /admin call that is not an admin's, so rendering this shell grants nothing. */
export function OperatorClientGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data, error } = useOperatorWhoami();
  const signedOut = error instanceof ApiError && error.status === 401;
  const notAdmin = data?.isAdmin === false;

  useEffect(() => {
    if (signedOut) router.replace("/login");
    else if (notAdmin) router.replace("/");
  }, [signedOut, notAdmin, router]);

  if (data?.isAdmin) return <OperatorShell initialWhoami={data}>{children}</OperatorShell>;
  if (error && !signedOut) {
    return (
      <OperatorLoadError
        message={error instanceof Error ? formatApiError(error) : "Couldn't reach the server."}
      />
    );
  }
  return null;
}
