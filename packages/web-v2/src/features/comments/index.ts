// The face of the comments feature: what other features import of it (CODE-STANDARD.md, Structure).
export { commentsApi } from "./api";
export { DecisionTarget } from "./components/decision-target";
export { DecisionComposer, Decision, Decisions, FoldedDecisions } from "./components/decisions";
export { DecisionInThread, EntityCommentThread, IntentPicker, type ComposerIntent } from "./components/entity-comment-thread";
export { useEntityDecisions } from "./hooks";
