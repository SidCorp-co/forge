import type { ReactNode } from "react";
import { type MockupFeedbackForm, MockupFeedbackSlot } from "@/features/mockups";
import { FeedbackForm } from "./feedback-form";

const aboutTheMockup: MockupFeedbackForm = ({ projectId, slug, mockupKey, onDone }) => (
  <FeedbackForm projectId={projectId} slug={slug} draft={{ kind: "bug", severity: "medium", targetType: "mockup", target: mockupKey, title: "", body: "" }} onDone={onDone} />
);

/** Lets a mockup open full screen file feedback about itself (REQ-49 BC-4) with this feature's form. */
export function MockupFeedback({ children }: { children: ReactNode }) {
  return <MockupFeedbackSlot form={aboutTheMockup}>{children}</MockupFeedbackSlot>;
}
