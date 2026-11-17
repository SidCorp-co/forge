// noVNC ships no types; this is the slice of its RFB client a desktop box's view uses.
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | object, options?: { shared?: boolean });
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    disconnect(): void;
  }
}
