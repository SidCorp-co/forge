import { createFileRoute } from "@tanstack/react-router";
import { DocsScreen } from "@/features/docs/components/docs-screen";

function DocsPage() {
  return <DocsScreen />;
}

export const Route = createFileRoute("/_workspace/docs/")({ component: DocsPage });
