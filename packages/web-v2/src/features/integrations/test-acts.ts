import type { BindingActs, ProjectIntegrationActs } from "@forge/contracts";

/**
 * What core answers a reader who may do everything with a binding and on the tab — the acts a test
 * fixture carries unless the test is about a reader who may not (ISS-1421 r27).
 */
export const ALL_ACTS: BindingActs = {
  change: true,
  saveKey: true,
  turnOn: true,
  grantAgents: true,
  whoChanges: "an admin of this project",
  whoSavesKey: "its owner or an admin of a project it is shared with",
  whoTurnsOn: "its owner",
  whoGrantsAgents: "an admin of this project",
};

export const ALL_MAY: ProjectIntegrationActs = {
  connect: true,
  whoConnects: "an admin of this project",
  grantBoxAgents: true,
  whoGrantsBoxAgents: "an owner or admin of this project's organization",
  changeProjectSettings: true,
  whoChangesProjectSettings: "an owner or admin of this project's organization",
};
