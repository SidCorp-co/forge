
// A multi-pick search field: the picks as chips inside the input, the matches in a popup list. Built
// on Base UI Combobox parts as documented (Root, InputGroup, Chips, Input, Portal, Positioner, Popup,
// List, Item); the feature supplies the items, how one is keyed and drawn, and the status line.

import { Combobox } from "@base-ui/react/combobox";
import type { ReactNode } from "react";
import { Icon } from "../icons/icon";
import { useFieldControl } from "./field";

export interface ChipPickerProps<T> {
  /** The picks so far. */
  value: T[];
  onChange: (next: T[]) => void;
  /** The matches to offer; the feature filters them (the list never filters on its own). */
  items: T[];
  itemKey: (item: T) => string;
  /** The text a screen reader reads for one item. */
  itemLabel: (item: T) => string;
  /** One item, drawn the same in a chip and in the list. */
  renderItem: (item: T) => ReactNode;
  onInputChange: (text: string) => void;
  ariaLabel: string;
  placeholder?: string;
  removeLabel: (item: T) => string;
  /** Keep the latest pick only. */
  single?: boolean;
  /** A line above the list: searching, nothing matched. */
  status?: ReactNode;
  /** A refusal drawn above the list. */
  error?: ReactNode;
  id?: string;
}

export function ChipPicker<T>({
  value,
  onChange,
  items,
  itemKey,
  itemLabel,
  renderItem,
  onInputChange,
  ariaLabel,
  placeholder,
  removeLabel,
  single = false,
  status,
  error,
  id,
}: ChipPickerProps<T>) {
  const field = useFieldControl();
  return (
    <Combobox.Root
      multiple
      items={items}
      value={value}
      filter={null}
      itemToStringLabel={itemLabel}
      isItemEqualToValue={(a: T, b: T) => itemKey(a) === itemKey(b)}
      onValueChange={(next: T[]) => onChange(single ? next.slice(-1) : next)}
      onInputValueChange={(next) => onInputChange(next)}
    >
      <Combobox.InputGroup className="flex min-h-9 w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-line-strong bg-surface px-2 py-1 focus-within:border-link focus-within:shadow-focus">
        <Combobox.Chips className="flex w-full flex-wrap items-center gap-1">
          {value.map((item) => (
            <Combobox.Chip
              key={itemKey(item)}
              aria-label={itemLabel(item)}
              className="flex max-w-full min-w-0 items-center gap-1.5 rounded-sm bg-sunken py-0.5 pr-0.5 pl-1.5 text-13 text-fg outline-none data-highlighted:bg-hover"
            >
              {renderItem(item)}
              <Combobox.ChipRemove
                aria-label={removeLabel(item)}
                className="flex size-5 flex-none items-center justify-center rounded-sm text-subtle hover:bg-hover hover:text-fg"
              >
                <Icon name="x" size={12} />
              </Combobox.ChipRemove>
            </Combobox.Chip>
          ))}
          <Combobox.Input
            id={id ?? field.id}
            aria-label={ariaLabel}
            placeholder={value.length > 0 && single ? "" : placeholder}
            className="h-7 min-w-24 flex-1 border-0 bg-transparent p-0 text-14 text-fg outline-none placeholder:text-disabled md:text-13"
          />
        </Combobox.Chips>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner className="z-50 outline-none" sideOffset={4}>
          <Combobox.Popup className="max-h-80 w-(--anchor-width) max-w-(--available-width) overflow-y-auto rounded-md border border-line bg-surface py-1 text-fg shadow-overlay">
            <Combobox.Status className="block px-3 py-1.5 text-12 text-subtle">{status}</Combobox.Status>
            {error}
            <Combobox.List className="divide-y divide-line-subtle">
              {(item: T) => (
                <Combobox.Item
                  key={itemKey(item)}
                  value={item}
                  className="flex min-w-0 cursor-default items-baseline gap-2 px-3 py-2 text-13 outline-none select-none data-highlighted:bg-hover"
                >
                  {renderItem(item)}
                  <Combobox.ItemIndicator className="ml-auto flex-none text-accent">
                    <Icon name="check" size={13} />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
