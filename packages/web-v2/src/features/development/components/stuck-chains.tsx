"use client";

import Link from "next/link";
import { Fragment } from "react";
import { StatusBadge } from "@/design";
import { contractHref } from "@/features/contracts/routes";
import { issueHref } from "@/features/issues/routes";
import type { OverviewChain, OverviewChainNode, OverviewStuck } from "../types";

function Node({ node, slug }: { node: OverviewChainNode; slug: string }) {
  const href = node.kind === "issue" ? issueHref(slug, node.key) : contractHref(slug, node.key);
  return (
    <div className="min-w-0" data-testid="chain-node" data-key={node.key} data-held={node.held}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <Link href={href} className="break-all font-mono text-11-5 font-semibold text-link no-underline hover:underline">
          {node.key}
        </Link>
        {node.kind === "contract" ? (
          <StatusBadge family="contractWait" value="unsettled" />
        ) : node.status ? (
          <StatusBadge family="issue" value={node.status} step={node.step} {...(node.tone ? { tone: node.tone } : {})} />
        ) : null}
      </div>
      <span className="block truncate text-12-5 text-muted" title={node.waitingOn?.rule ? `${node.title} · ${node.waitingOn.rule}` : node.title}>
        {node.title}
      </span>
    </div>
  );
}

function Chain({ chain, slug }: { chain: OverviewChain; slug: string }) {
  return (
    <li className="border-b border-line-subtle py-3 first:pt-0 last:border-b-0 last:pb-0" data-testid="stuck-chain" data-root={chain.id}>
      <div className="flex flex-wrap items-start gap-y-2">
        {chain.levels.map((level, i) => (
          <Fragment key={level.map((n) => n.key).join("|")}>
            {i > 0 ? (
              <span aria-hidden className="px-2 pt-0.5 text-12 text-[var(--paper-400)]">
                →
              </span>
            ) : null}
            <div className="flex min-w-0 max-w-[240px] flex-1 basis-[150px] flex-col gap-2">
              {level.map((n) => (
                <Node key={n.key} node={n} slug={slug} />
              ))}
            </div>
          </Fragment>
        ))}
      </div>
    </li>
  );
}

export function StuckChains({ stuck, slug }: { stuck: OverviewStuck; slug: string }) {
  if (stuck.chains.length === 0) return <p className="text-13 text-muted">Nothing is stuck.</p>;
  return (
    <ul data-testid="stuck-chains" aria-label="Stuck chains">
      {stuck.chains.map((c) => (
        <Chain key={c.id} chain={c} slug={slug} />
      ))}
    </ul>
  );
}
