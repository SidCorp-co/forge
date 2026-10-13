
// /dev/design, first half: every token and every primitive, as the code renders them.

import { useState } from "react";
import {
  Avatar,
  Banner,
  Button,
  Checkbox,
  Disclosure,
  EnumBadge,
  Field,
  IconButton,
  Input,
  Kbd,
  MonoTag,
  ProgressBar,
  Radio,
  RadioGroup,
  SegmentedControl,
  Select,
  Skeleton,
  Spinner,
  StatusBadge,
  Tabs,
  Textarea,
  Toggle,
  Tooltip,
} from "@/design";

const SCALES = ["neutral", "accent", "ok", "warn", "danger", "info", "muted", "ai"] as const;
const STEPS = Array.from({ length: 12 }, (_, i) => i + 1);
const SEMANTIC = [
  "bg-app", "bg-surface", "bg-sunken", "bg-hover", "bg-active",
  "border-subtle", "border-default", "border-strong",
  "fg-default", "fg-muted", "fg-subtle", "fg-disabled",
  "accent", "accent-hover", "accent-text", "link", "focus-ring",
  "status-ok-solid", "status-warn-solid", "status-danger-solid", "status-info-solid", "status-muted-solid",
] as const;
const TYPE = [
  ["fg-h1", "24 / 32 · Page title"],
  ["fg-h2", "20 / 28 · Section title"],
  ["fg-h3", "16 / 24 · Group title"],
  ["fg-body", "14 / 20 · Body"],
  ["fg-body-sm", "13 / 18 · Row text"],
  ["fg-caption", "12 / 16 · Caption"],
  ["fg-mono", "13 / 18 · ISS-1372 · a1b2c3d"],
] as const;

export function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line-subtle py-6 first:border-t-0">
      <h2 className="fg-h2 mb-4">{title}</h2>
      {children}
    </section>
  );
}

function Item({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-row flex-wrap items-center gap-3 border-b border-line-subtle py-2 last:border-b-0">
      <code className="w-40 flex-none font-mono text-12 text-muted">{name}</code>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function TokenGallery() {
  return (
    <>
      <Group title="Scales">
        <div className="overflow-x-auto">
          {SCALES.map((s) => (
            <div key={s} className="flex items-center gap-1 py-0.5">
              <code className="w-16 flex-none font-mono text-12 text-muted">{s}</code>
              {STEPS.map((n) => (
                <span key={n} title={`--${s}-${n}`} className="h-8 w-10 flex-none" style={{ background: `var(--${s}-${n})` }} />
              ))}
            </div>
          ))}
          <div className="flex gap-1 pl-17 font-mono text-12 text-subtle">
            {STEPS.map((n) => (
              <span key={n} className="w-10 flex-none text-center">
                {n}
              </span>
            ))}
          </div>
        </div>
      </Group>
      <Group title="Semantic">
        <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-3 lg:grid-cols-4">
          {SEMANTIC.map((v) => (
            <div key={v} className="flex h-row items-center gap-2">
              <span className="size-5 flex-none border border-line-subtle" style={{ background: `var(--${v})` }} />
              <code className="truncate font-mono text-12 text-muted">--{v}</code>
            </div>
          ))}
        </div>
      </Group>
      <Group title="Type">
        {TYPE.map(([cls, sample]) => (
          <Item key={cls} name={cls}>
            <span className={cls}>{sample}</span>
          </Item>
        ))}
      </Group>
      <Group title="Shape and density">
        <Item name="rounded-none">
          <span className="h-10 w-24 border border-line bg-surface" />
          <span className="text-13 text-muted">surfaces</span>
        </Item>
        <Item name="rounded-sm · md">
          <span className="h-8 w-20 rounded-sm border border-line-strong bg-surface" />
          <span className="h-8 w-20 rounded-md border border-line-strong bg-surface" />
          <span className="text-13 text-muted">controls</span>
        </Item>
        <Item name="shadow-overlay">
          <span className="h-12 w-32 border border-line bg-surface shadow-overlay" />
          <span className="text-13 text-muted">overlays only</span>
        </Item>
        <Item name="h-row">
          <span className="flex h-row w-64 items-center border-y border-line-subtle px-2 text-13">36px, 44px on touch</span>
        </Item>
      </Group>
    </>
  );
}

export function PrimitiveGallery() {
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState<"list" | "board">("list");
  const [tab, setTab] = useState("overview");
  const [pick, setPick] = useState("high");
  const [radio, setRadio] = useState("a");
  return (
    <Group title="Primitives">
      <Item name="Button">
        <Button variant="primary" icon="plus">Create</Button>
        <Button variant="secondary">Cancel</Button>
        <Button variant="ghost">More</Button>
        <Button variant="danger">Delete</Button>
        <Button loading>Saving</Button>
      </Item>
      <Item name="IconButton">
        <IconButton icon="settings" aria-label="Settings" />
        <IconButton icon="more" aria-label="More" size="sm" />
      </Item>
      <Item name="Input · Textarea">
        <Input icon="search" placeholder="Search issues" className="w-56" />
        <Textarea rows={2} placeholder="A note" className="w-56" />
      </Item>
      <Item name="Select">
        <Select aria-label="Priority" value={pick} onChange={setPick} options={[{ value: "high", label: "High" }, { value: "low", label: "Low" }]} className="w-40" />
      </Item>
      <Item name="Checkbox · Radio · Toggle">
        <Checkbox checked={on} onChange={setOn} label="Notify me" />
        <RadioGroup name="g" value={radio} onChange={setRadio} className="flex gap-3">
          <Radio value="a" label="One" />
          <Radio value="b" label="Two" />
        </RadioGroup>
        <Toggle checked={on} onChange={setOn} aria-label="Enabled" />
      </Item>
      <Item name="SegmentedControl">
        <SegmentedControl options={[{ value: "list", label: "List", icon: "list" }, { value: "board", label: "Board", icon: "board" }]} value={seg} onChange={setSeg} />
      </Item>
      <Item name="Tabs">
        <Tabs tabs={[{ value: "overview", label: "Overview" }, { value: "runs", label: "Runs", count: 4 }]} value={tab} onChange={setTab} />
      </Item>
      <Item name="StatusBadge">
        <StatusBadge family="issue" value="in_progress" />
        <StatusBadge family="issue" value="needs_info" />
        <StatusBadge family="issue" value="closed" />
        <StatusBadge family="run" value="running" stage="code" />
        <StatusBadge family="run" value="failed" />
        <StatusBadge family="requirement" value="agreed" />
      </Item>
      <Item name="EnumBadge">
        <EnumBadge family="priority" value="high" />
        <EnumBadge family="category" value="bug" />
      </Item>
      <Item name="MonoTag · Avatar · Kbd">
        <MonoTag>ISS-1372</MonoTag>
        <Avatar initials="AJ" />
        <Kbd>⌘K</Kbd>
      </Item>
      <Item name="Tooltip">
        <Tooltip label="Opens the run">
          <Button variant="secondary">Hover me</Button>
        </Tooltip>
      </Item>
      <Item name="Spinner · Skeleton · ProgressBar">
        <Spinner />
        <Skeleton variant="text" className="w-32" />
        <ProgressBar value={0.6} className="w-40" />
      </Item>
      <Item name="Banner">
        <div className="w-full">
          <Banner tone="attention">Two runs wait on you.</Banner>
        </div>
      </Item>
      <Item name="Field">
        <div className="w-72">
          <Field label="Name" hint="Shown on the board" error="Name is taken">
            <Input defaultValue="forge" />
          </Field>
        </div>
      </Item>
      <Item name="Disclosure">
        <div className="w-full">
          <Disclosure title="Agent plan" count={3} summary="Three steps, one done">
            <p className="text-13">The plan reads here once opened.</p>
          </Disclosure>
        </div>
      </Item>
    </Group>
  );
}
