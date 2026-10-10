"use client";

// Every token, primitive, block, page template and overlay the design layer has, in one page, with a
// theme switch scoped to the page (the member's own theme is left alone). Signed-in members only,
// through the workspace layout; no nav entry links here.

import { useState } from "react";
import { InPlaceTopBar, PageTitle, SegmentedControl } from "@/design";
import { BlockGallery, OverlayGallery, TemplateGallery } from "./gallery-blocks";
import { PrimitiveGallery, TokenGallery } from "./gallery-tokens";

type Theme = "light" | "dark";

export function DesignGallery({ initialTheme = "light" }: { initialTheme?: Theme }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  return (
    <div data-theme={theme} className="min-h-full bg-app text-fg" data-testid="design-gallery">
      <PageTitle>Design system</PageTitle>
      <InPlaceTopBar>
        <div className="flex items-center gap-3 border-b border-line-subtle px-8 py-3 max-md:px-4">
          <span className="text-13 text-muted">src/design · README.md has the grammar</span>
          <span className="flex-1" />
          <SegmentedControl
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            value={theme}
            onChange={setTheme}
          />
        </div>
      </InPlaceTopBar>
      <div className="mx-auto max-w-6xl px-8 py-6 max-md:px-4">
        <TokenGallery />
        <PrimitiveGallery />
        <BlockGallery />
        <TemplateGallery />
        <OverlayGallery />
      </div>
    </div>
  );
}
