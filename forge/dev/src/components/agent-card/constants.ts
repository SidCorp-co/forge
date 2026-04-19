export const FOCUS_AREAS: { value: string; label: string; description: string }[] = [
  { value: "feature-gaps", label: "Feature Gaps", description: "Features users would expect but aren't tracked" },
  { value: "journey-completeness", label: "Journey Completeness", description: "Implied features missing from existing flows" },
  { value: "polish", label: "Polish & QoL", description: "Empty states, loading, error handling, onboarding" },
  { value: "accessibility", label: "Accessibility", description: "Keyboard nav, screen reader, contrast gaps" },
  { value: "ux-improvements", label: "UX Improvements", description: "Friction points, confusing flows, missing feedback" },
];
