// An attached image that fails to load says which file it could not load, in the box the image
// would have filled, and a new source tries again.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AttachedImage } from "./attached-image";

describe("AttachedImage", () => {
  it("draws the image while it loads, and names the file in its box when the load fails", () => {
    const { container } = render(<AttachedImage src="/files/a.png" alt="" name="checkout-step-2.png" className="size-18 object-cover" />);
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("src", "/files/a.png");
    fireEvent.error(img as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    const failed = screen.getByRole("img", { name: "Couldn't load checkout-step-2.png" });
    expect(failed).toHaveClass("size-18");
    expect(failed).toHaveTextContent("Couldn't load");
  });

  it("tries a new source again after the last one failed", () => {
    const { container, rerender } = render(<AttachedImage src="/files/a.png" alt="first" name="a.png" />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(screen.getByTestId("attached-image-failed")).toBeInTheDocument();
    rerender(<AttachedImage src="/files/b.png" alt="second" name="b.png" />);
    expect(screen.queryByTestId("attached-image-failed")).toBeNull();
    expect(screen.getByRole("img", { name: "second" })).toHaveAttribute("src", "/files/b.png");
  });
});
