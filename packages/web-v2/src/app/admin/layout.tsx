import { redirect } from "next/navigation";
import { getOperatorWhoami } from "@/features/operator/server/whoami";
import { OperatorShell, OperatorLoadError } from "@/features/operator";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const result = await getOperatorWhoami();

  if (result.kind === "unauthenticated") redirect("/login");
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
