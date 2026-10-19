// @vitest-environment jsdom
//
// ISS-1421 r12 — judge-55 read Settings → Runners → Git access saying "Add this public key to your
// repo's deploy keys (write access) so runners can clone + push." right above a Test connection
// banner saying read access is all Forge needs. One card, one account of the key's access.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { KEY_ACCESS, WHY_KEY_ACCESS } from "@forge/contracts/deploy-key-words";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

/** What core's Test connection answers when the host refuses the key, worded from the same source. */
const REFUSED = `The git host refused this deploy key. Give it ${KEY_ACCESS} to the repository, ${WHY_KEY_ACCESS}.\nPermission denied (publickey).`;

const idle = { mutate: vi.fn(), isPending: false };
vi.mock("../hooks", async () => {
  const actual = await vi.importActual<typeof import("../hooks")>("../hooks");
  return {
    ...actual,
    useGitCredential: () => ({
      isLoading: false,
      isError: false,
      data: {
        configured: true,
        key: { name: "Forge x GitHub", fingerprint: "SHA256:abc", publicKey: "ssh-ed25519 AAAA forge" },
      },
    }),
    useSetGitCredential: () => idle,
    useDeleteGitCredential: () => idle,
    useTestGitCredential: () => ({ ...idle, data: { ok: false, message: REFUSED } }),
  };
});
vi.mock("@/features/resources/hooks", async () => ({
  ...(await vi.importActual<typeof import("@/features/resources/hooks")>("@/features/resources/hooks")),
  useOrgSshKeys: () => ({ data: [] }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

afterEach(cleanup);

describe("the Git access card", () => {
  it("asks for one access level, in the words Test connection uses", async () => {
    const { GitConfigCard } = await import("./project-runners-screen");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <GitConfigCard projectId="p1" orgId="o1" slug="p" canEdit />
      </QueryClientProvider>,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("Add this public key to your repository's deploy keys with read access");
    const asks = text.match(/[^.]*\baccess\b[^.]*\./g) ?? [];
    expect(asks.length).toBeGreaterThanOrEqual(2);
    for (const sentence of asks) {
      expect(sentence, sentence).toContain(KEY_ACCESS);
      expect(sentence, sentence).toContain(WHY_KEY_ACCESS);
      expect(sentence, sentence).not.toMatch(/\(write\s+access\)/);
    }
  });
});
