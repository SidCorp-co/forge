import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Written } from "./written";

// What a person or a model wrote is shown as written, never translated: marked with its language
// where that is not English (the reader's, always), unmarked where it is, and unmarked where the
// language was not kept.

const shown = (lang: "en" | "vi" | null, text = "Release smoke v1 failed on staging") => render(<Written text={text} lang={lang} />);

describe("a written text", () => {
  it("reads as Vietnamese someone wrote, marked, on the English screen", () => {
    shown("vi", "Bản phát hành thử v1 lỗi trên staging"); // i18n-allow: Vietnamese content under test
    expect(screen.getByText("Bản phát hành thử v1 lỗi trên staging", { exact: false })).toHaveAttribute("lang", "vi"); // i18n-allow: Vietnamese content under test
    expect(screen.getByTestId("written-mark")).toHaveTextContent("vi");
    expect(screen.getByTestId("written-mark")).toHaveAttribute("title", "Written in Vietnamese, shown as written");
  });

  it("carries no mark for text written in English, the reader's own language", () => {
    shown("en");
    expect(screen.queryByTestId("written-mark")).toBeNull();
    expect(screen.getByText("Release smoke v1 failed on staging")).toHaveAttribute("lang", "en");
  });

  it("carries no mark, and guesses no language, where none was kept", () => {
    shown(null);
    expect(screen.queryByTestId("written-mark")).toBeNull();
    expect(screen.getByText("Release smoke v1 failed on staging")).not.toHaveAttribute("lang");
  });
});
