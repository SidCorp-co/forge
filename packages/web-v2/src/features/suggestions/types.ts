export type {
  SuggestionBreakdownBlocker,
  SuggestionBreakdownRead,
  SuggestionBreakdownSlice,
  SuggestionKind,
  SuggestionListResponse,
  SuggestionProducer,
  SuggestionResponse,
  SuggestionView,
} from "@forge/contracts/suggestions";

/** One decision a person takes on a suggestion; an accept carries the reason the API keeps, where one was given. */
export type SuggestionDecision = { kind: "accept"; id: string; reason?: string } | { kind: "reject"; id: string; reason: string };
