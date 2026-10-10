import { createFileRoute } from "@tanstack/react-router";
import { AttentionScreen } from "@/features/attention/components/attention-screen";

function AttentionPage() {
  return <AttentionScreen />;
}

export const Route = createFileRoute("/_workspace/attention/")({ component: AttentionPage });
