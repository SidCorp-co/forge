// @vitest-environment jsdom
//
// What a page can rely on from its one form owner: the draft is dirty only while it differs by
// value from what was read; a re-read keeps the edits held in two places and takes the stored value
// everywhere else; `takeStored` replaces only the paths it is given and says which; and a draft the
// schema refuses sends nothing.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LeaveGuardProvider } from "./leave-guard";
import { type SettingsForm, useSettingsForm } from "./settings-form-model";

expect.extend(matchers);
afterEach(cleanup);

interface Doc {
  name: string;
  limits: { cpu: string; memory: string };
  tags: string[];
}

const SCHEMA = z.object({
  name: z.string().min(1, "Name is required."),
  limits: z.object({ cpu: z.string(), memory: z.string() }),
  tags: z.array(z.string()),
});

const START: Doc = { name: "forge", limits: { cpu: "2", memory: "4g" }, tags: ["a"] };

let latest: SettingsForm<Doc>;
let setRead: (next: Doc) => void;
const write = vi.fn(async (_draft: Doc) => undefined);

function Harness() {
  const [read, set] = useState<Doc>(START);
  setRead = set;
  const form = useSettingsForm<Doc>({ read, schema: SCHEMA });
  latest = form;
  return (
    <div>
      <input
        aria-label="name"
        value={form.draft.name}
        onChange={(e) => form.setDraft((d) => ({ ...d, name: e.target.value }))}
      />
      <input
        aria-label="cpu"
        value={form.draft.limits.cpu}
        onChange={(e) =>
          form.setDraft((d) => ({ ...d, limits: { ...d.limits, cpu: e.target.value } }))
        }
      />
      <input
        aria-label="memory"
        value={form.draft.limits.memory}
        onChange={(e) =>
          form.setDraft((d) => ({ ...d, limits: { ...d.limits, memory: e.target.value } }))
        }
      />
      <p data-testid="dirty">{String(form.dirty)}</p>
      <p data-testid="error">{form.errorAt("name") ?? ""}</p>
    </div>
  );
}

function mount() {
  return render(
    <LeaveGuardProvider>
      <Harness />
    </LeaveGuardProvider>,
  );
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const reread = (next: Doc) => act(() => setRead(next));

describe("dirty", () => {
  it("is false until a value differs from what was read", () => {
    mount();
    expect(screen.getByTestId("dirty")).toHaveTextContent("false");
    type("name", "forge-2");
    expect(screen.getByTestId("dirty")).toHaveTextContent("true");
  });

  it("is false again once the edit is put back", () => {
    mount();
    type("name", "forge-2");
    type("name", "forge");
    expect(screen.getByTestId("dirty")).toHaveTextContent("false");
  });
});

describe("a re-read", () => {
  it("keeps edits held in two places and takes the stored value at every path left alone", async () => {
    mount();
    type("name", "mine");
    type("cpu", "8");

    reread({ ...START, limits: { cpu: "2", memory: "16g" } });

    await waitFor(() => expect(field("memory").value).toBe("16g"));
    expect(field("name").value).toBe("mine");
    expect(field("cpu").value).toBe("8");
    expect(screen.getByTestId("dirty")).toHaveTextContent("true");
  });

  it("is not a re-read when the same document comes back as a new object", async () => {
    mount();
    type("name", "mine");
    reread({ name: "forge", limits: { memory: "4g", cpu: "2" }, tags: ["a"] });
    await act(async () => undefined);
    expect(field("name").value).toBe("mine");
    expect(latest.replaced).toEqual([]);
  });

  it("settles to clean once what the person typed is what is stored", async () => {
    mount();
    type("name", "mine");
    reread({ ...START, name: "mine" });
    await waitFor(() => expect(screen.getByTestId("dirty")).toHaveTextContent("false"));
  });
});

describe("takeStored", () => {
  it("replaces the edit on the path it is given, says so, and keeps every other edit", async () => {
    mount();
    type("name", "mine");
    type("cpu", "8");

    act(() => latest.takeStored(["limits.cpu"]));
    reread({ ...START, limits: { cpu: "4", memory: "4g" } });

    await waitFor(() => expect(field("cpu").value).toBe("4"));
    expect(field("name").value).toBe("mine");
    expect(latest.replaced).toEqual([{ path: "limits.cpu", typed: "8", stored: "4" }]);
  });

  it("is forgotten once the person types again", async () => {
    mount();
    type("cpu", "8");
    act(() => latest.takeStored(["limits.cpu"]));
    type("name", "mine");
    reread({ ...START, limits: { cpu: "4", memory: "4g" } });
    await waitFor(() => expect(screen.getByTestId("dirty")).toHaveTextContent("true"));
    expect(field("cpu").value).toBe("8");
    expect(latest.replaced).toEqual([]);
  });
});

describe("save", () => {
  it("runs the write with the draft the person holds", async () => {
    write.mockClear();
    mount();
    type("name", "mine");
    let ran = false;
    await act(async () => {
      ran = await latest.save(write);
    });
    expect(ran).toBe(true);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ name: "mine" }));
  });

  it("names what is wrong beside the field and sends nothing", async () => {
    write.mockClear();
    mount();
    type("name", "");
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("Name is required."));
    let ran = true;
    await act(async () => {
      ran = await latest.save(write);
    });
    expect(ran).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("throws what the write throws, leaving the draft as it was", async () => {
    mount();
    type("name", "mine");
    await expect(
      act(async () => {
        await latest.save(() => {
          throw new Error("refused");
        });
      }),
    ).rejects.toThrow("refused");
    expect(field("name").value).toBe("mine");
  });
});

describe("discard", () => {
  it("puts the draft back to what was read", async () => {
    mount();
    type("name", "mine");
    act(() => latest.discard());
    await waitFor(() => expect(field("name").value).toBe("forge"));
    expect(screen.getByTestId("dirty")).toHaveTextContent("false");
  });
});

describe("without a guard above it", () => {
  it("is refused by name, since a page holding edits could not ask before it was left", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Harness />)).toThrow(/LeaveGuardProvider/);
    quiet.mockRestore();
  });
});
