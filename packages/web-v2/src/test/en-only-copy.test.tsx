import { say } from "@forge/contracts/said";
import { describe, expect, it, vi } from "vitest";
import { InterfaceLanguageScope, useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { labelCopy } from "@/lib/i18n/labels";
import { productCopy } from "@/lib/i18n/product-copy";
import { said } from "@/lib/i18n/said";
import { renderWithQuery } from "./render";
import { unreadIn } from "./unread";

// Forge is not multilingual (the owner's ruling of 2026-10-08): a new copy key is written in English
// only. Here three keys lose their vi word, as a key written after the ruling never has
// one: a feature's own word, core's sentence (with the role it names) and a contract enum's label. On a vi page each
// reads its English, with no throw, no raw key and no blank.

const EN_ONLY = vi.hoisted(() => ["dash.fbUntriaged", "standing.who.holderOf", "label.permissionRole.releases.approve", "label.requirementState.in_delivery"]);

vi.mock("@/lib/i18n/copy-files", async (load) => {
  const { COPY_FILES } = await load<typeof import("@/lib/i18n/copy-files")>();
  const files = Object.fromEntries(
    Object.entries(COPY_FILES as Record<string, Record<string, Record<string, string>>>).map(([path, part]) => [
      path,
      { ...part, vi: Object.fromEntries(Object.entries(part.vi ?? {}).filter(([key]) => !EN_ONLY.includes(key))) },
    ]),
  );
  return { COPY_FILES: files };
});
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/", useParams: () => ({ slug: "hop" }) }));

/** The three readers' words for the keys above, drawn as a page draws them. */
function EnOnlyWords() {
  const t = useCopy();
  const language = useInterfaceLanguage();
  return (
    <p>
      {t("dash.fbUntriaged")} · {said(say("standing.who.holderOf", { perm: "releases.approve" }), language)} · {labelCopy(language)("requirementState", "in_delivery")}
    </p>
  );
}

describe("a copy key written in English only", () => {
  it("reads its English in vi through every reader", () => {
    expect(productCopy("vi")("dash.fbUntriaged")).toBe("untriaged");
    expect(said(say("standing.who.holderOf", { perm: "releases.approve" }), "vi")).toBe("Release approver");
    expect(labelCopy("vi")("requirementState", "in_delivery")).toBe("In delivery");
  });

  it("renders its English on a vi page, with no raw key and no blank label", () => {
    const { baseElement } = renderWithQuery(
      <InterfaceLanguageScope language="vi">
        <EnOnlyWords />
      </InterfaceLanguageScope>,
    );
    const text = baseElement.textContent ?? "";
    expect(text).toContain("untriaged");
    expect(text).toContain("Release approver");
    expect(text).toContain("In delivery");
    expect(unreadIn(baseElement)).toBeNull();
  });
});
