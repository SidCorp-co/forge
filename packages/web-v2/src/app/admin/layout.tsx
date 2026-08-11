import { redirect } from "next/navigation";
import { getOperatorWhoami } from "@/features/operator/server/whoami";
import { OperatorShell, OperatorLoadError } from "@/features/operator";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const result = await getOperatorWhoami();

  // cm:why redirect() throws NEXT_REDIRECT; getOperatorWhoami() returns a
  // discriminated result instead of throwing so this stays outside any try/catch
  if (result.kind === "unauthenticated") redirect("/login");
  if (result.kind === "not-admin") redirect("/");
  if (result.kind === "unverified")
    return <OperatorLoadError message="Please verify your email before continuing." />;
  if (result.kind === "error") return <OperatorLoadError message={result.message} />;

  return <OperatorShell email={result.email}>{children}</OperatorShell>;
}
