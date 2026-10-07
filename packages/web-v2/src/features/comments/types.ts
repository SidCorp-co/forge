import type { ListDecisionsQuery } from "@forge/contracts/comments";

export type {
  CreateEntityCommentRequest,
  DecisionFields,
  DecisionListResponse,
  EntityCommentListResponse,
  EntityCommentResponse,
  EntityCommentScope,
  EntityCommentView,
} from "@forge/contracts/comments";

/** The narrowing the project's Decisions view sends; each one left out narrows nothing. */
export type DecisionFilters = Partial<Pick<ListDecisionsQuery, "requirement" | "workflow" | "issue" | "who" | "since" | "until" | "limit">>;
