import { UsageDashboard } from "@/components/usage-dashboard";
import { PageShell } from "@/components/ui/page-shell";

export function UsagePage() {
  return (
    <PageShell title="Usage" subtitle="Token consumption & cost analytics" scrollable maxWidth="max-w-5xl">
      <UsageDashboard />
    </PageShell>
  );
}
