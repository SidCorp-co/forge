// The onboarding and questionnaire vocabulary and response shapes are core's own, declared once in
// @forge/contracts (ISS-63); this file adds only what the screen holds before a send.
export type {
  OnboardingDesignView,
  OnboardingHint,
  OnboardingResponse,
  OnboardingStateResponse,
  OnboardingStatus,
  OnboardingView,
  QuestionnaireAnswer,
  QuestionnaireGroup,
  QuestionnaireItemView,
  QuestionnaireResponse,
  QuestionnaireStatus,
  QuestionnaireView,
} from "@forge/contracts/onboarding";

import type { QuestionnaireAnswer } from "@forge/contracts/onboarding";

/** What a person has picked in a card and not sent yet, by item id. */
export type DraftAnswers = Record<string, Omit<QuestionnaireAnswer, "itemId">>;
