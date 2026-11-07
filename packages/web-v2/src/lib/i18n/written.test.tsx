import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Written } from "./written";

// What a person or a model wrote is shown as written, never translated, and never marked with a
// language: the chrome is English only (owner, 2026-10-08), so a language badge beside a title is
// chrome in another language's name, and a wrong guess put "VI" on English titles (ISS-1071). The
// text keeps its `lang` attribute for the browser and assistive tech, and nothing on the face.

const shown = (lang: "en" | "vi" | null, text = "Release smoke v1 failed on staging") => render(<Written text={text} lang={lang} />);

describe("a written text", () => {
  it("reads Vietnamese someone wrote as written, with its lang and no mark", () => {
    shown("vi", "Bản phát hành thử v1 lỗi trên staging"); // i18n-allow: Vietnamese content under test
    expect(screen.getByText("Bản phát hành thử v1 lỗi trên staging")).toHaveAttribute("lang", "vi"); // i18n-allow: Vietnamese content under test
    expect(screen.queryByTestId("written-mark")).toBeNull();
    expect(document.body.textContent).toBe("Bản phát hành thử v1 lỗi trên staging"); // i18n-allow: Vietnamese content under test
  });

  it("puts no mark on an English title core read as Vietnamese", () => {
    shown("vi", "Empty or test-only features take rail rows: Ecosystem threads, Pair, Pipeline");
    expect(document.body.textContent).toBe("Empty or test-only features take rail rows: Ecosystem threads, Pair, Pipeline");
  });

  it("guesses no language where none was kept", () => {
    shown(null);
    expect(screen.queryByTestId("written-mark")).toBeNull();
    expect(screen.getByText("Release smoke v1 failed on staging")).not.toHaveAttribute("lang");
  });
});
