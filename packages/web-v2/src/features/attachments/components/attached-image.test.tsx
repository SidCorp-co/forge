// An attached image that fails to load says which file it could not load, in the box the image
// would have filled, or on a page as one line, its name and "couldn't load" (ISS-903); a new source
// tries again.

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

  it("reads the file's name in a box large enough for it, and only the short word on a thumbnail", () => {
    const { container, rerender } = render(<AttachedImage src="/files/a.png" alt="" name="checkout-step-2.png" large />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(screen.getByTestId("attached-image-failed")).toHaveTextContent("Couldn't load checkout-step-2.png");
    rerender(<AttachedImage src="/files/b.png" alt="" name="cart.png" />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(screen.getByTestId("attached-image-failed")).toHaveTextContent(/^Couldn't load$/);
  });

  it("draws a failed load on a page as one line, the file's name then couldn't load, never the image's box", () => {
    const { container } = render(<AttachedImage src="/files/a.png" alt="" name="anh.png" inline className="block max-h-90 w-auto" />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    const failed = screen.getByRole("img", { name: "Couldn't load anh.png" });
    expect(failed).toHaveTextContent(/^anh\.pngcouldn't load$/);
    expect(failed).toHaveAttribute("data-inline");
    expect(failed.className).not.toMatch(/max-h-90|min-h-40|min-w-60|flex-col/);
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
