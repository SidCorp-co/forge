// The Approvals page's test kit: core answering its one read, a row found by its subject's key (carried
// as the title's tooltip, never on the face, ISS-903), the fold of what its count leaves out, and the
// address a test opens it at.

import { fireEvent, screen, within } from "@testing-library/react";
import { APPROVALS_PROJECT as P, APPROVALS_READ as READ } from "./approvals-read";
import { fakeCore } from "./render";

export const DECISIONS = `/projects/${P}/needs-you/decisions`;

/** Core answering the page's read, and taking every decision it is sent. */
export function core() {
  return fakeCore(({ path, method }) => {
    if (method === "GET" && path === DECISIONS) return { body: READ };
    if (method === "POST") return { body: { ok: true } };
    return undefined;
  });
}

/** The peek's button for one answer, by the id core gave it. */
export const answerIn = (peek: HTMLElement, id: string) => {
  const b = peek.querySelector<HTMLElement>(`[data-testid=approval-peek-answer][data-answer="${id}"]`);
  if (!b) throw new Error(`the peek draws no answer ${id}`);
  return b;
};

/** A row by its subject's key. */
export const rowOf = (key: string) => {
  const row = screen.getAllByTestId("approval-row").find((r) => r.dataset.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
};

/** The subjects' keys of the rows drawn now. */
export const keysDrawn = () => screen.queryAllByTestId("approval-row").map((r) => r.dataset.key);

/** Opens what the page's count leaves out, shut to its one line. */
export const openLeftOut = () => {
  const fold = screen.getByTestId("approvals-left-out");
  fireEvent.click(within(fold).getByRole("button", { name: /Not counted here/ }));
  return fold;
};

export const posts = <C extends { method: string }>(calls: C[]): C[] => calls.filter((c) => c.method === "POST");

/** Approvals opened narrowed to `search`, which is how a row past the first three is reached. */
export const openAt = (search = "") => window.history.replaceState(null, "", `/projects/hop/approvals${search}`);
