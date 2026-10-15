import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import type { Bus, BusBuilder, BusLink, LinkState } from "./bus";
import { attentionOf, connectionsOf, summaryOf } from "./connections";

const t = productCopy("en");
const FE = "fe";
const API = "api";
const EPOD = "epod";
const ADMIN = { provider: API, slug: "admin-rest-v1" };
const GRAPHQL = { provider: EPOD, slug: "storefront-graphql" };

function link(module: string, patch: Partial<BusLink> = {}): BusLink {
  return {
    id: `l-${module}`,
    consumer: FE,
    module,
    contract: ADMIN,
    state: "current",
    pinnedVersion: "3.2.0",
    outsideContract: 0,
    impact: { link: `l-${module}`, version: "3.2.0", verdict: "passes", reason: "built-against", breaks: [] },
    updatedAt: "2026-10-06T13:55:17.288Z",
    ...patch,
  };
}

const READ_DEV: BusBuilder = {
  id: "run-api",
  trigger: { kind: "joined", sha: "fe1158c15bc5e6dff4660e0ecee90b0fbc2dd2cd", head: { ref: "refs/heads/dev", readAt: "2026-10-06T00:33:47.000Z", via: "runner-checkout" } },
  steps: [
    { name: "match-contracts", status: "succeeded" },
    { name: "write-links", status: "skipped", detail: "Nothing matched, so no link to write." },
  ],
  stepsStale: false,
  supersededBy: null,
  findings: 10,
  links: 0,
  createdAt: "2026-10-06T00:33:47.973Z",
  updatedAt: "2026-10-06T01:04:21.945Z",
};

// ePOD x Catalog as the live bus read it on 2026-10-15: catalog-fe calls admin-rest-v1 from ten modules, and
// catalog-api's interface declares storefront-graphql with no link behind it
const MODULES = ["modules/designs", "modules/catalog", "modules/reports", "apis/catalog", "apis/catalog-content", "apis/common", "apis/get-store-detail", "apis/get-store-list", "apis/report", "apis/store"];
const OUTSIDE = [3, 0, 0, 41, 3, 18, 0, 0, 12, 26];

function bus(patch: Partial<Bus> = {}): Bus {
  return {
    ecosystem: { id: "eco", slug: "epod-catalog", name: "ePOD x Catalog" },
    projects: [
      { id: API, slug: "catalog-api", name: "Catalog API", builder: READ_DEV },
      { id: FE, slug: "catalog-fe", name: "Catalog FE", builder: null },
      { id: EPOD, slug: "epod", name: "ePOD", builder: null },
    ],
    contracts: [
      { ...GRAPHQL, title: "ePOD storefront", type: "graphql", lifecycle: "production", currentVersion: "1.2.0" },
      { ...ADMIN, title: "admin REST", type: "openapi", lifecycle: "production", currentVersion: "3.2.0" },
    ],
    links: MODULES.map((m, i) => link(m, { outsideContract: OUTSIDE[i] })),
    declared: [
      { consumer: FE, contract: ADMIN, builtAgainst: "3.0.0", usedBy: ["catalog-fe"], linked: true },
      { consumer: API, contract: GRAPHQL, builtAgainst: "1.2.0", usedBy: ["epod-deployer"], linked: false },
    ],
    ...patch,
  };
}

describe("connections: one consumer project and one contract a row", () => {
  it("folds a consumer's ten module links to one connection with its modules, versions and outside total", () => {
    const fe = connectionsOf(bus()).filter((c) => c.consumer === FE);
    expect(fe).toHaveLength(1);
    expect(fe[0]).toMatchObject({ contract: ADMIN, uses: ["3.2.0"], latest: "3.2.0", state: "current", impact: "passes", outsideContract: 103 });
    expect(fe[0].modules.map((l) => l.module)).toEqual(MODULES);
  });

  it("keeps a declared use no link backs as a connection said unfound, never dropped", () => {
    const api = connectionsOf(bus()).find((c) => c.consumer === API);
    expect(api).toMatchObject({ contract: GRAPHQL, modules: [], uses: [], state: "unfound", impact: "unchecked", latest: "1.2.0" });
    expect(api?.declared?.builtAgainst).toBe("1.2.0");
  });

  it("takes the worst state and verdict of its modules, and every version they pin", () => {
    const worst = (states: LinkState[]) =>
      connectionsOf(bus({ links: states.map((state, i) => link(`m${i}`, { state, pinnedVersion: `3.${i}.0` })), declared: [] }))[0];
    expect(worst(["current", "behind", "current"]).state).toBe("behind");
    expect(worst(["building", "breaking", "behind"]).state).toBe("breaking");
    expect(worst(["current", "unverified"]).uses).toEqual(["3.0.0", "3.1.0"]);
    const breaks = link("m9", { impact: { link: "l-m9", version: "4.0.0", verdict: "breaks", reason: "touched", breaks: [] } });
    expect(connectionsOf(bus({ links: [link("m1"), breaks], declared: [] }))[0].impact).toBe("breaks");
    expect(connectionsOf(bus({ links: [link("m1"), link("m2", { impact: null })], declared: [] }))[0].impact).toBe("unchecked");
  });

  it("orders versions by number, not by text", () => {
    const links = ["3.10.0", "3.9.0"].map((v, i) => link(`m${i}`, { pinnedVersion: v }));
    expect(connectionsOf(bus({ links, declared: [] }))[0].uses).toEqual(["3.9.0", "3.10.0"]);
  });

  it("reads an ecosystem with no link and no declared use as no connection", () => {
    expect(connectionsOf(bus({ links: [], declared: [] }))).toEqual([]);
  });
});

describe("what needs attention", () => {
  it("names the unfound use and the calls outside the contract, one entry each", () => {
    const b = bus();
    expect(attentionOf(b, connectionsOf(b)).map((a) => a.kind)).toEqual(["unfound", "outside"]);
  });

  it("puts breaking before behind before unfound, and a failed builder last", () => {
    const failed: BusBuilder = { ...READ_DEV, steps: [{ name: "find-outbound-calls", status: "failed" }] };
    const b = bus({
      projects: [{ id: EPOD, slug: "epod", name: "ePOD", builder: failed }, ...bus().projects.filter((p) => p.id !== EPOD)],
      links: [link("a", { state: "behind", pinnedVersion: "3.0.0" }), link("b", { consumer: EPOD, state: "breaking" })],
    });
    const kinds = attentionOf(b, connectionsOf(b)).map((a) => a.kind);
    expect(kinds).toEqual(["breaking", "behind", "unfound", "builderFailed"]);
  });

  it("is empty when every connection is current, inside its contract and found", () => {
    const b = bus({ links: [link("m1")], declared: [] });
    expect(attentionOf(b, connectionsOf(b))).toEqual([]);
  });
});

describe("the summary sentence", () => {
  it("names who uses what from whom and how many need attention", () => {
    const b = bus();
    const c = connectionsOf(b);
    expect(summaryOf(b, c, attentionOf(b, c), t)).toBe(
      "3 projects · catalog-api declares epod's storefront-graphql, not found in code · catalog-fe uses catalog-api's admin-rest-v1 · 2 need attention",
    );
  });

  it("says all current when nothing needs attention, and that nobody uses a contract when nobody does", () => {
    const current = bus({ links: [link("m1")], declared: [] });
    const c = connectionsOf(current);
    expect(summaryOf(current, c, attentionOf(current, c), t)).toBe("3 projects · catalog-fe uses catalog-api's admin-rest-v1 · all current");
    const idle = bus({ links: [], declared: [] });
    expect(summaryOf(idle, [], [], t)).toBe("3 projects · no project uses another's contract yet");
  });
});
