// @vitest-environment jsdom
//
// The active org is the stored preference, and nothing stands in for it before it has been read:
// a stand-in replaced by the stored value reads as a person switching orgs, and switching away from
// an open project's org leaves the project for the console.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectListItem } from "@/features/projects/types";
import { useProjectOrgScopeSync } from "@/features/shell/use-project-org-scope-sync";
import { ToastProvider } from "@/providers/toast-provider";
import { useAttention } from "@/features/attention/hooks";
import { ActiveOrgProvider, useActiveOrg } from "./active-org";
import type { OrgListItem } from "./types";

const pushed: string[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (href: string) => pushed.push(href), replace: vi.fn(), prefetch: vi.fn() }),
}));

const org = (id: string, name: string): OrgListItem => ({
  id,
  slug: id,
  name,
  isPersonal: false,
  role: "owner",
  createdAt: "2026-10-01T00:00:00.000Z",
});
const SCRATCH = org("org-a", "Scratch org");
const QA = org("org-b", "QA org");

type Prefs = { theme: string; language: string; activeOrgId: string | null };
let preferences: { asked: boolean; answer: (p: Prefs) => void; promise: Promise<Prefs> };
function askable() {
  let answer: (p: Prefs) => void = () => {};
  const promise = new Promise<Prefs>((resolve) => {
    answer = resolve;
  });
  return { asked: false, answer, promise };
}

let orgsAnswer: () => Promise<OrgListItem[]> = async () => [SCRATCH, QA];
vi.mock("./hooks", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return { useOrgs: () => useQuery({ queryKey: ["orgs"], queryFn: () => orgsAnswer() }) };
});

const attentionAsked: Array<string | null | undefined> = [];
vi.mock("@/features/attention/api", () => ({
  attentionApi: {
    list: async (orgId?: string | null) => {
      attentionAsked.push(orgId);
      return {
        needsReview: [], awaitingInput: [], mentions: [], failedJobs: [], pendingSkillUpdates: [],
        unseenDrafts: [], unseenDraftsTotal: 0, projectTotals: {}, total: 0,
      };
    },
  },
}));
vi.mock("@/features/runners/hooks", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return { useDevices: () => useQuery({ queryKey: ["devices", "me"], queryFn: async () => [] }) };
});

vi.mock("@/features/settings/hooks", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    usePreferences: () =>
      useQuery({
        queryKey: ["settings", "preferences"],
        queryFn: () => {
          preferences.asked = true;
          return preferences.promise;
        },
      }),
  };
});

const updatePreferences = vi.fn(async (patch: { activeOrgId: string }) => ({
  theme: "system",
  language: "en",
  activeOrgId: patch.activeOrgId,
}));
vi.mock("@/features/settings/api", () => ({
  settingsApi: { updatePreferences: (patch: { activeOrgId: string }) => updatePreferences(patch) },
}));

const QA_PROJECT = { id: "p-qa", slug: "qa-project", orgId: QA.id } as ProjectListItem;

const seen: Array<string | null> = [];
let orgsRead = 0;
function OpenProject() {
  const { activeOrgId, orgs } = useActiveOrg();
  seen.push(activeOrgId);
  orgsRead = orgs.length;
  useProjectOrgScopeSync({ slug: QA_PROJECT.slug, activeProject: QA_PROJECT });
  return null;
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ActiveOrgProvider>
          <OpenProject />
        </ActiveOrgProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The orgs have answered and the preferences have been asked for and not answered: the window a stand-in would fill. */
async function orgsAnswered() {
  await waitFor(() => expect({ orgs: orgsRead, asked: preferences.asked }).toEqual({ orgs: 2, asked: true }));
  await act(async () => {});
}

async function answerPreferences(activeOrgId: string | null) {
  await act(async () => preferences.answer({ theme: "system", language: "en", activeOrgId }));
}

beforeEach(() => {
  orgsAnswer = async () => [SCRATCH, QA];
  attentionAsked.length = 0;
  pushed.length = 0;
  seen.length = 0;
  orgsRead = 0;
  preferences = askable();
  updatePreferences.mockClear();
});
afterEach(cleanup);

describe("the active org, while the stored preference is still being read", () => {
  it("stays a project's page when the stored org arrives after the orgs and is not the project's", async () => {
    mount();
    await orgsAnswered();
    await answerPreferences(SCRATCH.id);
    await waitFor(() => expect(seen).toContain(SCRATCH.id));
    // One reading of where it ends: still on the project, scoped to the project's own org.
    await waitFor(() => expect({ pushed, active: seen[seen.length - 1] }).toEqual({ pushed: [], active: QA.id }));
    // ISS-1229 r16, judge-41: the visit scoped the shared account on the server, so every other tab
    // and device switched with it. Viewing writes nothing; only the org switcher does.
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it("names no org until the stored preference has been read, and then names that one", async () => {
    mount();
    await orgsAnswered();
    expect(seen.filter((id) => id !== null)).toEqual([]);
    await answerPreferences(SCRATCH.id);
    await waitFor(() => expect(seen.find((id) => id !== null)).toBe(SCRATCH.id));
  });

  it("falls back to the first org where no org was ever stored", async () => {
    mount();
    await orgsAnswered();
    await answerPreferences(null);
    await waitFor(() => expect({ pushed, active: seen.find((id) => id !== null) }).toEqual({ pushed: [], active: QA.id }));
  });
});

describe("Attention, while the active org cannot be read", () => {
  let attention: ReturnType<typeof useAttention> | undefined;
  function Inbox() {
    attention = useAttention();
    return null;
  }

  it("reads nothing unscoped, says the read failed, and reads the stored org once a retry finds it", async () => {
    orgsAnswer = async () => {
      throw new Error("orgs unavailable");
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <ActiveOrgProvider>
            <Inbox />
          </ActiveOrgProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await answerPreferences(QA.id);
    await waitFor(() => expect(attention?.read).toBe("failed"));
    expect(attentionAsked).toEqual([]);
    expect(attention?.total).toBeUndefined();

    orgsAnswer = async () => [SCRATCH, QA];
    await act(async () => attention?.refetch());
    await waitFor(() => expect(attention?.read).toBe("read"));
    expect(attentionAsked).toEqual([QA.id]);
  });
});
