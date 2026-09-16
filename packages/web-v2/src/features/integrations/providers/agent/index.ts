import type { ProviderModule } from "../registry";

// cm:why `agent` is a provider with nothing integrated — it is a release CHANNEL declaration (which
// box may ship and how to prove it shipped) and the deploy is the project's own script. It is here
// so a binding or status card of this provider renders with its own name rather than a raw key, and
// so `providerNames()` is the whole vocabulary rather than the part that has an adapter.
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
