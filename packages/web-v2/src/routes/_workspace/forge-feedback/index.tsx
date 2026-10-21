import { createFileRoute } from "@tanstack/react-router";
import { MyForgeFeedback } from "@/features/feedback";

function MyForgeFeedbackPage() {
  return <MyForgeFeedback />;
}

export const Route = createFileRoute("/_workspace/forge-feedback/")({ component: MyForgeFeedbackPage });
