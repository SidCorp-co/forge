"use client";

// Thin Markdown renderer for web-v2 — a semantic-token-styled port of v1's
// `packages/web/src/components/ui/markdown.tsx`, kept dependency-light
// (react-markdown + remark-gfm only; no syntax-highlight bundle). Relative
// image/link srcs are mapped through `coreFileUrl` so comment-embedded
// attachments (`![](…/download)`) resolve against the core origin.

import type { ComponentProps, ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { coreFileUrl } from "@/lib/api/client";
import { cn } from "@/lib/utils/cn";

const components: Components = {
  h1: ({ children }) => <h1 className="fg-h3 mt-4 mb-2 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="fg-h3 mt-4 mb-2 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="fg-label mt-3 mb-1.5 first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="fg-body-sm my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href ? coreFileUrl(href) : undefined}
      target="_blank"
      rel="noreferrer noopener"
      className="text-[color:var(--link)] underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
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
  img: ({ src, alt }) => (
    // biome-ignore lint/a11y/useAltText: alt is forwarded from markdown
    <img
      src={typeof src === "string" ? coreFileUrl(src) : undefined}
      alt={alt ?? ""}
      className="my-2 max-w-full rounded-md border border-line"
    />
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-left text-[12.5px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-line px-2 py-1 font-mono text-muted">{children}</th>,
  td: ({ children }) => <td className="border-b border-line-subtle px-2 py-1 text-fg">{children}</td>,
  hr: () => <hr className="my-3 border-line" />,
};

export interface MarkdownProps {
  children: string;
  className?: string;
}

/** Render trusted-ish markdown (issue descriptions, comments, plans). */
export function Markdown({ children, className }: MarkdownProps): ReactNode {
  return (
    <div className={cn("min-w-0 max-w-full break-words [overflow-wrap:anywhere]", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
