// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionSummary } from "@/features/integrations/types";
import { ApiError } from "@/lib/api/client";

expect.extend(matchers);
Element.prototype.scrollIntoView = vi.fn();

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
const CONNECTION = "c0f1e2d3-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const UUID = "y8w4c4kss8ogo8gc44ow44kc";

const bind = vi.fn();
let bindState: { isError: boolean; error: unknown } = { isError: false, error: null };
let connections: ConnectionSummary[] = [];

vi.mock("@/features/integrations/hooks", () => ({
  useConnections: () => ({ data: { items: connections }, isLoading: false }),
  useBindConnection: () => ({ mutate: bind, isPending: false, ...bindState }),
  useIsOrgAdmin: () => true,
  useCoolifyApplications: () => ({ data: undefined, isError: false }),
  useCoolifyTargets: () => ({ data: undefined }),
}));

vi.mock("@/features/integrations/components/project-integrations-panel", () => ({
  ProjectIntegrationsPanel: () => null,
}));

const { ShareExistingCard } = await import("./integrations-tab");

function coolifyConnection(): ConnectionSummary {
  return {
    id: CONNECTION,
    provider: "coolify",
    displayName: "Coolify prod",
    active: true,
    hasSecrets: true,
  } as ConnectionSummary;
}

function pickConnection() {
  fireEvent.click(screen.getAllByRole("combobox")[0] as HTMLElement);
  fireEvent.click(screen.getByRole("option", { name: /Coolify prod/ }));
}

const share = () => fireEvent.click(screen.getByRole("button", { name: "Share with this project" }));

beforeEach(() => {
  bind.mockReset();
  bindState = { isError: false, error: null };
  connections = [coolifyConnection()];
});

afterEach(cleanup);

describe("sharing a Coolify connection", () => {
  it("writes nothing until an application is chosen, and says what is missing", () => {
    render(<ShareExistingCard projectId={PROJECT} canEdit />);
    pickConnection();
    share();
    expect(bind).not.toHaveBeenCalled();
    expect(screen.getByText(/Choose at least one Coolify application before sharing/)).toBeInTheDocument();
  });

  it("names the row that is half filled in rather than dropping it", () => {
    render(<ShareExistingCard projectId={PROJECT} canEdit />);
    pickConnection();
    fireEvent.change(screen.getByPlaceholderText("Backend"), { target: { value: "web" } });
    share();
    expect(bind).not.toHaveBeenCalled();
    expect(screen.getByText(/Application 1 needs both a label and a Coolify application/)).toBeInTheDocument();
  });

  it("binds with the applications it collected", () => {
    render(<ShareExistingCard projectId={PROJECT} canEdit />);
    pickConnection();
    fireEvent.change(screen.getByPlaceholderText("Backend"), { target: { value: " web " } });
    fireEvent.change(screen.getByPlaceholderText("application uuid from Coolify"), {
      target: { value: UUID },
    });
    share();
    expect(bind.mock.calls[0]?.[0]).toMatchObject({
      connectionId: CONNECTION,
      provider: "coolify",
      binding: { targets: [{ label: "web", resourceUuid: UUID }] },
    });
  });

  it("shows core's refusal of the share plainly, at the path it names", () => {
    bindState = {
      isError: true,
      error: new ApiError(422, "refused", "SCHEMA_VIOLATION", undefined, {
        error: {
          code: "SCHEMA_VIOLATION",
          refusals: [
            {
              code: "SCHEMA_VIOLATION",
              path: "/target/applications",
              detail: "expected at least 1 application",
            },
          ],
        },
      }),
    };
    render(<ShareExistingCard projectId={PROJECT} canEdit />);
    expect(
      screen.getByText("SCHEMA_VIOLATION at /target/applications: expected at least 1 application"),
    ).toBeInTheDocument();
  });
});
