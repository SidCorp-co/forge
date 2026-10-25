// REQ-66 BC-1, BC-3, BC-7: the shell's Feedback entry, on a project's page, files one sentence and the
// page's screenshot into that project as the signed-in person; a repeat says it joined the open item;
// the agent's kind is asked of the reporter only where the agent could not read it; and a project that
// redacts asks the reporter to say nothing personal shows before an agent may see the screenshot.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentProjectProvider, type ProjectListItem } from "@/features/projects";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { FeedbackButton } from "./report-dialog";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());
vi.mock("../capture", () => ({
  capturePage: () => Promise.resolve(new Blob(["shot"], { type: "image/jpeg" })),
  base64Of: () => Promise.resolve("c2hvdA=="),
}));

beforeEach(() => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:shot", revokeObjectURL: () => {} }));
});
afterEach(() => vi.unstubAllGlobals());

const HOP = { id: "p-hop", slug: "hop", name: "HOP" } as ProjectListItem;
const filedAs = (key: string, created: boolean) => ({
  created,
  filledBy: "agent",
  screenshot: { state: "kept" },
  feedback: { key, title: "The board scrolls by itself" },
});

function served(o: { report: (c: Call) => { status?: number; body: unknown }; level?: string }) {
  return fakeCore((c) => {
    if (c.method === "POST" && c.path === "/projects/p-hop/feedback/report") return o.report(c);
    if (c.method === "GET" && c.path === "/projects/p-hop/config") {
      return { body: o.level ? { declared: true, revision: 1, document: { sensitiveData: o.level } } : { declared: false, revision: null, document: null } };
    }
    return undefined;
  });
}

async function openOn(path: string) {
  window.history.replaceState(null, "", path);
  const user = userEvent.setup();
  renderWithQuery(
    <CurrentProjectProvider project={HOP}>
      <FeedbackButton clientVersion="web 0.4.0-dev.320" />
    </CurrentProjectProvider>,
  );
  await user.click(screen.getByTestId("feedback-open"));
  await screen.findByTestId("report-form");
  return user;
}

describe("Feedback from a project's page", () => {
  it("files the sentence and the page's screenshot into the project, as the person, about the page", async () => {
    const calls = served({ report: () => ({ status: 201, body: filedAs("FB-12", true) }) });
    const user = await openOn("/projects/hop/board?card=4");
    expect(screen.getByTestId("report-screenshot")).toBeTruthy();
    await user.type(screen.getByLabelText(/^What happened\?/), "The board scrolls by itself");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("FB-12 filed.");
    const [post] = calls.filter((c) => c.method === "POST");
    expect(post?.body).toEqual({
      said: "The board scrolls by itself",
      whereSeen: "/projects/hop/board?card=4",
      screenshot: { name: "screenshot.jpg", mime: "image/jpeg", contentBase64: "c2hvdA==", redacted: false },
    });
    expect(screen.getByRole("link", { name: "Open FB-12" }).getAttribute("href")).toBe("/projects/hop/feedback/FB-12");
  });

  it("says a repeat joined the open item rather than filing another", async () => {
    served({ report: () => ({ body: filedAs("FB-7", false) }) });
    const user = await openOn("/projects/hop/board");
    await user.type(screen.getByLabelText(/^What happened\?/), "The board jumps to the top");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Added to FB-7, already reported.");
  });

  it("files without the screenshot once the reporter removes it", async () => {
    const calls = served({ report: () => ({ status: 201, body: { ...filedAs("FB-13", true), screenshot: { state: "none" } } }) });
    const user = await openOn("/projects/hop/board");
    await user.click(screen.getByTestId("report-shot-remove"));
    expect(screen.getByTestId("report-no-shot")).toBeTruthy();
    await user.type(screen.getByLabelText(/^What happened\?/), "Cards overlap on resize");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("FB-13 filed.");
    expect(calls.find((c) => c.method === "POST")?.body).not.toHaveProperty("screenshot");
  });

  it("asks what it is only where the agent could not read the sentence, and sends the kind picked", async () => {
    let tries = 0;
    const calls = served({
      report: () => {
        tries += 1;
        if (tries === 1) {
          return {
            status: 422,
            body: {
              error: {
                code: "FEEDBACK_KIND_NEEDED",
                message: "refused",
                refusals: [{ code: "FEEDBACK_KIND_NEEDED", path: "/kind", detail: "this project keeps feedback from models; send the report again with kind." }],
              },
            },
          };
        }
        return { status: 201, body: filedAs("FB-14", true) };
      },
    });
    const user = await openOn("/projects/hop/wards");
    expect(screen.queryByLabelText(/^What is it\?/)).toBeNull();
    await user.type(screen.getByLabelText(/^What happened\?/), "The ward list will not load");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const kind = await screen.findByLabelText(/^What is it\?/);
    await user.selectOptions(kind, "bug");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("FB-14 filed.");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.at(-1)?.body).toMatchObject({ kind: "bug" });
  });

  it("asks the reporter to say nothing personal shows on a project that redacts, and sends their word", async () => {
    const calls = served({ level: "redact", report: () => ({ status: 201, body: filedAs("FB-15", true) }) });
    const user = await openOn("/projects/hop/wards");
    const mark = await screen.findByRole("checkbox", { name: "Shows no personal data" });
    await user.type(screen.getByLabelText(/^What happened\?/), "The ward shows the wrong patient");
    await user.click(mark);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("FB-15 filed.");
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ screenshot: { redacted: true } }));
  });
});
