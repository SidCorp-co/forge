import { redirect } from "next/navigation";
import { getOperatorWhoami } from "@/features/operator/server/whoami";
import { OperatorShell, OperatorLoadError } from "@/features/operator";

// cm:edge lockstep -> packages/web-v2/src/middleware.ts — src/middleware.ts is the pre-render 307 gate for these same routes; this second check stays authoritative for the unverified/error branches it deliberately lets through
// cm:guard Next renders the page segment in parallel with this layout, so a page under app/admin/** is still rendered when this gate refuses — a data page must gate its own fetch, never treat this verdict as its authorization
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const result = await getOperatorWhoami();

  // cm:why redirect() throws NEXT_REDIRECT; getOperatorWhoami() returns a
  // discriminated result instead of throwing so this stays outside any try/catch
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
