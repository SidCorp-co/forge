// REQ-39 BC-11: how a project's preview starts is a project setting. The section writes the project
// document's `preview` and `fastLane` keys at the revision it read, leaves a key out where nothing is
// set (so the preview is read from the repository), and shows what core refused at the field it names.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { V1Read } from "@/features/project-config/types";
import { type Call, fakeCore } from "@/test/render";
import { PreviewSection } from "./preview-section";

const P = "11111111-1111-4111-8111-111111111111";
const doc = (extra: Record<string, unknown> = {}) => ({
  $schema: "https://forge.sidcorp.co/schemas/project-v1.json",
  version: 1,
  project: { id: P, slug: "hop", name: "Hop" },
  ...extra,
});

function core(read: V1Read, put?: (c: Call) => { status?: number; body: unknown }): Call[] {
  return fakeCore((c) => {
    if (c.method === "GET" && c.path === `/projects/${P}/config`) return { body: read };
    if (c.method === "PUT" && c.path === `/projects/${P}/config`)
      return put ? put(c) : { body: { declared: true, revision: 7, document: (c.body as { document: unknown }).document, created: false } };
    return undefined;
  });
}

function mount(canEdit = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PreviewSection projectId={P} slug="hop" canEdit={canEdit} />
    </QueryClientProvider>,
  );
}

const field = (name: string) => screen.findByRole(name.startsWith("Fixed") || name.startsWith("Close") ? "spinbutton" : "textbox", { name });
const save = () => fireEvent.click(within(screen.getByTestId("save-bar")).getByRole("button", { name: "Save changes" }));
const putOf = (calls: Call[]) => calls.find((c) => c.method === "PUT")?.body as { baseRevision: number; document: Record<string, unknown> } | undefined;

afterEach(() => vi.unstubAllGlobals());

describe("the preview setting", () => {
  it("reads an unset preview as filled from the repository, with every field empty", async () => {
    core({ declared: true, revision: 6, document: doc() });
    mount();
    const command = await field("Start command");
    expect(command).toHaveValue("");
    expect(command).toHaveAttribute("placeholder", "Read from package.json");
    expect(screen.queryByTestId("save-bar")).toBeNull();
  });

  it("writes the typed command and port under `preview`, at the revision read", async () => {
    const calls = core({ declared: true, revision: 6, document: doc() });
    mount();
    fireEvent.change(await field("Start command"), { target: { value: "pnpm run dev" } });
    fireEvent.change(await field("Fixed port"), { target: { value: "3100" } });
    save();
    await waitFor(() => expect(putOf(calls)).toBeDefined());
    expect(putOf(calls)).toMatchObject({ baseRevision: 6, document: { preview: { command: "pnpm run dev", port: 3100 } } });
  });

  it("removes the key when its last field is emptied, so it falls back to the repository", async () => {
    const calls = core({ declared: true, revision: 6, document: doc({ preview: { command: "pnpm run dev", port: 3100 } }) });
    mount();
    fireEvent.change(await field("Start command"), { target: { value: "" } });
    fireEvent.change(await field("Fixed port"), { target: { value: "" } });
    save();
    await waitFor(() => expect(putOf(calls)).toBeDefined());
    expect(putOf(calls)?.document).not.toHaveProperty("preview");
    expect(putOf(calls)?.document).toHaveProperty("project.slug", "hop");
  });

  it("shows core's refusal at the field it names, not in a toast", async () => {
    core({ declared: true, revision: 6, document: doc() }, () => ({
      status: 400,
      body: { error: { code: "PREVIEW_SETTINGS_INVALID", message: "invalid", refusals: [{ code: "PREVIEW_SETTINGS_INVALID", path: "/preview/port", detail: "preview.port is required when the command does not hold {port}" }] } },
    }));
    mount();
    fireEvent.change(await field("Start command"), { target: { value: "node server.js" } });
    save();
    const row = (await screen.findAllByText(/preview\.port is required when the command does not hold/))[0] as HTMLElement;
    expect(row).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Start command" })).toHaveValue("node server.js");
  });

  it("holds an undeclared project's fields off and says why", async () => {
    core({ declared: false } as V1Read);
    mount();
    expect(await field("Start command")).toBeDisabled();
    expect(screen.getByText(/no project document|undeclared|declared/i)).toBeInTheDocument();
  });

  it("is read-only for a reader who cannot edit, with no save bar", async () => {
    core({ declared: true, revision: 6, document: doc({ preview: { command: "pnpm run dev", port: 3100 } }) });
    mount(false);
    expect(await field("Start command")).toBeDisabled();
    expect(screen.queryByTestId("save-bar")).toBeNull();
  });
});

describe("the fast-lane declaration", () => {
  it("gives `paths` an empty list the moment another fast-lane key is set, since core requires it", async () => {
    const calls = core({ declared: true, revision: 6, document: doc() });
    mount();
    fireEvent.blur(await screen.findByRole("textbox", { name: "Deploy targets" }), { target: { value: "web" } });
    save();
    await waitFor(() => expect(putOf(calls)).toBeDefined());
    expect(putOf(calls)?.document.fastLane).toEqual({ paths: [], deployTargets: ["web"] });
  });

  it("writes comma lists as arrays, dropping blanks and repeats", async () => {
    const calls = core({ declared: true, revision: 6, document: doc() });
    mount();
    fireEvent.blur(await screen.findByRole("textbox", { name: "Web-only paths" }), { target: { value: "packages/web/src/**, , packages/web/public/**, packages/web/src/**" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "Deploy targets" }), { target: { value: "web" } });
    save();
    await waitFor(() => expect(putOf(calls)).toBeDefined());
    expect(putOf(calls)?.document.fastLane).toEqual({ paths: ["packages/web/src/**", "packages/web/public/**"], deployTargets: ["web"] });
  });

  it("removes the fast-lane key once every list is emptied", async () => {
    const calls = core({ declared: true, revision: 6, document: doc({ fastLane: { paths: ["a/**"], deployTargets: ["web"] } }) });
    mount();
    fireEvent.blur(await screen.findByRole("textbox", { name: "Web-only paths" }), { target: { value: "" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "Deploy targets" }), { target: { value: "" } });
    save();
    await waitFor(() => expect(putOf(calls)).toBeDefined());
    expect(putOf(calls)?.document).not.toHaveProperty("fastLane");
  });
});
