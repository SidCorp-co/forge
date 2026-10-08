import type { EntityCommentScope } from "@forge/contracts/comments";

export type {
  CreateEntityCommentRequest,
  DecisionFields,
  EntityCommentListResponse,
  EntityCommentResponse,
  EntityCommentScope,
  EntityCommentView,
} from "@forge/contracts/comments";

/** What an item's decisions are read on: a requirement, workflow or feedback item, or an issue (REQ-33 BC-2). */
export type DecisionReadScope = EntityCommentScope | "issue";
