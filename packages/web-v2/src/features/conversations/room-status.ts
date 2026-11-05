// What a room's header says it is doing (ISS-1006): the header and the thread under it read one
// fact. While the thread draws its turn working or writing its answer, the header reads in progress,
// whatever the room's stored status last said; only once no turn is drawn running does it wear that
// status, so it never reads Done above an answer still being written.

import type { OnboardingStatus } from "@forge/contracts/onboarding";
import type { TurnStage } from "@/features/session";

export function roomStatusOf(stored: OnboardingStatus | null | undefined, stage: TurnStage | null): OnboardingStatus | null | undefined {
  if (stage === "working" || stage === "responding") return "in_progress";
  return stored;
}
