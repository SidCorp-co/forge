// @vitest-environment jsdom
//
// Three things carry this screen, and the last two are not React at all — they
// are the pure rules the directory and the delivery log run on, asserted here
// because they are what criteria 22 and 28 are about and they belong beside the
// provider they were added for.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupConnectionsByApp } from "../connection-groups";
import { DIRECTORY_STATUS_META, deriveConnectionStatus, redactSensitive, REDACTED } from "../derive";
import type { IntegrationSummary } from "../types";
import { GoogleSection } from "./google-section";

expect.extend(matchers);
afterEach(cleanup);

const createMutate = vi.fn();
const updateMutate = vi.fn();
const listItems = vi.fn<() => IntegrationSummary[]>();

const listIsError = vi.fn<() => boolean>();
const listRefetch = vi.fn();

vi.mock("../hooks", () => ({
  useIntegrationsList: () => ({
    data: listIsError() ? undefined : { items: listItems() },
    isLoading: false,
    isError: listIsError(),
    error: new Error("network"),
    refetch: listRefetch,
  }),
  useCreateProviderIntegration: () => ({ mutateAsync: createMutate, isPending: false }),
  useUpdateProviderIntegration: () => ({ mutateAsync: updateMutate, isPending: false }),
  useDeleteProviderIntegration: () => ({ mutate: vi.fn(), isPending: false }),
  useTestIntegration: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useOrgConnectionLocked: () => false,
}));

vi.mock("./connection-owner-field", () => ({
  ConnectionOwnerField: () => null,
}));

vi.mock("./integration-enabled-control", () => ({
  IntegrationEnabledControl: () => null,
}));

const KEY_FILE = JSON.stringify({
  type: "service_account",
  client_email: "forge@forge-sheets-1.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n",
});

function binding(overrides: Partial<IntegrationSummary> = {}): IntegrationSummary {
  return {
    id: "bind-1",
    connectionId: "conn-1",
    projectId: "proj-1",
    provider: "google",
    environment: "prod",
    active: true,
    config: { clientEmail: "forge@forge-sheets-1.iam.gserviceaccount.com" },
    lastHealthStatus: "ok",
    ...overrides,
  } as IntegrationSummary;
}

beforeEach(() => {
  vi.clearAllMocks();
  listItems.mockReturnValue([]);
  listIsError.mockReturnValue(false);
});

describe("a failed read is not an absent connection", () => {
  it("shows the failure and a retry, never the connect form", () => {
    listIsError.mockReturnValue(true);
    render(<GoogleSection projectId="proj-1" />);
    expect(screen.queryByRole("button", { name: /connect account/i })).toBeNull();
    expect(screen.getByText(/whether a Google account is already connected is unknown/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(listRefetch).toHaveBeenCalled();
  });
});

describe("connecting an account", () => {
  it("will not submit until the pasted body is a service-account key file", () => {
    render(<GoogleSection projectId="proj-1" />);
    const button = screen.getByRole("button", { name: /connect account/i });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/"type":"service_account"/), {
      target: { value: "{}" },
    });
    expect(button).toBeDisabled();
    expect(screen.getByText(/not a service-account key file yet/i)).toBeInTheDocument();
  });

  it("a document carrying client_email but no key is still refused", () => {
    render(<GoogleSection projectId="proj-1" />);
    fireEvent.change(screen.getByPlaceholderText(/"type":"service_account"/), {
      target: { value: JSON.stringify({ client_email: "x@example.com" }) },
    });
    expect(screen.getByRole("button", { name: /connect account/i })).toBeDisabled();
    expect(screen.getByText(/not a service-account key file yet/i)).toBeInTheDocument();
  });

  it("an authorized_user credential is refused too", () => {
    render(<GoogleSection projectId="proj-1" />);
    fireEvent.change(screen.getByPlaceholderText(/"type":"service_account"/), {
      target: {
        value: JSON.stringify({
          type: "authorized_user",
          client_email: "x@example.com",
          private_key: "-----BEGIN PRIVATE KEY-----",
        }),
      },
    });
    expect(screen.getByRole("button", { name: /connect account/i })).toBeDisabled();
  });

  it("sends the key file as the secret and the sheet as config", async () => {
    render(<GoogleSection projectId="proj-1" />);
    fireEvent.change(screen.getByPlaceholderText(/"type":"service_account"/), {
      target: { value: KEY_FILE },
    });
    fireEvent.change(screen.getAllByPlaceholderText("1AbC…xYz")[0] as HTMLElement, {
      target: { value: "1SheetId" },
    });
    fireEvent.click(screen.getByRole("button", { name: /connect account/i }));
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        config: { defaultSpreadsheetId: "1SheetId" },
        secrets: { serviceAccountJson: KEY_FILE },
      }),
    );
  });

  it("names the account to share the sheet with, read out of the pasted key", () => {
    render(<GoogleSection projectId="proj-1" />);
    fireEvent.change(screen.getByPlaceholderText(/"type":"service_account"/), {
      target: { value: KEY_FILE },
    });
    expect(
      screen.getByText("forge@forge-sheets-1.iam.gserviceaccount.com"),
    ).toBeInTheDocument();
  });
});

describe("an existing binding", () => {
  it("saves the default spreadsheet as config on the binding", async () => {
    listItems.mockReturnValue([binding({ config: { defaultSpreadsheetId: "1Old" } })]);
    render(<GoogleSection projectId="proj-1" />);
    fireEvent.change(screen.getByPlaceholderText("1AbC…xYz"), {
      target: { value: "1New" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMutate).toHaveBeenCalledWith({
      id: "bind-1",
      body: { config: { defaultSpreadsheetId: "1New" } },
    });
  });

  it("tells a rejected key apart from an unshared sheet", () => {
    listItems.mockReturnValue([binding({ lastHealthStatus: "needs_reauth" })]);
    const { unmount } = render(<GoogleSection projectId="proj-1" />);
    expect(screen.getByText(/key rejected by google/i)).toBeInTheDocument();
    unmount();

    listItems.mockReturnValue([binding({ lastHealthStatus: "needs_scope" })]);
    render(<GoogleSection projectId="proj-1" />);
    expect(screen.getByText(/not shared with the account/i)).toBeInTheDocument();
  });

  it("says a credential with no sheet to read is unproven, not connected", () => {
    listItems.mockReturnValue([binding({ lastHealthStatus: "degraded" })]);
    render(<GoogleSection projectId="proj-1" />);
    expect(screen.getByText(/no default sheet to read/i)).toBeInTheDocument();
  });

  it("does not render the key entry until Rotate is asked for", () => {
    listItems.mockReturnValue([binding()]);
    render(<GoogleSection projectId="proj-1" />);
    expect(screen.queryByPlaceholderText(/"type":"service_account"/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /rotate key/i }));
    expect(screen.getByPlaceholderText(/"type":"service_account"/)).toBeInTheDocument();
  });
});

describe("the connections directory (criterion 28)", () => {
  it("groups a Google connection under a Google heading", () => {
    const groups = groupConnectionsByApp([
      {
        id: "conn-1",
        provider: "google",
        displayName: null,
        ownerType: "org",
        active: true,
        lastHealthStatus: "ok",
        breakerOpenedAt: null,
        config: {},
        usage: { bindings: [] },
        // biome-ignore lint/suspicious/noExplicitAny: a directory row fixture
      } as any,
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.provider).toBe("google");
    expect(groups[0]?.label).toBe("Google Sheets");
  });

  it("derives its pill from the last health verdict, not from a guess", () => {
    const row = { active: true, breakerOpenedAt: null };
    expect(deriveConnectionStatus({ ...row, lastHealthStatus: "ok" })).toBe("connected");
    expect(deriveConnectionStatus({ ...row, lastHealthStatus: "needs_scope" })).toBe("needs_scope");
    expect(deriveConnectionStatus({ ...row, lastHealthStatus: "needs_reauth" })).toBe(
      "needs_reauth",
    );
    expect(deriveConnectionStatus({ ...row, lastHealthStatus: null })).toBe("unverified");
    expect(DIRECTORY_STATUS_META.needs_scope.label).not.toBe(
      DIRECTORY_STATUS_META.needs_reauth.label,
    );
  });

  it("names the permission rather than an OAuth scope", () => {
    expect(DIRECTORY_STATUS_META.needs_scope.label).toBe("Permission needed");
    expect(DIRECTORY_STATUS_META.needs_scope.label).not.toMatch(/scope/i);
  });
});

describe("redacting a payload before it reaches the DOM (criterion 22)", () => {
  it("replaces a privateKey value", () => {
    const out = redactSensitive({ secrets: { privateKey: "-----BEGIN PRIVATE KEY-----" } });
    expect(JSON.stringify(out)).not.toContain("BEGIN PRIVATE KEY");
    expect(JSON.stringify(out)).toContain(REDACTED);
  });

  it("replaces the snake-case spelling and the whole key file too", () => {
    const out = redactSensitive({ private_key: "x", serviceAccountJson: "y" }) as Record<
      string,
      unknown
    >;
    expect(out.private_key).toBe(REDACTED);
    expect(out.serviceAccountJson).toBe(REDACTED);
  });

  it("leaves the account address alone — a card that cannot name it is useless", () => {
    const out = redactSensitive({
      clientEmail: "forge@forge-sheets-1.iam.gserviceaccount.com",
    }) as Record<string, unknown>;
    expect(out.clientEmail).toBe("forge@forge-sheets-1.iam.gserviceaccount.com");
  });
});
