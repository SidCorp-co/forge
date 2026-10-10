import { redirect } from "next/navigation";
import { getOperatorWhoami } from "@/features/operator/server/whoami";
import { SESSION_ENDED_LOGIN } from "@/features/operator/server/whoami-fetch";
import { OperatorShell, OperatorLoadError, OperatorClientGate } from "@/features/operator";
import { productCopy } from "@/lib/i18n/product-copy";

// a server layout knows no interface language: English
const t = productCopy();

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const result = await getOperatorWhoami();

  if (result.kind === "session-ended") redirect(SESSION_ENDED_LOGIN);
  if (result.kind === "undetermined") return <OperatorClientGate>{children}</OperatorClientGate>;
  if (result.kind === "not-admin") redirect("/");
  if (result.kind === "unverified")
    return (
      <OperatorLoadError
        title={t("common.admin.unverifiedTitle")}
        message={t("common.admin.unverifiedMessage")}
      />
    );
  if (result.kind === "error")
    return (
      <OperatorLoadError
        message={result.status === null ? t("operator.whoami.reachFailed") : t("operator.whoami.requestFailed", { status: result.status })}
      />
    );

  return (
    <OperatorShell initialWhoami={{ isAdmin: true, email: result.email }}>{children}</OperatorShell>
  );
}
