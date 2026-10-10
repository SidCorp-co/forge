"use client";

// /dev/design, second half: the blocks, the five page templates with their slots filled by blocks,
// and the overlays.

import { useState } from "react";
import {
  BoardPage,
  Button,
  ConfirmDialog,
  DetailPage,
  Dialog,
  EmptyState,
  ErrorState,
  Fact,
  FactsGroup,
  FactsRail,
  FormActions,
  InPlaceTopBar,
  Input,
  KanbanCard,
  KanbanColumn,
  ListPage,
  ListSearch,
  LoadingState,
  Property,
  PropertyList,
  ReportPage,
  RowItem,
  RowList,
  Section,
  SettingRow,
  SettingsGroup,
  SettingsPage,
  SlideOver,
  StatCell,
  StatRow,
  StatusBadge,
  Toggle,
  ToolbarSelect,
} from "@/design";
import { Group } from "./gallery-tokens";

const ROWS = [
  { key: "ISS-1372", title: "MCP wraps the API", status: "in_progress", age: "2h" },
  { key: "ISS-1330", title: "Two installs take turns", status: "needs_info", age: "1d" },
  { key: "ISS-1156", title: "The console says what it has not read", status: "closed", age: "3d" },
] as const;

function SampleRows() {
  return (
    <RowList>
      {ROWS.map((r) => (
        <RowItem key={r.key} lead={<span className="font-mono text-12 text-link">{r.key}</span>} title={r.title} facts={[r.age]} trailing={<StatusBadge family="issue" value={r.status} />} />
      ))}
    </RowList>
  );
}

/** The gallery's own demo frame, never a block's look: a label line, then a faint dashed outline. */
function Frame({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <figure className="mb-8">
      <figcaption className="mb-2 flex items-center gap-2 font-mono text-12 text-subtle">
        <span className="text-11 uppercase tracking-wider">demo</span>
        <span>{name}</span>
      </figcaption>
      <div className="max-h-96 overflow-auto border border-dashed border-line-subtle p-4">{children}</div>
    </figure>
  );
}

export function BlockGallery() {
  const [search, setSearch] = useState("");
  const [on, setOn] = useState(true);
  return (
    <Group title="Blocks">
      <Frame name="RowList · RowItem">
        <SampleRows />
      </Frame>
      <Frame name="Section · PropertyList">
        <div>
          <Section title="Delivery" right={<Button variant="ghost">Edit</Button>}>
            <PropertyList>
              <Property label="Owner">Platform</Property>
              <Property label="State">
                <StatusBadge family="requirement" value="agreed" />
              </Property>
            </PropertyList>
          </Section>
        </div>
      </Frame>
      <Frame name="StatRow · StatCell">
        <StatRow>
          <StatCell label="Open" value="42" />
          <StatCell label="Waiting on you" value="3" tone="you" />
          <StatCell label="Failed today" value="1" tone="err" />
        </StatRow>
      </Frame>
      <Frame name="SettingsGroup · SettingRow · FormActions">
        <div>
          <SettingsGroup title="Releases">
            <SettingRow label="Name" htmlFor="g-name" hint="Shown on the board" control={<Input id="g-name" value={search} onChange={(e) => setSearch(e.target.value)} />} />
            <SettingRow label="Auto-release" inline control={<Toggle checked={on} onChange={setOn} aria-label="Auto-release" />} />
          </SettingsGroup>
          <FormActions>
            <Button variant="primary">Save</Button>
          </FormActions>
        </div>
      </Frame>
      <Frame name="FactsRail · FactsGroup · Fact">
        <FactsRail>
          <FactsGroup title="Properties">
            <Fact label="Priority">High</Fact>
            <Fact label="Module">core-jobs</Fact>
          </FactsGroup>
        </FactsRail>
      </Frame>
      <Frame name="EmptyState · LoadingState · ErrorState">
        <div className="grid sm:grid-cols-3">
          <EmptyState title="No issues" message="Nothing is open." mascot={false} />
          <LoadingState rows={3} label="Reading issues" />
          <ErrorState message="Core did not answer. Retry in a moment." mascot={false} onRetry={() => undefined} />
        </div>
      </Frame>
    </Group>
  );
}

export function TemplateGallery() {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("age");
  const rail = (
    <FactsRail>
      <FactsGroup title="Properties">
        <Fact label="Owner">Platform</Fact>
      </FactsGroup>
    </FactsRail>
  );
  return (
    <Group title="Page templates">
      <InPlaceTopBar>
        <Frame name="ListPage — title · actions · toolbar · peek · children">
          <ListPage
            title="Issues"
            actions={<Button variant="primary" icon="plus">New issue</Button>}
            toolbar={
              <>
                <ListSearch noun="issues" value={q} onChange={setQ} />
                <ToolbarSelect label="Sort" value={sort} onChange={setSort} options={[{ value: "age", label: "Age" }, { value: "key", label: "Key" }]} />
              </>
            }
          >
            <SampleRows />
          </ListPage>
        </Frame>
        <Frame name="DetailPage — header · rail · lead · tabs · children">
          <DetailPage header={<div className="border-b border-line-subtle px-8 py-3 fg-h3">ISS-1372 · MCP wraps the API</div>} rail={rail} label="Overview">
            <Section title="Outcome">
              <p className="text-14">Every MCP tool calls the REST route it mirrors.</p>
            </Section>
          </DetailPage>
        </Frame>
        <Frame name="SettingsPage — title · nav · children">
          <SettingsPage title="Project settings" nav={<a className="text-13 text-link" href="#releases">Releases</a>}>
            <SettingsGroup id="releases" title="Releases">
              <SettingRow label="Branch" control={<Input defaultValue="main" />} />
            </SettingsGroup>
          </SettingsPage>
        </Frame>
        <Frame name="BoardPage — title · toolbar · children">
          <div className="h-80">
            <BoardPage title="Pipeline">
              <KanbanColumn title="Code" color="var(--stage-code)" count={1} emptyHint="Nothing here">
                <KanbanCard id="ISS-1372" title="MCP wraps the API" badge={<StatusBadge family="run" value="running" stage="code" />} />
              </KanbanColumn>
              <KanbanColumn title="Review" color="var(--stage-review)" count={0} emptyHint="Nothing here" />
            </BoardPage>
          </div>
        </Frame>
        <Frame name="ReportPage — title · toolbar · stats · children">
          <ReportPage
            title="Delivery"
            stats={
              <StatRow>
                <StatCell label="Closed" value="18" />
                <StatCell label="Median lead time" value="6h" />
              </StatRow>
            }
          >
            <Section title="Closed per day">
              <p className="text-13 text-muted">A chart in ChartContainer sits here.</p>
            </Section>
          </ReportPage>
        </Frame>
      </InPlaceTopBar>
    </Group>
  );
}

export function OverlayGallery() {
  const [open, setOpen] = useState<null | "dialog" | "confirm" | "slide">(null);
  return (
    <Group title="Overlays">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setOpen("dialog")}>Dialog</Button>
        <Button variant="secondary" onClick={() => setOpen("confirm")}>ConfirmDialog</Button>
        <Button variant="secondary" onClick={() => setOpen("slide")}>SlideOver</Button>
      </div>
      <Dialog open={open === "dialog"} onOpenChange={(o) => setOpen(o ? "dialog" : null)} title="Rename project" footer={<Button variant="primary" onClick={() => setOpen(null)}>Save</Button>}>
        <Input defaultValue="forge" aria-label="Name" />
      </Dialog>
      <ConfirmDialog open={open === "confirm"} title="Delete the key?" message="Runs using it stop at once." confirmLabel="Delete" tone="danger" onConfirm={() => setOpen(null)} onClose={() => setOpen(null)} />
      <SlideOver open={open === "slide"} onClose={() => setOpen(null)} title="New issue">
        <p className="text-14">A longer side task, with the page still in view.</p>
      </SlideOver>
    </Group>
  );
}
