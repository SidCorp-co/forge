
import { describe, expect, it } from "vitest";
import {
  PROVIDER_MODULES,
  connectionTargetFor,
  isDrillableProvider,
  providerForMcpServerName,
  providerIcon,
  providerLabel,
  providerModule,
  providerNames,
} from "./registry";

describe("the registry as a vocabulary", () => {
  it("declares every provider exactly once", () => {
    const names = providerNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives a label and an icon to every provider it declares, so nothing renders bare", () => {
    for (const m of PROVIDER_MODULES) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.label).not.toBe(m.provider);
      expect(m.icon.length).toBeGreaterThan(0);
    }
  });

  it("pairs a secret field with a placeholder, or declares neither", () => {
    for (const m of PROVIDER_MODULES) {
      expect(m.secretField === null).toBe(m.secretPlaceholder === null);
    }
  });

  it("names the provider of every declared MCP server name, and nobody else's", () => {
    for (const m of PROVIDER_MODULES) {
      if (m.mcpServerName === null) continue;
      expect(providerForMcpServerName(m.mcpServerName)).toBe(m);
    }
    expect(providerForMcpServerName("playwright")).toBeUndefined();
    expect(providerForMcpServerName("chrome-devtools-mcp")).toBeUndefined();
  });

  it("resolves a labelled entry of a multi-binding provider and refuses the same shape elsewhere", () => {
    const multi = PROVIDER_MODULES.find((m) => m.multiBinding && m.mcpServerName);
    expect(multi).toBeDefined();
    if (multi?.mcpServerName) {
      expect(providerForMcpServerName(`${multi.mcpServerName}_second_shop`)).toBe(multi);
    }
    const single = PROVIDER_MODULES.find((m) => !m.multiBinding && m.mcpServerName);
    expect(single).toBeDefined();
    if (single?.mcpServerName) {
      expect(providerForMcpServerName(`${single.mcpServerName}_mine`)).toBeUndefined();
    }
  });
});

describe("lookups a screen makes", () => {
  it("falls back to the raw name for a provider this build does not know", () => {
    expect(providerModule("quasar")).toBeUndefined();
    expect(providerLabel("quasar")).toBe("quasar");
    expect(providerIcon("quasar")).toBe("link");
    expect(isDrillableProvider("quasar")).toBe(false);
    expect(connectionTargetFor("quasar", { baseUrl: "https://x.example" })).toBeNull();
  });

  it("marks the release channel undrillable — there is no credential drawer behind it", () => {
    expect(isDrillableProvider("agent")).toBe(false);
    expect(providerLabel("agent")).not.toBe("agent");
  });

  it("reads a target off each provider's own config keys", () => {
    expect(connectionTargetFor("coolify", { baseUrl: "https://coolify.example.com/x" })).toBe(
      "coolify.example.com",
    );
    expect(connectionTargetFor("rocketchat", { serverUrl: "https://chat.example.com" })).toBe(
      "chat.example.com",
    );
    expect(connectionTargetFor("postman", { workspaceName: "Forge API" })).toBe("Forge API");
    expect(connectionTargetFor("epodsystem", { storeSlug: "mowment" })).toBe("mowment");
    expect(
      connectionTargetFor("github", { owner: "SidCorp-co", repo: "forge" }),
    ).toBe("SidCorp-co/forge");
  });

  it("reads the two identities the generic key list could not", () => {
    expect(connectionTargetFor("sentry", { host: "logs.canawan.com" })).toBe("logs.canawan.com");
    expect(connectionTargetFor("google", { clientEmail: "forge@p.iam.gserviceaccount.com" })).toBe(
      "forge@p.iam.gserviceaccount.com",
    );
  });

  it("omits the line rather than inventing one when the config says nothing", () => {
    expect(connectionTargetFor("coolify", {})).toBeNull();
    expect(connectionTargetFor("coolify", { baseUrl: "not a url" })).toBeNull();
    expect(connectionTargetFor("github", { owner: "SidCorp-co" })).toBeNull();
  });

  it("declares no typed credential for a provider whose credential is minted elsewhere", () => {
    expect(providerModule("github")?.secretField).toBeNull();
    expect(providerModule("google")?.secretField).toBe("serviceAccountJson");
    expect(providerModule("coolify")?.secretField).toBe("apiToken");
  });
});
