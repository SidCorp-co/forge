// Top-level Attention / Inbox surface (`/v2/attention`, ISS-307). Cross-project
// items needing the caller, backed by `GET /api/me/attention` + offline runners.
import { AttentionScreen } from "@/features/attention/components/attention-screen";

export default function AttentionPage() {
  return <AttentionScreen />;
}
