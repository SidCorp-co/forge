import { redirect } from "next/navigation";
import { getOperatorWhoami } from "@/features/operator/server/whoami";
import { SESSION_ENDED_LOGIN } from "@/features/operator/server/whoami-fetch";
import { OperatorShell, OperatorLoadError, OperatorClientGate } from "@/features/operator";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const result = await getOperatorWhoami();

  if (result.kind === "session-ended") redirect(SESSION_ENDED_LOGIN);
  if (result.kind === "undetermined") return <OperatorClientGate>{children}</OperatorClientGate>;
  if (result.kind === "not-admin") redirect("/");
  if (result.kind === "unverified")
    return (
      <OperatorLoadError
        title="Verify your email to continue"
        message="Open the verification link we emailed you, then retry."
      />
    );
  if (result.kind === "error") return <OperatorLoadError message={result.message} />;

  return (
    <OperatorShell initialWhoami={{ isAdmin: true, email: result.email }}>{children}</OperatorShell>
  );
}
