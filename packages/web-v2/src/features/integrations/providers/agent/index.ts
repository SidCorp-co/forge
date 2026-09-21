import type { ProviderModule } from "../registry";

export const agent: ProviderModule = {
  provider: "agent",
  label: "Agent release channel",
  icon: "agent",
  secretField: null,
  secretPlaceholder: null,
  drillable: false,
  agentPathKind: "none",
  mcpServerName: null,
  multiBinding: false,
  target: () => null,
  section: null,
  connectionSection: null,
  connectionNote: null,
};
