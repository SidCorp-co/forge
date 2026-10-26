import { PROVIDER_LABELS } from "@forge/contracts/health-words";
import type { ProviderModule } from "../registry";

export const agent: ProviderModule = {
  provider: "agent",
  label: PROVIDER_LABELS.agent,
  icon: "agent",
  secretField: null,
  secretPlaceholder: null,
  previousKeyNote: null,
  drillable: false,
  agentPathKind: "none",
  mcpServerName: null,
  multiBinding: false,
  target: () => null,
  section: null,
  connectionSection: null,
  connectionNote: null,
};
