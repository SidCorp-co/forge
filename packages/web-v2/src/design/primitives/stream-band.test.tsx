// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StreamBand } from "./stream-band";

afterEach(cleanup);

const weeks = [
  { key: "w1", inbound: 40, outbound: 4, line: 100 },
  { key: "w2", inbound: 10, outbound: 10, line: 100 },
];

const draw = () =>
  render(
    <StreamBand
      weeks={weeks}
      inboundLabel="Created"
      outboundLabel="Finished"
      lineLabel="Backlog"
      label="Two weeks."
    />,
  );

describe("StreamBand", () => {
  it("renders nothing without weeks", () => {
    const { container } = render(
      <StreamBand weeks={[]} inboundLabel="a" outboundLabel="b" lineLabel="c" label="d" />,
    );
    expect(container.querySelector("svg")).toBeNull();
  });

  it("draws both series against a line, and names all three", () => {
    draw();
    expect(screen.getByRole("img", { name: "Two weeks." })).toBeTruthy();
    expect(screen.getByText("Created")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.getByText("Backlog")).toBeTruthy();
  });

  it("scales both directions against the same maximum", () => {
    const { container } = draw();
    const rects = [...container.querySelectorAll("rect")];
    const created = Number(rects[0].getAttribute("height"));
    const finished = Number(rects[1].getAttribute("height"));
    expect(created / finished).toBeCloseTo(10, 1);
  });

  it("offers no door", () => {
    const { container } = draw();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[tabindex]")).toBeNull();
  });
});
