// What the frame keeps between visits on one site: the visitor id core issued, so a returning visitor
// continues as the same one, and the email the visitor typed, to fill the field again. The frame is a
// third-party iframe, where storage can be blocked or throw: every read and write is guarded, and
// without storage the frame still works, as a new visitor each time.

const keyOf = (siteKey: string) => `forge-widget:${siteKey}`;

export interface KeptVisitor {
  visitorId: string | null;
  email: string | null;
}

const NOBODY: KeptVisitor = { visitorId: null, email: null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readVisitor(siteKey: string): KeptVisitor {
  try {
    const raw = window.localStorage.getItem(keyOf(siteKey));
    if (!raw) return NOBODY;
    const kept = JSON.parse(raw) as Partial<KeptVisitor>;
    return {
      visitorId: typeof kept.visitorId === "string" && UUID.test(kept.visitorId) ? kept.visitorId : null,
      email: typeof kept.email === "string" && kept.email ? kept.email : null,
    };
  } catch {
    return NOBODY;
  }
}

export function keepVisitor(siteKey: string, visitor: KeptVisitor): void {
  try {
    window.localStorage.setItem(keyOf(siteKey), JSON.stringify(visitor));
  } catch {
    // storage is blocked in this frame: the next visit opens as a new visitor
  }
}
