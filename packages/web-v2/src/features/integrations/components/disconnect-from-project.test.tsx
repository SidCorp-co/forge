// @vitest-environment jsdom
//
// ISS-1421 r26, judge-105 (3) and (7): Coolify and Epodsystem called taking a binding off a project
// Delete, which keeps the row; Sentry and Postman sent it on one click while the others asked; and a
// binding already switched off still offered Disconnect.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BindingActs } from "@forge/contracts";

expect.extend(matchers);

const remove = vi.fn();
vi.mock("../hooks", () => ({
  useDeleteProviderIntegration: () => ({ mutate: remove, isPending: false }),
}));

const { DISCONNECT_FROM_PROJECT, DisconnectFromProject, disconnectSays } = await import(
  "./disconnect-from-project"
);

afterEach(() => {
  cleanup();
  remove.mockReset();
});

const ACTS: BindingActs = {
  change: true,
  saveKey: true,
  turnOn: true,
  grantAgents: true,
  whoChanges: "an admin of this project",
  whoSavesKey: "its owner or an admin of a project it is shared with",
  whoTurnsOn: "its owner",
  whoGrantsAgents: "an admin of this project",
};
const live = { id: "b1", bindingActive: true, connectionActive: true, hasSecrets: true, acts: ACTS };
const SAYS =
  "Disconnecting switches Sentry off for this project, and nothing here uses it until Enabled in this drawer switches it back on. The connection and its key stay.";

describe("Disconnect from this project (criteria 299 to 302)", () => {
  it("sends nothing until the question is answered, and then one request", () => {
    render(
      <div className="flex flex-wrap">
        <DisconnectFromProject projectId="p1" binding={live} subject="Sentry" />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: DISCONNECT_FROM_PROJECT }));
    expect(remove).not.toHaveBeenCalled();
    expect(
      screen.getByText(SAYS),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[0]).toBe("b1");
  });

  it("closes the question on Cancel and sends nothing", () => {
    render(<DisconnectFromProject projectId="p1" binding={live} subject="Sentry" />);
    fireEvent.click(screen.getByRole("button", { name: DISCONNECT_FROM_PROJECT }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(SAYS)).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it("is not offered on a binding already switched off for this project", () => {
    render(<DisconnectFromProject projectId="p1" binding={{ ...live, bindingActive: false }} subject="Sentry" />);
    expect(screen.queryByRole("button", { name: DISCONNECT_FROM_PROJECT })).toBeNull();
  });

  // ISS-1421 r27: a plain member of the project was offered Disconnect, which core refuses them.
  it("is not offered to a reader core would refuse it", () => {
    render(
      <DisconnectFromProject projectId="p1" binding={{ ...live, acts: { ...ACTS, change: false } }} subject="Sentry" />,
    );
    expect(screen.queryByRole("button", { name: DISCONNECT_FROM_PROJECT })).toBeNull();
  });

  it("says the shared connection has to come back on too where it is off but holds its key", () => {
    expect(disconnectSays("Postman", { connectionActive: false, hasSecrets: true })).toBe(
      "Disconnecting switches Postman off for this project, and nothing here uses it until its shared connection is turned back on and Enabled in this drawer switches it back on. The connection and its key stay.",
    );
  });

  it("says a binding over a removed connection stays off if the connection comes back", () => {
    expect(disconnectSays("Postman", { connectionActive: false, hasSecrets: false })).toBe(
      "Disconnecting switches Postman off for this project, so it stays off if the connection is turned back on.",
    );
  });

  it.each(["coolify", "epodsystem", "sentry", "postman", "google", "rocketchat", "github"])(
    "is the one way %s takes a binding off a project, never a browser confirm or a Delete",
    (provider) => {
      const source = readFileSync(join(__dirname, "..", "providers", provider, "section.tsx"), "utf8");
      expect(source).toContain("<DisconnectFromProject");
      expect(source).not.toMatch(/window\.confirm|useDeleteProviderIntegration/);
      // One wording from one place: no provider writes its own question (GitHub's lacked "switched off").
      expect(source).not.toMatch(/\bsays=/);
    },
  );
});
