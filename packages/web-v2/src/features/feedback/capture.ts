// The page as the reporter saw it, taken when they open the report (REQ-66 BC-1). modern-screenshot
// draws the DOM through the browser's own renderer (an SVG foreignObject), so the OKLCH tokens and
// the fonts render as they show; it is loaded only when a report is opened.

/** What the screenshot is sent as: small enough for the attachment limit, sharp enough to read. */
const TYPE = "image/jpeg";
const QUALITY = 0.85;

/** The page's screenshot, or null where the browser could not draw it; the report stands without one. */
export async function capturePage(): Promise<Blob | null> {
  try {
    const { domToBlob } = await import("modern-screenshot");
    return await domToBlob(document.body, {
      type: TYPE,
      quality: QUALITY,
      scale: 1,
      backgroundColor: getComputedStyle(document.body).backgroundColor || null,
      // the report's own controls are never in the picture
      filter: (node) => !(node instanceof HTMLElement && node.dataset.captureSkip !== undefined),
    });
  } catch {
    return null;
  }
}

/** A blob as base64, the way core's attachment fields take bytes. */
export function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("the screenshot could not be read"));
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}
