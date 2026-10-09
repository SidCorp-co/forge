// REQ-40 BC-4: QA keeps a short screen clip of each observable criterion as verdict evidence. The
// Judge form takes a clip beside a picture, and refuses by name what the release page could not show.

import { RELEASE_CLIP_MAX_BYTES } from "@forge/contracts/release-page";
import { describe, expect, it } from "vitest";
import { evidenceFileRefusal } from "./criteria";

const file = (name: string, type: string, bytes = 3) => new File([new Uint8Array(bytes)], name, { type });

describe("evidenceFileRefusal", () => {
  it("takes a clip at the ceiling and a picture", () => {
    expect(evidenceFileRefusal(file("bc-4.webm", "video/webm", RELEASE_CLIP_MAX_BYTES))).toBeNull();
    expect(evidenceFileRefusal(file("bc-4.mp4", "video/mp4"))).toBeNull();
    expect(evidenceFileRefusal(file("shot.png", "image/png"))).toBeNull();
  });

  it("refuses a clip one byte over the ceiling, naming the cap", () => {
    expect(evidenceFileRefusal(file("bc-4.webm", "video/webm", RELEASE_CLIP_MAX_BYTES + 1))).toEqual({ kind: "clipTooLarge", name: "bc-4.webm", cap: "10 MB" });
  });

  it("refuses a file that is neither a clip nor a picture, naming its type", () => {
    expect(evidenceFileRefusal(file("run.log", "text/plain"))).toEqual({ kind: "type", name: "run.log" });
    expect(evidenceFileRefusal(file("tour.mov", "video/quicktime"))).toEqual({ kind: "type", name: "tour.mov" });
  });

  it("reads a clip by its extension where the browser names no type", () => {
    expect(evidenceFileRefusal(file("bc-4.webm", ""))).toBeNull();
    expect(evidenceFileRefusal(file("bc-4.webm", "", RELEASE_CLIP_MAX_BYTES + 1))).toEqual({ kind: "clipTooLarge", name: "bc-4.webm", cap: "10 MB" });
    expect(evidenceFileRefusal(file("notes", ""))).toEqual({ kind: "type", name: "notes" });
  });

  it("refuses an empty file", () => {
    expect(evidenceFileRefusal(file("bc-4.webm", "video/webm", 0))).toEqual({ kind: "empty", name: "bc-4.webm" });
  });
});
