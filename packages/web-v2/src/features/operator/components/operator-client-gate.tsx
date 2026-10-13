
import { useEffect } from "react";
import { useRouter } from "@/lib/navigation/router";
import { SignInStopped } from "@/features/auth";
import { useLoginRedirect } from "@/features/auth";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { ApiError } from "@/lib/api/client";
import { useOperatorWhoami } from "../hooks";
import { OperatorLoadError } from "./operator-load-error";
import { OperatorShell } from "./operator-shell";

/** The /admin gate in the browser: it asks core who this is; core still refuses every /admin call
 *  that is not an admin's, so rendering this shell grants nothing. */
export function OperatorClientGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const t = useCopy();
  const { data, error } = useOperatorWhoami();
  const signedOut = error instanceof ApiError && error.status === 401;
  const notAdmin = data?.isAdmin === false;

  const { stopped } = useLoginRedirect(signedOut, data !== undefined);
  useEffect(() => {
    if (notAdmin) router.replace("/");
  }, [notAdmin, router]);

  if (stopped) return <SignInStopped />;
  if (data?.isAdmin) return <OperatorShell initialWhoami={data}>{children}</OperatorShell>;
  if (error && !signedOut) {
    return (
      <OperatorLoadError
        message={error instanceof Error ? formatApiError(error) : t("operator.gate.error")}
      />
    );
  }
  return null;
}
