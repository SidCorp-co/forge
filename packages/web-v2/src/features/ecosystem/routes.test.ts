import { describe, expect, it } from "vitest";
import { REGISTER_STATUS } from "./api";
import { ecosystemRoutes } from "./routes";

describe("the route builders part B links to", () => {
  it("builds each ecosystem page under the project", () => {
    expect(ecosystemRoutes.register("forge")).toBe("/projects/forge/ecosystem/channel");
    expect(ecosystemRoutes.register("forge", { filter: "overdue" })).toBe(
      "/projects/forge/ecosystem/channel?status=overdue",
    );
    expect(ecosystemRoutes.register("forge", { filter: "held", ecosystem: "e1" })).toBe(
      "/projects/forge/ecosystem/channel?status=held&ecosystem=e1",
    );
    expect(ecosystemRoutes.document("forge", "FP-CN-1")).toBe("/projects/forge/ecosystem/channel/FP-CN-1");
    expect(ecosystemRoutes.compose("forge", { inReplyTo: "FP-CN-1" })).toBe(
      "/projects/forge/ecosystem/channel/new?inReplyTo=FP-CN-1",
    );
    expect(ecosystemRoutes.contracts("forge")).toBe("/projects/forge/ecosystem/contracts");
    expect(ecosystemRoutes.contract("forge-plugin", "forge-api", "p1")).toBe(
      "/projects/forge-plugin/ecosystem/contracts/forge-api?provider=p1",
    );
    expect(ecosystemRoutes.apiPage("forge")).toBe("/projects/forge/ecosystem/api");
  });

  it("maps every register filter to a status core's register defines", () => {
    expect(REGISTER_STATUS).toEqual({
      awaiting: "open",
      overdue: "overdue",
      held: "held",
      answered: "answered",
      closed: "closed",
    });
  });
});
