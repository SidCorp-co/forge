// @vitest-environment jsdom
//
// ISS-1229 r55, judge-170 on criterion 495: an HTML attachment's bytes were read around the client and asked again
// eight times inside the server's wait (the query's own retry, a return to the issue, a reload), and an image
// attachment went out again on each return. A core file is now read through the client: held while the wait runs,
// shown again by itself once it ends, and offered as no link that would ask around the hold.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BodyImage, BodyLink } from "@/design/patterns/body-link";
import { AttachmentList } from "@/features/issues/components/attachment-list";
import { HtmlAttachmentCard } from "@/features/issues/components/html-attachment-card";
import { createQueryClient } from "@/providers/query-provider";
import { forgetWaits } from "@/design/hooks/wait-announcer";
import { CoreFilesProvider, CoreImage } from "@/design/patterns/core-image";
import { forgetHeldReads } from "./client";
import { coreFiles } from "./core-file";

expect.extend(matchers);

const IMAGE = "/api/attachments/img1/download";
const PAGE = "/api/attachments/page1/download";
const refusedBody = { code: "RATE_LIMITED", message: "Too many requests in a short time." };

let sent: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  forgetHeldReads();
  forgetWaits();
  sent = [];
  const answered = new Map<string, number>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const address = String(input);
    sent.push(`${init?.method ?? "GET"} ${address}`);
    answered.set(address, (answered.get(address) ?? 0) + 1);
    return answered.get(address) === 1
      ? new Response(JSON.stringify(refusedBody), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "20" } })
      : new Response("<p>the page</p>", { status: 200, headers: { "Content-Type": "text/html" } });
  });
  let made = 0;
  URL.createObjectURL = vi.fn(() => `blob:forge/${++made}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function draw(part: ReactNode) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <CoreFilesProvider value={coreFiles}>{part}</CoreFilesProvider>
    </QueryClientProvider>,
  );
}

async function settle() {
  await act(async () => void (await vi.advanceTimersByTimeAsync(50)));
}

const imageRow = { id: "img1", name: "photo.png", mime: "image/png", size: 10, url: IMAGE };

describe("a core file the server refused with a wait (criterion 495, judge-170)", () => {
  it("draws an image attachment from memory, held while the wait runs and shown again by itself once it ends", async () => {
    const first = draw(<AttachmentList rows={[imageRow]} />);
    expect(await screen.findByText("photo.png not loaded.")).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent("Shown again in 20 seconds.");
    first.unmount();

    draw(<AttachmentList rows={[imageRow]} />);
    await settle();
    expect(sent).toEqual([`GET ${IMAGE}`]);

    await act(async () => void (await vi.advanceTimersByTimeAsync(21_000)));
    expect(await screen.findByRole("img", { name: "photo.png" })).toHaveAttribute("src", expect.stringMatching(/^blob:/));
    expect(sent).toEqual([`GET ${IMAGE}`, `GET ${IMAGE}`]);
  });

  // r55 whole-set review F2: an image away from the screen is not asked again when the wait ends, only once near it.
  it("asks again for a held image away from the screen only once it comes near", async () => {
    const client = createQueryClient();
    const shown = (key: string) => (
      <QueryClientProvider client={client}>
        <CoreFilesProvider value={coreFiles}>
          <AttachmentList key={key} rows={[imageRow]} />
        </CoreFilesProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(shown("near"));
    await screen.findByText("photo.png not loaded.");
    const watched: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(seen: (entries: { isIntersecting: boolean }[]) => void) {
        watched.push(seen);
      }
      observe() {}
      disconnect() {}
    });
    rerender(shown("away"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(21_000)));
    expect(sent).toEqual([`GET ${IMAGE}`]);
    await act(async () => watched.at(-1)?.([{ isIntersecting: true }]));
    await waitFor(() => expect(document.querySelector("img")).toHaveAttribute("src", expect.stringMatching(/^blob:/)));
    expect(sent).toEqual([`GET ${IMAGE}`, `GET ${IMAGE}`]);
  });

  it("offers no Open original in the lightbox while the image is held", async () => {
    draw(<AttachmentList rows={[imageRow]} />);
    await screen.findByText("photo.png not loaded.");
    fireEvent.click(screen.getByRole("button", { name: /photo\.png/ }));
    expect(screen.queryByRole("link", { name: "Open original" })).toBeNull();
    await settle();
    expect(sent).toEqual([`GET ${IMAGE}`]);
  });

  // r55 review F3: the image was loaded here, then another tab was refused it; the original opens from memory.
  it("opens the original of an image loaded here from its bytes, never from the core's address another tab holds", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(`${init?.method ?? "GET"} ${String(input)}`);
      return sent.length === 1
        ? new Response("png", { status: 200, headers: { "Content-Type": "image/png" } })
        : new Response(JSON.stringify(refusedBody), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "20" } });
    });
    draw(<AttachmentList rows={[imageRow]} />);
    await screen.findByRole("img", { name: "photo.png" });
    vi.resetModules();
    const otherTab = await import("./client");
    await expect(otherTab.apiFile(IMAGE)).rejects.toMatchObject({ status: 429 });
    fireEvent.click(screen.getByRole("button", { name: /photo\.png/ }));
    expect(await screen.findByRole("link", { name: "Open original" })).toHaveAttribute("href", expect.stringMatching(/^blob:/));
    expect(sent).toEqual([`GET ${IMAGE}`, `GET ${IMAGE}`]);
  });

  // r55 review F4: the wait is told once as it starts and once as it ends, however many places show the file.
  it("tells a screen reader a held image's wait once as it starts and once as it ends", async () => {
    draw(<AttachmentList rows={[imageRow]} />);
    await screen.findByText("photo.png not loaded.");
    fireEvent.click(screen.getByRole("button", { name: /photo\.png/ }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
    const said = () => [...document.querySelectorAll('[data-testid="wait-announcer"] p')].map((p) => p.textContent);
    expect(said()).toEqual(["The server asked for 20 seconds before photo.png is shown."]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
    expect(said()).toEqual(["photo.png is being loaded again."]);
  });

  it("holds an HTML attachment's bytes without the query's own retry, offers no link meanwhile, and shows it once the wait ends", async () => {
    const first = draw(<HtmlAttachmentCard name="page.html" url={PAGE} size={20} />);
    const held = await screen.findByTestId("html-attachment-held");
    expect(held).toHaveTextContent("preview failed");
    expect(screen.getByRole("timer")).toHaveTextContent("Shown again in 20 seconds.");
    expect(screen.queryByRole("link")).toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    first.unmount();
    draw(<HtmlAttachmentCard name="page.html" url={PAGE} size={20} />);
    await settle();
    expect(sent).toEqual([`GET ${PAGE}`]);

    await act(async () => void (await vi.advanceTimersByTimeAsync(16_000)));
    await screen.findByRole("button", { name: "Expand" });
    expect(document.querySelector("iframe")).toHaveAttribute("srcdoc", "<p>the page</p>");
    expect(sent).toEqual([`GET ${PAGE}`, `GET ${PAGE}`]);
  });

  it("reads a body image on the core through the client, and leaves another host's image to the browser", async () => {
    draw(
      <>
        <BodyImage src={IMAGE} alt="pasted" />
        <BodyImage src="https://elsewhere.example/a.png" alt="theirs" />
      </>,
    );
    expect(await screen.findByText("pasted not loaded.")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "theirs" })).toHaveAttribute("src", "https://elsewhere.example/a.png");
    expect(sent).toEqual([`GET ${IMAGE}`]);
  });

  // r55 review, pre-existing: an absolute address on the core's origin was classified another host's.
  it("reads a body image named by the core's absolute address through the client too", async () => {
    draw(<BodyImage src={`${window.location.origin}${IMAGE}`} alt="pasted" />);
    expect(await screen.findByText("pasted not loaded.")).toBeInTheDocument();
    expect(sent).toEqual([`GET ${IMAGE}`]);
  });

  it("keeps the section an absolute core link names", () => {
    draw(<BodyLink href={`${window.location.origin}/api/guides/a.md#results`}>the results</BodyLink>);
    expect(screen.getByRole("link", { name: "the results" })).toHaveAttribute("href", "/api/guides/a.md#results");
  });

  it("refuses by name an image drawn where the app handed the kit no way to read core files", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<CoreImage path={IMAGE} alt="pasted" />)).toThrow(
      `CoreImage drew ${IMAGE} outside a CoreFilesProvider, so nothing can read it through the client`,
    );
    expect(sent).toEqual([]);
  });
});
