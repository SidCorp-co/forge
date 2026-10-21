import { createContext, type ReactNode, use } from "react";

/** The form that files feedback about one mockup (REQ-49 BC-4), already about it. */
export type MockupFeedbackForm = (p: { projectId: string; slug: string; mockupKey: string; onDone: (feedbackKey: string) => void }) => ReactNode;

const MockupFeedbackContext = createContext<MockupFeedbackForm | null>(null);

/**
 * Feedback sits above mockups among the features (a feedback item shows the mockups proposed on it),
 * so the full-screen view cannot import its form: the workspace hands it down here. With none, the
 * view offers no Feedback act.
 */
export function MockupFeedbackSlot({ form, children }: { form: MockupFeedbackForm; children: ReactNode }) {
  return <MockupFeedbackContext value={form}>{children}</MockupFeedbackContext>;
}

export const useMockupFeedbackForm = () => use(MockupFeedbackContext);
