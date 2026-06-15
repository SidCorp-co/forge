"use client";

// Thin Markdown renderer for web-v2 — a semantic-token-styled port of v1's
// `packages/web/src/components/ui/markdown.tsx`, kept dependency-light
// (react-markdown + remark-gfm only; no syntax-highlight bundle). Relative
// image/link srcs are mapped through `coreFileUrl` so comment-embedded
// attachments (`![](…/download)`) resolve against the core origin.

import { useMemo } from "react";
import type { ComponentProps, ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { coreFileUrl } from "@/lib/api/client";
import { cn } from "@/lib/utils/cn";

const LINK_CLASS = "text-[color:var(--link)] underline underline-offset-2 hover:opacity-80";

/** A relative link to another markdown doc (not http(s)/mailto/anchor). */
function isRelativeDocLink(href: string): boolean {
  if (/^(https?:|mailto:|#|\/)/i.test(href)) return false;
  return /\.mdx?($|[#?])/i.test(href);
}

/** Resolve a relative `.md` href against the current doc's path → a repo-root
 *  POSIX path the Docs viewer can open via `?path=`. */
function resolveDocPath(baseFile: string, href: string): string {
  const clean = href.split(/[#?]/)[0];
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

// Shared renderers — identical across variants (external link / image mapping).
function renderExternalLink(href: string | undefined, children: ReactNode) {
  return (
    <a
      href={href ? coreFileUrl(href) : undefined}
      target="_blank"
      rel="noreferrer noopener"
      className={LINK_CLASS}
    >
      {children}
    </a>
  );
}

const linkRenderer: Components["a"] = ({ href, children }) => renderExternalLink(href, children);

/** Link renderer for the Docs viewer: relative `.md` links navigate inside the
 *  viewer (`/docs?path=…`); everything else falls back to the external one. */
function makeDocLinkRenderer(docBasePath: string): Components["a"] {
  return ({ href, children }) => {
    if (href && isRelativeDocLink(href)) {
      return (
        <a href={`/docs?path=${encodeURIComponent(resolveDocPath(docBasePath, href))}`} className={LINK_CLASS}>
          {children}
        </a>
      );
    }
    return renderExternalLink(href, children);
  };
}

const imgRenderer: Components["img"] = ({ src, alt }) => (
  // biome-ignore lint/a11y/useAltText: alt is forwarded from markdown
  <img
    src={typeof src === "string" ? coreFileUrl(src) : undefined}
    alt={alt ?? ""}
    className="my-3 max-w-full rounded-md border border-line"
  />
);

// COMPACT — dense styling for inline embeds (issue descriptions, comments,
// plans). Small body, flattened heading scale.
const compactComponents: Components = {
  h1: ({ children }) => <h1 className="fg-h3 mt-4 mb-2 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="fg-h3 mt-4 mb-2 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="fg-label mt-3 mb-1.5 first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="fg-body-sm my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  a: linkRenderer,
  ul: ({ children }) => <ul className="fg-body-sm my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="fg-body-sm my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-muted">{children}</blockquote>
  ),
  code: ({ className, children, ...props }: ComponentProps<"code"> & { inline?: boolean }) => {
    const isBlock = (className ?? "").includes("language-") || String(children).includes("\n");
    if (isBlock) {
      return (
        <code className="block overflow-x-auto rounded-md bg-sunken p-3 font-mono text-[12.5px] text-fg" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="rounded-sm bg-sunken px-1 py-0.5 font-mono text-[12.5px] text-fg" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => <pre className="my-2 overflow-x-auto">{children}</pre>,
  img: imgRenderer,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-left text-[12.5px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-line px-2 py-1 font-mono text-muted">{children}</th>,
  td: ({ children }) => <td className="border-b border-line-subtle px-2 py-1 text-fg">{children}</td>,
  hr: () => <hr className="my-3 border-line" />,
};

// PROSE — long-form reading styling for the Docs viewer. Real heading
// hierarchy, comfortable body size + line-height, roomier code/tables, and a
// soft callout for blockquotes.
const proseComponents: Components = {
  h1: ({ children }) => (
    <h1 className="fg-h1 mt-8 mb-4 border-b border-line pb-2 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => <h2 className="fg-h2 mt-8 mb-3 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="fg-h3 mt-6 mb-2 first:mt-0">{children}</h3>,
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
  code: ({ className, children, ...props }: ComponentProps<"code"> & { inline?: boolean }) => {
    const isBlock = (className ?? "").includes("language-") || String(children).includes("\n");
    if (isBlock) {
      return (
        <code
          className="block overflow-x-auto rounded-lg border border-line bg-sunken p-4 font-mono text-[13px] leading-relaxed text-fg"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[13px] text-fg" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => <pre className="my-4 overflow-x-auto">{children}</pre>,
  img: imgRenderer,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-left text-[13px]">{children}</table>
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
}

/** Render trusted-ish markdown (issue descriptions, comments, plans, docs). */
export function Markdown({ children, className, variant = "compact", docBasePath }: MarkdownProps): ReactNode {
  const components = useMemo<Components>(() => {
    const base = variant === "prose" ? proseComponents : compactComponents;
    return docBasePath ? { ...base, a: makeDocLinkRenderer(docBasePath) } : base;
  }, [variant, docBasePath]);
  return (
    <div className={cn("min-w-0 max-w-full break-words [overflow-wrap:anywhere]", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
