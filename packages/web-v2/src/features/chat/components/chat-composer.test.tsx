// @vitest-environment jsdom
//
// ISS-1146 — the frame, the staging, the refusal and the stop, mounted for
// real. Matchers are extended on vitest's OWN `expect` for the reason the
// slash suite beside this one states.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONVERSATION_ATTACHMENTS, SESSION_ATTACHMENTS } from "../attachments";
import { ChatComposer } from "./chat-composer";

expect.extend(matchers);
afterEach(cleanup);

function fileOf(name: string, type: string, size = 64): File {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

/** The hidden input the dialog and the drop both deliver through. */
function pick(files: File[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

function type(text: string) {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
}

describe("ChatComposer — the frame carries its own controls", () => {
  it("offers attach where the surface has a policy", () => {
    render(<ChatComposer onSend={vi.fn()} attachments={CONVERSATION_ATTACHMENTS} />);
    expect(screen.getByLabelText("Attach files")).toBeInTheDocument();
  });

  it("offers no attach at all where the surface has none, rather than a dead one", () => {
    render(<ChatComposer onSend={vi.fn()} />);
    expect(screen.queryByLabelText("Attach files")).not.toBeInTheDocument();
  });

  it("renders the surface's own control inside the frame", () => {
    render(
      <ChatComposer
        onSend={vi.fn()}
        footerControl={<button type="button">Assistant</button>}
      />,
    );
    const frame = screen.getByTestId("chat-composer");
    expect(frame).toContainElement(screen.getByRole("button", { name: "Assistant" }));
  });

  it("names the mode in the placeholder it was given", () => {
    render(<ChatComposer onSend={vi.fn()} placeholder="Message Agent — it has the repository…" />);
    expect(screen.getByLabelText("Message")).toHaveAttribute(
      "placeholder",
      "Message Agent — it has the repository…",
    );
  });

  it("leaves the box without a native resize handle at any height", () => {
    render(<ChatComposer onSend={vi.fn()} />);
    expect(screen.getByLabelText("Message").className).toContain("resize-none");
  });
});

describe("ChatComposer — what it stages", () => {
  it("stages a file of a type the surface takes", async () => {
    render(<ChatComposer onSend={vi.fn()} attachments={CONVERSATION_ATTACHMENTS} />);
    pick([fileOf("shot.png", "image/png")]);
    expect(await screen.findByText("shot.png")).toBeInTheDocument();
  });

  it("stages nothing for a type it does not take, and names the file and the rule", async () => {
    render(<ChatComposer onSend={vi.fn()} attachments={CONVERSATION_ATTACHMENTS} />);
    pick([fileOf("spec.pdf", "application/pdf")]);
    const refusal = await screen.findByText(/Couldn't attach spec\.pdf/);
    expect(refusal.textContent).toContain("application/pdf is not a type a conversation takes");
    expect(screen.queryByTestId("composer-chips")).not.toBeInTheDocument();
  });

  it("takes on the session surface what it refuses on the conversation one", async () => {
    render(<ChatComposer onSend={vi.fn()} attachments={SESSION_ATTACHMENTS} />);
    pick([fileOf("spec.pdf", "application/pdf")]);
    expect(await screen.findByText("spec.pdf")).toBeInTheDocument();
  });

  it("keeps the good file and refuses only the bad one", async () => {
    render(<ChatComposer onSend={vi.fn()} attachments={CONVERSATION_ATTACHMENTS} />);
    pick([fileOf("shot.png", "image/png"), fileOf("notes.txt", "text/plain")]);
    expect(await screen.findByText("shot.png")).toBeInTheDocument();
    expect(screen.getByText(/Couldn't attach notes\.txt/)).toBeInTheDocument();
  });
});

describe("ChatComposer — what it sends", () => {
  it("sends the staged file with the message", async () => {
    const onSend = vi.fn(async () => undefined);
    render(<ChatComposer onSend={onSend} attachments={CONVERSATION_ATTACHMENTS} />);
    pick([fileOf("shot.png", "image/png")]);
    await screen.findByText("shot.png");
    type("what is in this");
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const [text, files] = onSend.mock.calls[0] as unknown as [string, File[]];
    expect(text).toBe("what is in this");
    expect(files.map((f) => f.name)).toEqual(["shot.png"]);
  });

  it("leaves a removed file out of the message that is sent", async () => {
    const onSend = vi.fn(async () => undefined);
    render(<ChatComposer onSend={onSend} attachments={CONVERSATION_ATTACHMENTS} />);
    pick([fileOf("keep.png", "image/png"), fileOf("drop.png", "image/png")]);
    await screen.findByText("drop.png");
    fireEvent.click(screen.getByLabelText("Remove drop.png"));
    await waitFor(() => expect(screen.queryByText("drop.png")).not.toBeInTheDocument());
    type("only one");
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const [, files] = onSend.mock.calls[0] as unknown as [string, File[]];
    expect(files.map((f) => f.name)).toEqual(["keep.png"]);
  });

  it("sends a picture with no text at all", async () => {
    const onSend = vi.fn(async () => undefined);
    render(<ChatComposer onSend={onSend} attachments={CONVERSATION_ATTACHMENTS} />);
    pick([fileOf("shot.png", "image/png")]);
    await screen.findByText("shot.png");
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("", [expect.any(File)]));
  });

  it("refuses to send with neither text nor a file", () => {
    render(<ChatComposer onSend={vi.fn()} attachments={CONVERSATION_ATTACHMENTS} />);
    expect(screen.getByLabelText("Send message")).toBeDisabled();
  });
});

describe("ChatComposer — stopping what is running", () => {
  it("offers stop in the send button's place while a turn runs", () => {
    render(<ChatComposer onSend={vi.fn()} busy onStop={vi.fn()} />);
    expect(screen.getByLabelText("Stop answering")).toBeInTheDocument();
    expect(screen.queryByLabelText("Send message")).not.toBeInTheDocument();
  });

  it("offers no stop where the surface cannot end the turn", () => {
    render(<ChatComposer onSend={vi.fn()} busy />);
    expect(screen.queryByLabelText("Stop answering")).not.toBeInTheDocument();
  });

  it("offers the stop whenever the surface hands it one, busy here or not", () => {
    // The surface passes `onStop` only while there is a turn to end, and the
    // person watching an answer arrive is not always the one who asked for it.
    render(<ChatComposer onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByLabelText("Stop answering")).toBeInTheDocument();
  });

  it("ends the turn when it is pressed", () => {
    const onStop = vi.fn();
    render(<ChatComposer onSend={vi.fn()} busy onStop={onStop} />);
    fireEvent.click(screen.getByLabelText("Stop answering"));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
