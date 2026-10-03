// The suggestion vocabulary and response shapes are core's own, declared once in @forge/contracts (ISS-58).
export type {
  SuggestionKind,
  SuggestionListResponse,
  SuggestionProducer,
  SuggestionResponse,
  SuggestionStatus,
  SuggestionView,
} from "@forge/contracts/suggestions";

/** One decision a person takes on a suggestion from the requirement page. */
export type SuggestionDecision = { kind: "accept"; id: string } | { kind: "reject"; id: string; reason: string };
