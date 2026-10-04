export type {
  RunEvent,
  RunGroup,
  RunHeld,
  RunStanding,
  RunStandingDetail,
  RunStandingList,
  RunStandingScope,
} from "@forge/contracts/run-standing";
export type { MasterClosedPass, MasterPassList, MasterPassView, MasterStanding } from "@forge/contracts/master-standing";

/** `GET /api/projects/:id/master-charter`: what the project's master is for. */
export interface MasterCharter {
  declared: boolean;
  version: number | null;
  goal: string | null;
  rules: string[];
  declaredBy: string | null;
  declaredAt: string | null;
}
