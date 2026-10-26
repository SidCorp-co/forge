"use client";


import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/design/primitives/button";
import { cn } from "@/lib/utils/cn";
import { BodyImage, BodyLink } from "./body-link";
import {
  CODE_BLOCK_CLASS,
  CODE_BLOCK_WRAPPED_CLASS,
  CODE_INLINE_CLASS,
  COMPACT_TAG_CLASS as T,
  LINK_CLASS,
} from "./body-tags";
import { MermaidDiagram } from "./mermaid";

const sameUrl = (url: string) => url;

/** A relative link to another doc page (not scheme:/protocol-relative/absolute/
 *  anchor). Covers the viewer's own `?path=<slug>` form, slug links
 *  (`pair-a-runner`) and legacy `.md` links. */
export function isRelativeDocLink(href: string): boolean {
  return !/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(href);
}

/** Resolve a relative doc href against the current doc's slug → a slug the Docs
 *  viewer can open via `?path=`. A `?path=<slug>` href names its slug outright;
 *  anything else is a path, with a legacy `.md` extension tolerated. An empty
 *  result is a link to no page, which the viewer answers as a missing page. */
export function resolveDocPath(baseFile: string, href: string): string {
  if (href.startsWith("?")) {
    return new URLSearchParams(href.split("#")[0]).get("path") ?? "";
  }
  const clean = href.split(/[#?]/)[0].replace(/\.mdx?$/i, "");
  const baseDir = baseFile.includes("/") ? baseFile.slice(0, baseFile.lastIndexOf("/")) : "";
  const segs = `${baseDir ? `${baseDir}/` : ""}${clean}`.split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out.join("/");
}

const linkRenderer: Components["a"] = ({ href, children }) => (
  <BodyLink href={href}>{children}</BodyLink>
);

/** Link renderer for a docs reader: relative `.md` links navigate inside the
 *  reader (`<docRoute>?path=…`); everything else falls back to the shared rule. This
 *  is the one place a `Markdown` and a `BodyView` given the same bare-relative
 *  href answer differently, and it is deliberate. */
function makeDocLinkRenderer(docBasePath: string, docRoute: string): Components["a"] {
  return ({ href, children }) => {
    if (href && isRelativeDocLink(href)) {
      return (
        <a href={`${docRoute}?path=${encodeURIComponent(resolveDocPath(docBasePath, href))}`} className={LINK_CLASS}>
          {children}
        </a>
      );
    }
    return <BodyLink href={href}>{children}</BodyLink>;
  };
}

const imgRenderer: Components["img"] = ({ src, alt }) => (
  <BodyImage src={typeof src === "string" ? src : undefined} alt={alt} />
);

function makeCodeRenderer(blockClass: string, inlineClass: string): Components["code"] {
  return ({ className, children, ...props }: ComponentProps<"code"> & { inline?: boolean }) => {
    if (className === "language-mermaid") {
      return <MermaidDiagram code={String(children).trimEnd()} className="my-3" />;
    }
    const isBlock = (className ?? "").includes("language-") || String(children).includes("\n");
    return isBlock ? (
      <code className={blockClass} {...props}>
        {children}
      </code>
    ) : (
      <code className={inlineClass} {...props}>
        {children}
      </code>
    );
  };
}

type HastElement = NonNullable<ExtraProps["node"]>;

/** Whether a `<pre>` holds a mermaid diagram, which is drawn rather than copied. */
function holdsMermaid(node: HastElement | undefined): boolean {
  const code = node?.children.find((c): c is HastElement => c.type === "element" && c.tagName === "code");
  const cls = code?.properties?.className;
  return Array.isArray(cls) && cls.includes("language-mermaid");
}

type CopyState = "idle" | "copied" | "failed";

/**
 * A fenced block on a doc page, with a Copy button over it: a reader told to paste a block has
 * to get it onto the clipboard first, and selecting twenty lines exactly is the act a first-time
 * reader gets wrong (ISS-1289). The button reads like the MCP tab's snippet button.
 */
function ProseCodeBlock({ node, children }: ComponentProps<"pre"> & ExtraProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);

  if (holdsMermaid(node)) return <pre className="my-4 overflow-x-auto">{children}</pre>;

  async function copy() {
    try {
      await navigator.clipboard.writeText((preRef.current?.textContent ?? "").replace(/\n$/, ""));
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="my-4">
      <div className="mb-1.5 flex justify-end">
        <Button variant="secondary" size="sm" onClick={copy} className="min-h-11" aria-live="polite">
          {state === "copied" ? "Copied ✓" : state === "failed" ? "Couldn't copy — select it instead" : "Copy"}
        </Button>
      </div>
      <pre ref={preRef} className="overflow-x-auto">
        {children}
      </pre>
    </div>
  );
}

// COMPACT — dense styling for inline embeds (issue descriptions, comments,
// plans). Small body, flattened heading scale, stepped down one level: an embed sits under its
// page's own h1, so a description's `# Title` is never a second one (ISS-1229 r47).
const compactComponents: Components = {
  h1: ({ children }) => <h2 className={T.h1}>{children}</h2>,
  h2: ({ children }) => <h3 className={T.h2}>{children}</h3>,
  h3: ({ children }) => <h4 className={T.h3}>{children}</h4>,
  p: ({ children }) => <p className={T.p}>{children}</p>,
  a: linkRenderer,
  ul: ({ children }) => <ul className={T.ul}>{children}</ul>,
  ol: ({ children }) => <ol className={T.ol}>{children}</ol>,
  li: ({ children }) => <li className={T.li}>{children}</li>,
  blockquote: ({ children }) => <blockquote className={T.blockquote}>{children}</blockquote>,
  code: makeCodeRenderer(CODE_BLOCK_CLASS, CODE_INLINE_CLASS),
  pre: ({ children }) => <pre className={T.pre}>{children}</pre>,
  img: imgRenderer,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className={T.table}>{children}</table>
    </div>
  ),
  th: ({ children }) => <th className={T.th}>{children}</th>,
  td: ({ children }) => <td className={T.td}>{children}</td>,
  hr: () => <hr className={T.hr} />,
};

/** The compact set with code blocks that wrap rather than scroll (ISS-1229 r41). */
const compactWrappedComponents: Components = {
  ...compactComponents,
  code: makeCodeRenderer(CODE_BLOCK_WRAPPED_CLASS, CODE_INLINE_CLASS),
};

// PROSE — long-form reading styling for the Docs viewer. Comfortable body size + line-height,
// roomier code/tables, and a soft callout for blockquotes. Its headings keep their scale and step
// down one level, as the compact set's do: the page that shows the document owns its h1.
const proseComponents: Components = {
  h1: ({ children }) => (
    <h2 className="fg-h1 mt-8 mb-4 border-b border-line pb-2 first:mt-0">{children}</h2>
  ),
  h2: ({ children }) => <h3 className="fg-h2 mt-8 mb-3 first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="fg-h3 mt-6 mb-2 first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="fg-body my-4 leading-7 first:mt-0 last:mb-0">{children}</p>,
  a: linkRenderer,
  ul: ({ children }) => <ul className="fg-body my-4 list-disc space-y-2 pl-6 leading-7">{children}</ul>,
  ol: ({ children }) => <ol className="fg-body my-4 list-decimal space-y-2 pl-6 leading-7">{children}</ol>,
  li: ({ children }) => <li className="leading-7 [&>ul]:my-2 [&>ol]:my-2">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-4 rounded-md border-l-[3px] border-[color:var(--accent)] bg-sunken py-2 pr-3 pl-4 text-muted">
      {children}
    </blockquote>
  ),
  code: makeCodeRenderer(
    "block overflow-x-auto rounded-lg border border-line bg-sunken p-4 font-mono text-13 leading-relaxed text-fg",
    "rounded bg-sunken px-1.5 py-0.5 font-mono text-13 text-fg",
  ),
  pre: ProseCodeBlock,
  img: imgRenderer,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-left text-13">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-line bg-sunken px-3 py-2 font-semibold text-fg">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-line-subtle px-3 py-2 align-top text-fg">{children}</td>,
  hr: () => <hr className="my-6 border-line" />,
};

export interface MarkdownProps {
  children: string;
  className?: string;
  /** `compact` (default) for inline embeds; `prose` for long-form doc reading. */
  variant?: "compact" | "prose";
  /** Current doc's repo-root path. When set, relative `.md` links resolve to
   *  in-viewer navigation (`/docs?path=…`) instead of the external core origin. */
  docBasePath?: string;
  /** Where those links navigate: `/docs` in the workspace, `/guides` on the public pages. */
  docRoute?: string;
  /**
   * `wrap` breaks a compact code block's long lines inside its column, for text read where a sideways
   * scroll shows no sign of itself, as a reply in a conversation is; `scroll` (default) keeps each line whole.
   */
  codeBlocks?: "scroll" | "wrap";
}

/** Render trusted-ish markdown (issue descriptions, comments, plans, docs). */
export function Markdown({
  children,
  className,
  variant = "compact",
  docBasePath,
  docRoute = "/docs",
  codeBlocks = "scroll",
}: MarkdownProps): ReactNode {
  const components = useMemo<Components>(() => {
    const compact = codeBlocks === "wrap" ? compactWrappedComponents : compactComponents;
    const base = variant === "prose" ? proseComponents : compact;
    return docBasePath ? { ...base, a: makeDocLinkRenderer(docBasePath, docRoute) } : base;
  }, [variant, docBasePath, docRoute, codeBlocks]);
  return (
    <div className={cn("min-w-0 max-w-full break-words [overflow-wrap:anywhere]", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={sameUrl}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
