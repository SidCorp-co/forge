// @vitest-environment node
// @gate-input whole-tree
//
// A control name holding entities comes back from Chrome as typed, not decoded a second time.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { measureReach, WARM_HOOK_MS, warmChrome } from "./chrome-layout";

beforeAll(() => warmChrome(), WARM_HOOK_MS);

const TYPED = '&lt; &amp;lt; "';

describe("measureReach reads the report back exactly", () => {
  it("returns a control named with an entity as it was typed, not unescaped twice", async () => {
    const markup = renderToStaticMarkup(
      <table aria-label="T">
        <tbody>
          <tr>
            <td className="sticky">row</td>
            <td>
              <button type="button" aria-label={TYPED}>
                b
              </button>
            </td>
          </tr>
        </tbody>
      </table>,
    );
    const { reach } = await measureReach(markup, 356, 390);
    expect(reach.map((r) => r.control)).toEqual([TYPED]);
  });
});
