// The mockup vocabulary and response shapes are core's own, declared once in @forge/contracts (ISS-78).
export type {
  CommentMockupRequest,
  MockupCommentResponse,
  MockupCommentsResponse,
  MockupCommentView,
  MockupListResponse,
  MockupPin,
  MockupResponse,
  MockupView,
  ProposeMockupRequest,
} from "@forge/contracts/mockups";

/** Which target a panel lists: exactly one, as a proposal names exactly one. */
export type MockupTarget =
  | { type: "requirement"; key: string }
  | { type: "feedback"; key: string }
  | { type: "issue"; key: string };
