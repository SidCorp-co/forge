"use client";

// One renderer for both body formats. `markdown` goes to `<Markdown>`; `html`
// is a `forge-*` component body, and core hands the node tree over the wire
// because web-v2 has no `@forge/core` dependency and cannot parse one itself.
// There is deliberately no component name list here: `forge-diagram` and
// `forge-artifact` carry payload a generic block cannot draw and get a case
// each, and every other `forge-*` draws the same block, so a build meeting a
// component it has never heard of is ordinary rather than broken (ISS-967).

import type { BodyNode } from "@forge/contracts";
import { createElement, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { BodyImage, BodyLink } from "./body-link";
import { CODE_BLOCK_CLASS, CODE_INLINE_CLASS, COMPACT_TAG_CLASS } from "./body-tags";
import { Markdown } from "./markdown";
import { MermaidDiagram } from "./mermaid";

const VOID_TAGS = new Set(["br", "hr", "img"]);

/** `forge-plan` → `Plan`. The name is the only label a generic block has. */
function componentLabel(name: string): string {
  const bare = name.replace(/^forge-/, "").replace(/-/g, " ");
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/** Raw text of a node and its descendants — a diagram's own bytes, unescaped. */
function rawTextOf(nodes: BodyNode[]): string {
  return nodes
    .map((n) => (n.type === "text" ? n.value : n.type === "element" ? rawTextOf(n.children) : ""))
    .join("");
}

function isComponent(node: BodyNode): boolean {
  return node.type === "element" && node.name.startsWith("forge-");
}

function AttrChips({ attrs }: { attrs: Record<string, string> }) {
  const entries = Object.entries(attrs);
  if (entries.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-1.5">
      {entries.map(([k, v]) => (
        <li
          key={k}
          className="fg-caption rounded-sm border border-line-subtle bg-sunken px-1.5 py-0.5 font-mono text-muted"
        >
          {k}: {v}
        </li>
      ))}
    </ul>
  );
}

export interface BodyViewProps {
  /** The stored bytes. Rendered as markdown whenever `nodes` is absent. */
  body: string;
  format?: string | null;
  /** The tree core parsed, from `descriptionNodes` or a comment's `nodes`. */
  nodes?: BodyNode[] | null;
  /**
   * How a `<forge-artifact id>` draws. The design layer holds no API client and
   * cannot resolve an attachment id, so the feature that has the list supplies
   * this; without it the artifact draws as an ordinary component block.
   */
  renderArtifact?: (id: string) => ReactNode;
  className?: string;
}

interface RenderCtx {
  renderArtifact?: (id: string) => ReactNode;
}

function renderNodes(nodes: BodyNode[], ctx: RenderCtx, path: string): ReactNode[] {
  return nodes.map((node, i) => renderNode(node, ctx, `${path}.${i}`));
}

function renderNode(node: BodyNode, ctx: RenderCtx, key: string): ReactNode {
  if (node.type === "comment") return null;
  if (node.type === "text") return node.value;
  if (isComponent(node)) return <ComponentNode key={key} node={node} ctx={ctx} />;

  const cls = Object.hasOwn(COMPACT_TAG_CLASS, node.name)
    ? COMPACT_TAG_CLASS[node.name]
    : undefined;
  const children = renderNodes(node.children, ctx, key);

  if (node.name === "a") {
    return (
      <BodyLink key={key} href={node.attrs.href}>
        {children}
      </BodyLink>
    );
  }
  if (node.name === "img") {
    return <BodyImage key={key} src={node.attrs.src} alt={node.attrs.alt} />;
  }
  if (node.name === "code") {
    const text = rawTextOf(node.children);
    const block = text.includes("\n");
    return (
      <code key={key} className={block ? CODE_BLOCK_CLASS : CODE_INLINE_CLASS}>
        {children}
      </code>
    );
  }
  if (node.name === "table") {
    return (
      <div key={key} className="my-2 overflow-x-auto">
        <table className={COMPACT_TAG_CLASS.table}>{children}</table>
      </div>
    );
  }
  if (cls === undefined) return <span key={key}>{children}</span>;
  if (VOID_TAGS.has(node.name)) return createElement(node.name, { key, className: cls });
  return createElement(node.name, { key, className: cls }, children);
}

function ComponentNode({ node, ctx }: { node: BodyNode; ctx: RenderCtx }) {
  if (node.type !== "element") return null;

  if (node.name === "forge-diagram") {
    return <MermaidDiagram code={rawTextOf(node.children).trim()} className="my-3" />;
  }
  if (node.name === "forge-artifact" && ctx.renderArtifact && node.attrs.id) {
    return <>{ctx.renderArtifact(node.attrs.id)}</>;
  }

  return (
    <section className="my-3 rounded-md border border-line bg-surface first:mt-0">
      <header className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-3 py-2">
        <span className="fg-label text-fg">{componentLabel(node.name)}</span>
        <AttrChips attrs={node.attrs} />
      </header>
      <div className="px-3 py-2">{renderNodes(node.children, ctx, node.name)}</div>
    </section>
  );
}

export function BodyView({
  body,
  format,
  nodes,
  renderArtifact,
  className,
}: BodyViewProps): ReactNode {
  if (format !== "html") return <Markdown className={className}>{body}</Markdown>;
  if (!nodes) {
    return (
      <div className={cn("min-w-0 max-w-full", className)}>
        <p className="fg-body-sm text-muted">
          Couldn&apos;t read this body — showing its text.
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md bg-sunken p-3 font-mono text-[12.5px] text-fg">
          {body}
        </pre>
      </div>
    );
  }
  return (
    <div className={cn("min-w-0 max-w-full break-words [overflow-wrap:anywhere]", className)}>
      {renderNodes(nodes, { renderArtifact }, "body")}
    </div>
  );
}
