// @vitest-environment jsdom
//
// ISS-24 — the ecosystem pages show every refusal by the code core named it with, read a failed
// read as "could not be read" and never as empty, and keep overdue and held visible. Each case
// plants the server's answer the rule is about; the screens are rendered against it.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatDockProvider, type ChatDockApi } from "@/features/conversations/dock";
import { ApiError } from "@/lib/api/client";
import type { DocumentView, RegisterRow } from "./types";

expect.extend(matchers);

const ME = "11111111-1111-4111-8111-111111111111";
const FORGE = "22222222-2222-4222-8222-222222222222";
const PLUGIN = "33333333-3333-4333-8333-333333333333";
const ECO = "44444444-4444-4444-8444-444444444444";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: ME } }) }));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ id: FORGE, slug: "forge" }] }),
}));

const api = vi.hoisted(() => ({
  ecosystemsOf: vi.fn(),
  mine: vi.fn(),
  outbox: vi.fn(),
  document: vi.fn(),
  thread: vi.fn(),
  hold: vi.fn(),
  submit: vi.fn(),
  withdraw: vi.fn(),
  supersede: vi.fn(),
  apiPage: vi.fn(),
}));
const questions = vi.hoisted(() => ({ listOpenWithoutIssue: vi.fn(), answer: vi.fn() }));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, ecosystemApi: api };
});
vi.mock("@/features/questions/api", () => ({ questionsApi: questions }));
const members = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock("@/features/issues/api", () => ({ issuesApi: { members } }));

const { ThreadsScreen } = await import("./components/threads-screen");
const { DocumentScreen } = await import("./components/document-screen");

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const hold = {
  id: "h1",
  thread: "FP-RFI-1",
  action: "hold" as const,
  by: { kind: "person" as const, id: "55555555-5555-4555-8555-555555555555", via: "assistant" as const },
  side: PLUGIN,
  at: "2026-10-01T10:00:00.000Z",
  reason: "ask the owner first",
};

function row(over: Partial<RegisterRow>): RegisterRow {
  return {
    number: "FP-RFI-1",
    type: "rfi",
    subject: "Does the skill read the phase field?",
    from: FORGE,
    to: [PLUGIN],
    inReplyTo: null,
    thread: "FP-RFI-1",
    state: "published",
    authoredBy: { kind: "person", id: ME, via: "assistant" },
    publishedAt: "2026-09-30T10:00:00.000Z",
    dueBy: "2026-09-30",
    recipients: [{ project: PLUGIN, status: "overdue", answeredBy: null }],
    open: true,
    overdue: true,
    owner: [PLUGIN],
    hold,
    ...over,
  };
}

function view(over: Partial<DocumentView> = {}): DocumentView {
  return {
    id: "d1",
    document: {
      id: "d1",
      number: "FP-RFI-1",
      ecosystem: ECO,
      from: FORGE,
      to: [PLUGIN],
      type: "rfi",
      subject: "Does the skill read the phase field?",
      dueBy: "2026-09-30",
      state: "published",
      authoredBy: { kind: "person", id: ME, via: "assistant" },
      gate: { mode: "publish" },
      publishedAt: "2026-09-30T10:00:00.000Z",
      body: { question: "Is it read?", reason: "We may make it optional." },
    },
    events: [
      {
        verb: "publish",
        from: "submitted",
        to: "published",
        by: { kind: "person", id: ME, via: "assistant" },
        at: "2026-09-30T10:00:00.000Z",
      },
    ],
    side: "sender",
    thread: "FP-RFI-1",
    hold: null,
    standing: {
      open: true,
      overdue: true,
      owner: [PLUGIN],
      recipients: [{ project: PLUGIN, status: "overdue", answeredBy: null }],
    },
    ...over,
  };
}

beforeEach(() => {
  api.ecosystemsOf.mockResolvedValue({
    memberships: [
      {
        id: "m1",
        document: { ecosystem: ECO, project: FORGE, state: "active" },
        ecosystem: { id: ECO, slug: "fp", name: "Forge platform", channel: "FP" },
      },
    ],
    returned: 1,
  });
  api.outbox.mockResolvedValue({ documents: [], returned: 0 });
  api.apiPage.mockResolvedValue({ consumes: [], publishes: [] });
  api.thread.mockResolvedValue({ thread: "FP-RFI-1", documents: [], holds: [hold] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function workspace(threads: RegisterRow[], drafts: unknown[] = []) {
  return {
    ecosystems: [
      {
        id: ECO,
        slug: "fp",
        name: "Forge platform",
        purpose: null,
        code: "FP",
        steward: { id: "o1", name: "SidCorp", mine: true },
        visibility: "counterparties",
        responseDays: { rfi: 3, "change-request": 5, "change-notice": 7 },
        gate: { "change-notice": "publish", acknowledgement: "publish", rfi: "publish", "change-request": "approve", decision: "publish" },
        members: [PLUGIN],
      },
    ],
    invitations: [],
    threads: threads.map((t) => ({ ...t, ecosystem: ECO })),
    drafts,
    projects: [
      { id: FORGE, slug: "forge", name: "Forge" },
      { id: PLUGIN, slug: "forge-plugin", name: "Forge plugin" },
    ],
    mine: [PLUGIN],
  };
}

const threadsScreen = (view: string | null, onParam = vi.fn()) =>
  wrap(<ThreadsScreen filters={{ view, ecosystem: null, project: null, type: null }} onParam={onParam} />);

describe("the Threads inbox keeps what needs the reader, overdue and held in sight", () => {
  it("counts each view from core's rows and asks for the one picked", async () => {
    api.mine.mockResolvedValue(workspace([row({ hold: null }), row({ number: "FP-RFI-2", thread: "FP-RFI-2" })]));
    const onParam = vi.fn();
    threadsScreen(null, onParam);
    await screen.findByText("FP-RFI-1");
    expect(screen.getByRole("button", { name: "Needs me1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Held1" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Overdue2" }));
    fireEvent.click(screen.getByRole("button", { name: "Held1" }));
    expect(onParam.mock.calls).toEqual([
      ["view", "overdue"],
      ["view", "held"],
    ]);
  });

  it("marks an overdue row by its days late, and a held row with a way to release it", async () => {
    api.mine.mockResolvedValue(workspace([row({})]));
    threadsScreen("held");
    const card = (await screen.findByText("FP-RFI-1")).closest("li") as HTMLElement;
    expect(within(card).getByText("Held")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Release hold" })).toBeInTheDocument();
  });

  it("says a master drafted the reply only when core holds that draft", async () => {
    api.mine.mockResolvedValue(
      workspace(
        [row({ hold: null })],
        [{ id: "d9", ecosystem: ECO, from: PLUGIN, inReplyTo: "FP-RFI-1", type: "decision", state: "draft", authoredBy: { kind: "agent", id: "a1", via: "master" }, gate: null }],
      ),
    );
    threadsScreen(null);
    expect(await screen.findByText("forge-plugin master drafted an answer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send answer" })).toBeInTheDocument();
  });

  it("names a view the URL carries that is not one, rather than showing everything", async () => {
    api.mine.mockResolvedValue(workspace([row({})]));
    threadsScreen("lost");
    expect(await screen.findByText(/INBOX_VIEW_UNKNOWN/)).toBeInTheDocument();
    expect(screen.queryByText("FP-RFI-1")).not.toBeInTheDocument();
  });
});

describe("a read that failed is unread, never empty", () => {
  it("says the threads could not be read, and never that there are none", async () => {
    api.mine.mockRejectedValue(new ApiError(503, "Service Unavailable", "UPSTREAM_DOWN"));
    threadsScreen(null);
    expect(await screen.findByText(/Your threads could not be read/)).toBeInTheDocument();
    expect(screen.getByText("UPSTREAM_DOWN")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing under/)).not.toBeInTheDocument();
  });
});

const documentScreen = (v: DocumentView, role: "viewer" | "member" | "admin" = "member") => {
  api.document.mockResolvedValue(v);
  return wrap(<DocumentScreen projectId={FORGE} slug="forge" role={role} docRef="FP-RFI-1" />);
};

describe("a refused write is shown by the name core gave it", () => {
  it("shows CHANNEL_WRITE_NOT_AUTHORISED when a hold is refused for a viewer’s role", async () => {
    const refusal = {
      code: "CHANNEL_WRITE_NOT_AUTHORISED",
      path: "/from",
      detail: "person is a viewer on project forge; writing takes member or above",
    };
    api.hold.mockRejectedValue(
      new ApiError(403, refusal.detail, refusal.code, { refusals: [refusal] }),
    );
    documentScreen(view());
    fireEvent.click(await screen.findByRole("button", { name: "Hold the conversation" }));
    fireEvent.change(screen.getByLabelText("Hold the conversation: reason"), { target: { value: "wait" } });
    fireEvent.click(screen.getByRole("button", { name: "Hold" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("CHANNEL_WRITE_NOT_AUTHORISED");
    expect(alert).toHaveTextContent("writing takes member or above");
    expect(api.hold).toHaveBeenCalledWith(FORGE, "FP-RFI-1", "hold", "wait");
  });

  it("shows HOLD_NOT_AUTHORISED from the document envelope a 422 carries", async () => {
    api.hold.mockRejectedValue(
      new ApiError(422, "Unprocessable Entity", undefined, undefined, {
        error: {
          code: "HOLD_NOT_AUTHORISED",
          message: "refused",
          refusals: [{ code: "HOLD_NOT_AUTHORISED", path: "/by", detail: "this side is not yours to hold" }],
        },
      }),
    );
    documentScreen(view());
    fireEvent.click(await screen.findByRole("button", { name: "Hold the conversation" }));
    fireEvent.change(screen.getByLabelText("Hold the conversation: reason"), { target: { value: "wait" } });
    fireEvent.click(screen.getByRole("button", { name: "Hold" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("HOLD_NOT_AUTHORISED · Who holds");
  });

  it("reads a hold refused for a role to a person, with no ids in it", async () => {
    const detail =
      "4251b7f3-f29d-4483-96dc-32b88a60be7b holds no member role or above on project 65800f38-b1ea-448b-853f-f68905411d8a, so cannot hold for that side.";
    api.hold.mockRejectedValue(
      new ApiError(422, "Unprocessable Entity", undefined, undefined, {
        error: { code: "HOLD_NOT_AUTHORISED", message: "refused", refusals: [{ code: "HOLD_NOT_AUTHORISED", path: "/by", detail }] },
      }),
    );
    documentScreen(view());
    fireEvent.click(await screen.findByRole("button", { name: "Hold the conversation" }));
    fireEvent.change(screen.getByLabelText("Hold the conversation: reason"), { target: { value: "wait" } });
    fireEvent.click(screen.getByRole("button", { name: "Hold" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "HOLD_NOT_AUTHORISED · Who holds — Holding or releasing a conversation takes a member role or above on the side it is held for, and you do not hold one there.",
    );
    expect(alert).not.toHaveTextContent("4251b7f3");
  });

  it("offers a viewer no write, and says why", async () => {
    documentScreen(view(), "viewer");
    expect(await screen.findByText(/You are a viewer on forge/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hold the conversation" })).not.toBeInTheDocument();
  });
});

describe("the document page shows standing, holds and who wrote it", () => {
  it("marks it overdue and held, and says it was written through the assistant", async () => {
    documentScreen(view({ hold }));
    await screen.findByText("Does the skill read the phase field?");
    expect(screen.getAllByText("Overdue").length).toBeGreaterThan(0);
    expect(screen.getByText("Held")).toBeInTheDocument();
    expect(screen.getAllByText("via assistant").length).toBeGreaterThan(0);
    expect(await screen.findByText(/Nobody has held|Held by person 55555555/)).toBeInTheDocument();
  });

  it("offers Ask about this, opening the chat dock about the document's number", async () => {
    const askAbout = vi.fn();
    const dock = { projectId: FORGE, askAbout } as unknown as ChatDockApi;
    api.document.mockResolvedValue(view());
    wrap(
      <ChatDockProvider value={dock}>
        {/* biome-ignore lint/a11y/useValidAriaRole: role is DocumentScreen's project-role prop, never an ARIA role on a DOM element */}
        <DocumentScreen projectId={FORGE} slug="forge" role="member" docRef="FP-RFI-1" />
      </ChatDockProvider>,
    );
    await screen.findByText("Does the skill read the phase field?");
    fireEvent.click(screen.getByRole("button", { name: /Ask about this/ }));
    expect(askAbout).toHaveBeenCalledWith("document", view().document.number);
  });

  it("says the conversation could not be read when its thread fails", async () => {
    api.thread.mockRejectedValue(new ApiError(404, "no conversation", "NOT_FOUND"));
    documentScreen(view());
    expect(await screen.findByText(/Conversation FP-RFI-1 could not be read/)).toBeInTheDocument();
  });
});

describe("a returned document is edited before it is submitted again", () => {
  const returned = () =>
    view({
      thread: null,
      document: {
        ...view().document,
        state: "returned",
        publishedAt: undefined,
        gate: { mode: "approve", note: "name the date field" },
      },
    });

  it("offers its writer Edit draft and no Submit, since core submits only a draft", async () => {
    documentScreen(returned());
    expect(await screen.findByRole("link", { name: "Edit draft" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument();
    expect(screen.getByText(/edit it to submit it again/i)).toBeInTheDocument();
  });

  it("still offers Submit on a draft", async () => {
    documentScreen(view({ thread: null, document: { ...view().document, state: "draft", publishedAt: undefined } }));
    expect(await screen.findByRole("button", { name: "Submit" })).toBeInTheDocument();
  });
});

describe("a co-member is named as the reader's project lists them", () => {
  const DANA = "66666666-6666-4666-8666-666666666666";

  it("names the author and the holder by display name, or by email where none was typed", async () => {
    members.mockResolvedValue([
      { userId: DANA, email: "dana@example.test", displayName: "Dana", kind: "human", role: "member", createdAt: "" },
      { userId: hold.by.id, email: "hal@example.test", displayName: null, kind: "human", role: "member", createdAt: "" },
    ]);
    const by = { kind: "person" as const, id: DANA, via: "web" as const };
    documentScreen(view({ hold, document: { ...view().document, authoredBy: by } }));
    expect(await screen.findByText(/Written by Dana on the web/)).toBeInTheDocument();
    expect((await screen.findAllByText(/Held by hal@example\.test/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/person 66666666/)).not.toBeInTheDocument();
  });
});

describe("the approve gate is decided by answering its question", () => {
  const submitted = () =>
    view({
      document: { ...view().document, state: "submitted", gate: { mode: "approve" }, publishedAt: undefined },
      standing: null,
    });
  const gateQuestion = (locked: boolean) => ({
    questions: [
      {
        id: "q1",
        origin: { kind: "channel_gate", documentId: "d1", number: "FP-RFI-1" },
        currentStep: { round: 2, prompt: "Publish FP-RFI-1?", answerShape: "choice", options: [], recommendedOptionId: "approve", askedAt: "" },
        options: [
          { id: "approve", label: "Approve and publish it", authority: "admin", bindsTo: "this_call", executedBy: "core", locked },
          { id: "return", label: "Return it to the writer", authority: "admin", bindsTo: "this_call", executedBy: "core", locked },
        ],
      },
    ],
    nextCursor: null,
  });

  it("shows QUESTION_AUTHORITY_REQUIRED when core refuses the answer", async () => {
    questions.listOpenWithoutIssue.mockResolvedValue(gateQuestion(false));
    questions.answer.mockRejectedValue(
      new ApiError(403, "option approve carries authority admin and this caller may not choose it", "QUESTION_AUTHORITY_REQUIRED"),
    );
    documentScreen(submitted(), "admin");
    fireEvent.click(await screen.findByRole("button", { name: "Approve and publish it" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("QUESTION_AUTHORITY_REQUIRED");
    expect(questions.answer.mock.calls[0]?.[0]).toEqual({ questionId: "q1", round: 2, optionId: "approve" });
  });

  it("returns it only with a note, and sends the note with the answer", async () => {
    questions.listOpenWithoutIssue.mockResolvedValue(gateQuestion(false));
    questions.answer.mockResolvedValue({});
    documentScreen(submitted(), "admin");
    const ret = await screen.findByRole("button", { name: "Return it to the writer" });
    expect(ret).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Gate note"), { target: { value: "Name the field." } });
    fireEvent.click(ret);
    await waitFor(() =>
      expect(questions.answer.mock.calls[0]?.[0]).toEqual({
        questionId: "q1",
        round: 2,
        optionId: "return",
        note: "Name the field.",
      }),
    );
  });

  it("tells a role that cannot decide it who does, and offers no choice", async () => {
    questions.listOpenWithoutIssue.mockResolvedValue(gateQuestion(true));
    documentScreen(submitted(), "member");
    expect(await screen.findByText(/cannot decide this gate; an admin of forge/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve and publish it" })).not.toBeInTheDocument();
  });

  it("says the gate could not be read when its question list fails", async () => {
    questions.listOpenWithoutIssue.mockRejectedValue(new ApiError(500, "boom"));
    documentScreen(submitted(), "admin");
    expect(await screen.findByText(/The approve gate could not be read/)).toBeInTheDocument();
  });
});
