// The HOP master asked to link ISS-136 to REQ-5 and the web had no way (2026-10-08): the issue rail's
// Requirement property links an issue to an agreed requirement or unlinks it, with core's refusal
// shown by its name. The live QA the same day found the picker linked on pick, so a stray pick
// re-planned an issue: picking now asks first, and only the confirm links.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { IssueRequirementProperty } from "./requirement-property";

const refusal = (code: string, detail: string) => ({
  status: 422,
  body: { error: { code: "REQUIREMENT_REFUSED", message: "refused", refusals: [{ code, path: "/issue", detail }] } },
});

describe("the issue rail's Requirement property", () => {
  it("unlinks the requirement the issue delivers", async () => {
    const calls = fakeCore(() => ({ body: { key: "REQ-5", issues: [] } }));
    const user = userEvent.setup();
    renderWithQuery(<IssueRequirementProperty projectId="p1" slug="hop" issueKey="ISS-136" current="REQ-5" disabled={false} />);
    expect(screen.getByRole("link", { name: "REQ-5" })).toHaveAttribute("href", "/projects/hop/requirements/REQ-5");
    await user.click(screen.getByTestId("issue-requirement-unlink"));
    await waitFor(() => expect(calls).toContainEqual({ method: "DELETE", path: "/projects/p1/requirements/REQ-5/issues/ISS-136", body: undefined }));
  });

  it("offers only agreed requirements to link, and names a refusal", async () => {
    const calls = fakeCore((c) => {
      if (c.method === "GET" && c.path === "/projects/p1/requirements?view=summary") {
        return {
          body: {
            requirements: [
              { key: "REQ-5", title: "Referrals", status: "agreed" },
              { key: "REQ-6", title: "Drafted", status: "draft" },
            ],
            returned: 2,
          },
        };
      }
      if (c.method === "POST") return refusal("REQUIREMENT_DEFERRED", "REQ-5 is deferred");
      return undefined;
    });
    const user = userEvent.setup();
    renderWithQuery(<IssueRequirementProperty projectId="p1" slug="hop" issueKey="ISS-136" current={null} disabled={false} />);
    await user.click(await screen.findByRole("combobox", { name: "Link to a requirement…" }));
    expect(screen.queryByRole("option", { name: /REQ-6/ })).toBeNull();
    await user.click(await screen.findByRole("option", { name: /REQ-5/ }));
    await user.click(await screen.findByRole("button", { name: "Link" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "/projects/p1/requirements/REQ-5/issues", body: { issue: "ISS-136" } }));
    expect(await screen.findByTestId("issue-requirement-refusal")).toHaveTextContent("REQUIREMENT_DEFERRED");
  });

  it("asks before it links, naming the issue and the requirement, and a cancel links nothing", async () => {
    const calls = fakeCore((c) =>
      c.method === "GET" && c.path === "/projects/p1/requirements?view=summary"
        ? { body: { requirements: [{ key: "REQ-5", title: "Referrals", status: "agreed" }], returned: 1 } }
        : undefined,
    );
    const user = userEvent.setup();
    renderWithQuery(<IssueRequirementProperty projectId="p1" slug="hop" issueKey="ISS-136" current={null} disabled={false} />);
    await user.click(await screen.findByRole("combobox", { name: "Link to a requirement…" }));
    await user.click(await screen.findByRole("option", { name: /REQ-5/ }));
    const ask = await screen.findByRole("alertdialog");
    expect(ask).toHaveTextContent("Link ISS-136 to REQ-5?");
    expect(ask).toHaveTextContent("ISS-136 will deliver REQ-5 Referrals.");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });
});
