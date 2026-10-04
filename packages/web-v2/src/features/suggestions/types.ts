export type {
  SuggestionKind,
  SuggestionListResponse,
  SuggestionProducer,
  SuggestionResponse,
  SuggestionView,
} from "@forge/contracts/suggestions";

/** One decision a person takes on a suggestion from the requirement page. */
export type SuggestionDecision = { kind: "accept"; id: string } | { kind: "reject"; id: string; reason: string };
