import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InterfaceLanguageScope } from "./interface-language";
import { Written } from "./written";

// What a person or a model wrote is shown as written, never translated: marked with its language
// where that is not the reader's, unmarked where it is, and unmarked where the language was not kept.

const shown = (language: "en" | "vi", lang: "en" | "vi" | null) =>
  render(
    <InterfaceLanguageScope language={language}>
      <Written text="Release smoke v1 failed on staging" lang={lang} />
    </InterfaceLanguageScope>,
  );

describe("a written text", () => {
  it("reads as English someone wrote, marked, on a vi screen", () => {
    shown("vi", "en");
    expect(screen.getByText("Release smoke v1 failed on staging", { exact: false })).toHaveAttribute("lang", "en");
    expect(screen.getByTestId("written-mark")).toHaveTextContent("en");
    expect(screen.getByTestId("written-mark")).toHaveAttribute("title", "Viết bằng tiếng Anh, hiển thị nguyên văn"); // i18n-allow: Vietnamese text under test
  });

  it("carries no mark in the reader's own language", () => {
    shown("en", "en");
    expect(screen.queryByTestId("written-mark")).toBeNull();
  });

  it("carries no mark, and guesses no language, where none was kept", () => {
    shown("vi", null);
    expect(screen.queryByTestId("written-mark")).toBeNull();
    expect(screen.getByText("Release smoke v1 failed on staging")).not.toHaveAttribute("lang");
  });
});
