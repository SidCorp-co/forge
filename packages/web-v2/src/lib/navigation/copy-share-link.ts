import { showToast } from "@/design";
import { type Copy, productCopy } from "@/lib/i18n/product-copy";
import { buildShareLink } from "./deep-link";

/**
 * Copies the shareable link to an in-app path, and toasts whether the copy worked. A failed copy
 * shows the link, so it can be copied by hand: an insecure origin has no `navigator.clipboard`. `t` is
 * the reader's copy (a component's `useCopy()`); without one the toast reads in English.
 */
export function copyShareLink(path: string, t: Copy = productCopy()): void {
  const url = buildShareLink(path);
  const failed = () => showToast({ title: t("common.link.copyFailed"), description: url, tone: "error" });
  if (!navigator.clipboard) {
    failed();
    return;
  }
  navigator.clipboard.writeText(url).then(
    () => showToast({ title: t("common.link.copied"), description: url, tone: "success" }),
    failed,
  );
}
