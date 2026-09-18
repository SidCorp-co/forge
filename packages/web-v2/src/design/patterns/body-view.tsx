"use client";

// One renderer for both body formats. `markdown` goes to `<Markdown>`; `html`
// is a `forge-*` component body, and core hands the node tree over the wire
// because web-v2 has no `@forge/core` dependency and cannot parse one itself.
// There is deliberately no component name list here: `forge-diagram` and
// `forge-artifact` carry payload a generic block cannot draw and get a case
// each, and every other `forge-*` draws the same block, so a build meeting a
// component it has never heard of is ordinary rather than broken (ISS-967).

import type { BodyNode, ForgeRecordView, RecordLens } from "@forge/contracts";
import { createElement, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { BodyImage, BodyLink } from "./body-link";
import { CODE_BLOCK_CLASS, CODE_INLINE_CLASS, COMPACT_TAG_CLASS } from "./body-tags";
import { Markdown } from "./markdown";
import { RecordCard } from "./record-card";
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
  /**
   * The `forge-record` block core parsed out of this body, where it carries one.
   */
  // cm:guard this arrives PARSED and is never derived from `body` here: the same parse screened the
  // comment at the write door, and a second one in the browser could draw a record the door judged
  // differently. `at` and `to` are where the block sat, so the prose around it keeps its place.
  record?: ForgeRecordView | null;
  /** Which reading this project is drawn under; `product` where unknown. */
  recordLens?: RecordLens;
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

  // cm:guard look the tag up with `Object.hasOwn`, never with a bare index. The scanner accepts any `[A-Za-z][A-Za-z0-9-]*` name, so `<constructor>` and `<tostring>` are bodies a person can write, and a plain index reaches `Object.prototype` and emits the tag instead of unwrapping it.
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
  // cm:guard an unrecognised tag is UNWRAPPED, never dropped and never emitted: `createElement` with an author-supplied name would put arbitrary markup on the page, and dropping it loses the prose inside. Core's sanitizer already unwraps the same way, so this only ever fires on a row written before a tag left the allowlist.
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

  // cm:guard render `children` IN ORDER — do not split prose from slots and concatenate. A slot is an ordinary child, so partitioning moves a `forge-artifact` written mid-paragraph to the end of the block and silently reorders what the author wrote.
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

/** A markdown link reference definition: `[label]: https://…`, at the line's start. */
const DEFINITION_LINE = /^ {0,3}\[[^\]]+\]:\s+\S+/;
/** A fenced block's own opener, whose contents are text and not markdown. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * One half carved into the prose it draws and the reference definitions it declared.
 */
// cm:guard the carve walks lines and tracks FENCE STATE rather than running a regex over the half,
// because a definition-shaped line inside a fenced code example is the example's own text: a
// comment showing somebody how to write `[proof]: https://…` would have had that line silently
// deleted from the code block it is teaching (codex F5).
function carve(text: string): { prose: string; definitions: string[] } {
  const prose: string[] = [];
  const definitions: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const opener = FENCE_LINE.exec(line);
    if (fence !== null) {
      if (opener && line.trim().startsWith(fence)) fence = null;
      prose.push(line);
    } else if (opener) {
      fence = opener[1] as string;
      prose.push(line);
    } else if (DEFINITION_LINE.test(line)) {
      definitions.push(line);
    } else {
      prose.push(line);
    }
  }
  return { prose: prose.join("\n"), definitions };
}

/**
 * A markdown body split at the record's own extent: prose, card, prose.
 */
// cm:guard the prose either side is drawn by `<Markdown>` in its own place rather than concatenated
// around the card, and the card sits exactly where the fence sat. Moving it to the end would
// silently reorder what the writer wrote, which is the same rule `ComponentNode` states for slots.
// cm:guard splitting one markdown document in two splits its reference table with it, so each half
// gets the WHOLE table and neither keeps its own copy. CommonMark resolves a label to its FIRST
// definition, so a body defining `[proof]` above the record and again below it links to the first
// under a single parse; a half that still carried its own second definition would see it before the
// shared table and link to the second (codex F3).
function BodyWithRecord({
  body,
  record,
  lens,
  className,
}: {
  body: string;
  record: ForgeRecordView;
  lens: RecordLens;
  className?: string;
}): ReactNode {
  const before = carve(body.slice(0, record.at));
  const after = carve(body.slice(record.to));
  const declared = [...before.definitions, ...after.definitions];
  const table = declared.length > 0 ? `\n\n${declared.join("\n")}` : "";
  return (
    <div className={cn("min-w-0 max-w-full", className)}>
      {before.prose.trim() ? <Markdown>{before.prose + table}</Markdown> : null}
      <RecordCard record={record} lens={lens} />
      {after.prose.trim() ? <Markdown>{after.prose + table}</Markdown> : null}
    </div>
  );
}

export function BodyView({
  body,
  format,
  nodes,
  record,
  recordLens = "product",
  renderArtifact,
  className,
}: BodyViewProps): ReactNode {
  if (format !== "html" && record) {
    return (
      <BodyWithRecord body={body} record={record} lens={recordLens} className={className} />
    );
  }
  if (format !== "html") return <Markdown className={className}>{body}</Markdown>;
  if (!nodes) {
    // cm:guard a component body with no tree is a row THIS build's scanner could not read, and it must never fall through to `<Markdown>` — react-markdown escapes the tags and the screen shows literal `<forge-…>`, which is the exact defect ISS-967 exists to remove.
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
