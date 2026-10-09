/**
 * The triage checklist's answers a test's triage gives where its answers are not what the test is
 * about (`@forge/contracts/checklist-registry:FEEDBACK_TRIAGE_CHECKLIST`, Feedback lifecycle r14
 * triage-check): no criterion, a severity, and how it was reproduced. A test of the checklist itself
 * writes its own.
 */
export const TRIAGE_ANSWERS = {
  criterion: 'none',
  severity: 'medium',
  reproduced: 'Reproduced on the test build.',
} as const;
