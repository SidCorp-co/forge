/*!
 * Forge feedback widget loader. One script tag on a client page:
 *
 *   <script src="https://<forge web>/widget.js" data-site-key="fw_site_..." async></script>
 *
 * It draws a launcher button and, on first open, an iframe of the Forge frame page
 * (`/w/<site key>`, packages/contracts/src/widget.ts:widgetFramePath). The page talks to the frame
 * only through postMessage with `source: "forge-widget"`, sent to the Forge origin alone, and takes
 * frame messages only from that origin and that iframe. Its elements live in a shadow root with
 * inline styles, so no style leaks either way.
 *
 *   ForgeWidget.setContext({ productId, appVersion, extra, title, url, locale })
 *   ForgeWidget.identify({ userId, ts, sig, email, name })
 *   ForgeWidget.open() / ForgeWidget.close() / ForgeWidget.toggle()
 *
 * A call made before the script has run is queued, and runs once it has:
 *
 *   window.ForgeWidget = window.ForgeWidget || { q: [] };
 *   ForgeWidget.q.push(["identify", { userId: "u1", ts: 1760000000, sig: "<hex>" }]);
 *
 * After load `ForgeWidget.q.push` runs the call at once, so the same lines work either way.
 * Written in ES5 with no dependency: it runs on the client's page, whatever that page targets.
 */
(function (window, document) {
  "use strict";

  var SOURCE = "forge-widget";
  var SITE_KEY = /^fw_site_[A-Za-z0-9_-]{32}$/;
  var SIG = /^[0-9a-f]{64}$/;
  var ACCENT = /^#[0-9a-fA-F]{6}$/;
  var CONTEXT_KEYS = { url: 2000, title: 300, productId: 200, appVersion: 100, locale: 35, userAgent: 500 };
  var PHONE = 480;

  var existing = window.ForgeWidget;
  if (existing && existing.loaded) return;

  function warn(what) {
    if (window.console && window.console.error) window.console.error("[forge-widget] " + what);
  }

  function findScript() {
    if (document.currentScript && document.currentScript.getAttribute("data-site-key")) return document.currentScript;
    var all = document.querySelectorAll("script[data-site-key]");
    for (var i = all.length - 1; i >= 0; i--) {
      if (/\/widget\.js(\?|#|$)/.test(all[i].src)) return all[i];
    }
    return null;
  }

  /** The script's own origin and directory: the frame is served beside it, under any base path. */
  function placeOf(src) {
    var a = document.createElement("a");
    a.href = src;
    var port = a.port && !((a.protocol === "https:" && a.port === "443") || (a.protocol === "http:" && a.port === "80"));
    var path = a.pathname.charAt(0) === "/" ? a.pathname : "/" + a.pathname;
    return { origin: a.protocol + "//" + a.hostname + (port ? ":" + a.port : ""), dir: path.replace(/[^/]*$/, "") };
  }

  var script = findScript();
  var siteKey = script ? script.getAttribute("data-site-key") : null;
  if (!script || !siteKey || !SITE_KEY.test(siteKey)) {
    warn('no valid data-site-key on the widget script tag; expected "fw_site_" and 32 characters. The widget is off.');
    return;
  }
  var place = placeOf(script.src);
  var FORGE_ORIGIN = place.origin;
  var FRAME_URL = FORGE_ORIGIN + place.dir + "w/" + encodeURIComponent(siteKey);
  var accentAttr = script.getAttribute("data-accent");
  var accent = accentAttr && ACCENT.test(accentAttr) ? accentAttr : "#1f2937";

  var state = { open: false, ready: false, unread: 0, context: {}, identity: null, lastFocus: null };
  var els = {};

  function clip(value, max) {
    return typeof value === "string" ? value.slice(0, max) : undefined;
  }

  /** The page's own context first, then what the client set: every field as the contract caps it. */
  function contextNow() {
    var out = {
      url: clip(window.location.href, CONTEXT_KEYS.url),
      title: clip(document.title, CONTEXT_KEYS.title),
      locale: clip(window.navigator.language, CONTEXT_KEYS.locale),
      userAgent: clip(window.navigator.userAgent, CONTEXT_KEYS.userAgent)
    };
    for (var key in state.context) {
      if (Object.prototype.hasOwnProperty.call(state.context, key)) out[key] = state.context[key];
    }
    for (var k in out) {
      if (out[k] === undefined || out[k] === "") delete out[k];
    }
    return out;
  }

  function post(message) {
    if (!state.ready || !els.frame || !els.frame.contentWindow) return;
    message.source = SOURCE;
    els.frame.contentWindow.postMessage(message, FORGE_ORIGIN);
  }

  function flush() {
    post({ type: "context", context: contextNow() });
    if (state.identity) post({ type: "identify", signed: state.identity });
    post({ type: state.open ? "open" : "close" });
  }

  function isPhone() {
    return (window.innerWidth || document.documentElement.clientWidth) < PHONE;
  }

  function css(el, styles) {
    for (var name in styles) {
      if (Object.prototype.hasOwnProperty.call(styles, name)) el.style.setProperty(name, styles[name]);
    }
  }

  function layout() {
    if (!els.panel) return;
    var phone = isPhone();
    css(els.panel, phone
      ? { top: "0", left: "0", right: "0", bottom: "0", width: "100%", height: "100%", "max-height": "100%", "border-radius": "0" }
      : { top: "auto", left: "auto", right: "20px", bottom: "88px", width: "380px", height: "560px", "max-height": "calc(100vh - 108px)", "border-radius": "16px" });
    els.panel.style.display = state.open ? "block" : "none";
    els.launcher.style.display = state.open && phone ? "none" : "flex";
  }

  function labelLauncher() {
    var label = state.open ? "Close feedback chat" : "Open feedback chat";
    if (!state.open && state.unread > 0) label += ", " + state.unread + " unread";
    els.launcher.setAttribute("aria-label", label);
    els.launcher.setAttribute("aria-expanded", state.open ? "true" : "false");
    els.icon.innerHTML = state.open ? ICON_CLOSE : ICON_CHAT;
    els.badge.textContent = state.unread > 9 ? "9+" : String(state.unread);
    els.badge.style.display = !state.open && state.unread > 0 ? "flex" : "none";
  }

  var ICON_CHAT =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_CLOSE =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  /** Text on the accent: black or white, whichever reads better against it. */
  function inkOn(hex) {
    var n = parseInt(hex.slice(1), 16);
    var rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    for (var i = 0; i < 3; i++) {
      var c = rgb[i] / 255;
      rgb[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    var lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return lum > 0.4 ? "#111111" : "#ffffff";
  }

  function build() {
    var host = document.createElement("div");
    host.setAttribute("data-forge-widget", "");
    css(host, { position: "fixed", "z-index": "2147483000", top: "0", left: "0", width: "0", height: "0" });
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    if (host.attachShadow) {
      var style = document.createElement("style");
      style.textContent =
        "button:focus-visible{outline:3px solid " + accent + ";outline-offset:3px}" +
        "button:hover{transform:scale(1.05)}" +
        "@media (prefers-reduced-motion: reduce){button{transition:none!important}button:hover{transform:none}}";
      root.appendChild(style);
    }

    var launcher = document.createElement("button");
    launcher.type = "button";
    launcher.setAttribute("aria-controls", "forge-widget-panel");
    css(launcher, {
      position: "fixed", right: "20px", bottom: "20px", width: "56px", height: "56px", margin: "0", padding: "0",
      display: "flex", "align-items": "center", "justify-content": "center", border: "0", "border-radius": "50%",
      background: accent, color: inkOn(accent), cursor: "pointer", "box-shadow": "0 6px 20px rgba(0,0,0,.25)",
      transition: "transform .15s ease", "font-family": "system-ui, sans-serif"
    });
    var icon = document.createElement("span");
    css(icon, { display: "flex", "pointer-events": "none" });
    var badge = document.createElement("span");
    badge.setAttribute("aria-hidden", "true");
    css(badge, {
      position: "absolute", top: "-2px", right: "-2px", "min-width": "20px", height: "20px", padding: "0 5px",
      "box-sizing": "border-box", "border-radius": "10px", background: "#dc2626", color: "#ffffff",
      font: "600 12px/20px system-ui, sans-serif", display: "none", "align-items": "center", "justify-content": "center"
    });
    launcher.appendChild(icon);
    launcher.appendChild(badge);
    launcher.addEventListener("click", function () {
      api.toggle();
    });

    var panel = document.createElement("div");
    panel.id = "forge-widget-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Feedback chat");
    css(panel, {
      position: "fixed", display: "none", overflow: "hidden", background: "transparent",
      "box-shadow": "0 12px 40px rgba(0,0,0,.28)", "max-width": "100vw"
    });

    root.appendChild(panel);
    root.appendChild(launcher);
    (document.body || document.documentElement).appendChild(host);
    els.host = host;
    els.launcher = launcher;
    els.icon = icon;
    els.badge = badge;
    els.panel = panel;
    labelLauncher();
    layout();
  }

  function ensureFrame() {
    if (els.frame) return;
    var frame = document.createElement("iframe");
    frame.src = FRAME_URL;
    frame.title = "Feedback chat";
    frame.setAttribute("referrerpolicy", "origin");
    css(frame, { display: "block", width: "100%", height: "100%", border: "0", margin: "0", padding: "0", background: "transparent" });
    els.frame = frame;
    els.panel.appendChild(frame);
  }

  function setOpen(open) {
    if (!started) {
      pending.push([open ? "open" : "close"]);
      return;
    }
    if (open === state.open) return;
    if (open) {
      // focus inside the shadow root reads as its host from the page: the launcher is what had it
      state.lastFocus = document.activeElement === els.host ? els.launcher : document.activeElement;
      ensureFrame();
      state.unread = 0;
    }
    state.open = open;
    labelLauncher();
    layout();
    if (open) {
      post({ type: "context", context: contextNow() });
      post({ type: "open" });
      els.frame.focus();
    } else {
      post({ type: "close" });
      var back = state.lastFocus && state.lastFocus !== document.body ? state.lastFocus : els.launcher;
      if (back && back.focus) back.focus();
    }
  }

  /** A frame message, taken only from the Forge origin and from this widget's own iframe. */
  function onMessage(event) {
    if (event.origin !== FORGE_ORIGIN) return;
    if (!els.frame || event.source !== els.frame.contentWindow) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.source !== SOURCE) return;
    if (data.type === "ready") {
      state.ready = true;
      flush();
    } else if (data.type === "close") {
      setOpen(false);
    } else if (data.type === "unread") {
      var count = typeof data.count === "number" && data.count >= 0 ? Math.floor(data.count) : 0;
      state.unread = state.open ? 0 : count;
      labelLauncher();
    }
  }

  function onKey(event) {
    if (state.open && (event.key === "Escape" || event.key === "Esc")) setOpen(false);
  }

  var api = {
    loaded: true,
    open: function () {
      setOpen(true);
    },
    close: function () {
      setOpen(false);
    },
    toggle: function () {
      setOpen(!state.open);
    },
    /** What the client knows of where the visitor is; a key the contract does not name is refused by name. */
    setContext: function (context) {
      if (!context || typeof context !== "object") return warn("setContext takes an object");
      var next = {};
      for (var key in context) {
        if (!Object.prototype.hasOwnProperty.call(context, key)) continue;
        var value = context[key];
        if (key === "extra") {
          if (value && typeof value === "object") next.extra = extraOf(value);
        } else if (CONTEXT_KEYS[key] && key !== "userAgent") {
          if (typeof value === "string") next[key] = value.slice(0, CONTEXT_KEYS[key]);
          else warn("setContext: " + key + " must be a string");
        } else {
          warn("setContext: " + key + " is not a context field (url, title, productId, appVersion, locale, extra)");
        }
      }
      state.context = next;
      post({ type: "context", context: contextNow() });
    },
    /** The client backend's signature for its signed-in user: `sig` is hex HMAC-SHA256 of `${userId}.${ts}`. */
    identify: function (who) {
      if (!who || typeof who.userId !== "string" || who.userId === "") return warn("identify needs a userId string");
      if (typeof who.ts !== "number" || Math.floor(who.ts) !== who.ts) return warn("identify needs ts in whole unix seconds");
      if (typeof who.sig !== "string" || !SIG.test(who.sig)) return warn("identify needs sig as 64 lower-case hex characters");
      var signed = { userId: who.userId, ts: who.ts, sig: who.sig };
      if (typeof who.email === "string" && who.email) signed.email = who.email;
      if (typeof who.name === "string" && who.name) signed.name = who.name;
      state.identity = signed;
      post({ type: "identify", signed: signed });
    }
  };

  function extraOf(value) {
    var out = {};
    var n = 0;
    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (n >= 20) {
        warn("setContext: extra keeps at most 20 keys; " + key + " and later are dropped");
        break;
      }
      if (typeof value[key] !== "string") {
        warn("setContext: extra." + key + " must be a string");
        continue;
      }
      out[key.slice(0, 60)] = value[key].slice(0, 500);
      n++;
    }
    return out;
  }

  var started = false;
  var pending = existing && existing.q && existing.q.length ? Array.prototype.slice.call(existing.q) : [];

  function run(call) {
    var name = call && call[0];
    if (typeof name === "string" && name !== "q" && name !== "loaded" && typeof api[name] === "function") {
      api[name].apply(api, Array.prototype.slice.call(call, 1));
    } else {
      warn("queued call " + name + " is not a ForgeWidget method");
    }
  }

  api.q = {
    push: function (call) {
      if (started) run(call);
      else pending.push(call);
    }
  };

  window.ForgeWidget = api;
  window.addEventListener("message", onMessage, false);
  window.addEventListener("keydown", onKey, false);
  window.addEventListener("resize", layout, false);

  function start() {
    build();
    started = true;
    for (var i = 0; i < pending.length; i++) run(pending[i]);
    pending = [];
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, false);
})(window, document);
