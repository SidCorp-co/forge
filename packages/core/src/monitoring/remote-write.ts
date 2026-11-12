/**
 * A Prometheus remote-write v1 body, read only for its labels (ISS-1225): snappy block compression
 * over the `prometheus.WriteRequest` protobuf, decoded with snappyjs and protobufjs, never by hand.
 * The door forwards the body exactly as the agent sent it; this only says whose series it holds.
 */

import protobuf from 'protobufjs';
import { uncompress } from 'snappyjs';

/** The largest decompressed body taken: Prometheus' own receiver caps a request at 32 MiB. */
const MAX_DECOMPRESSED = 32 * 1024 * 1024;

// the fields of prometheus/prompb/remote.proto and types.proto this door reads; the rest are skipped
const WriteRequest = protobuf.Root.fromJSON({
  nested: {
    Label: { fields: { name: { type: 'string', id: 1 }, value: { type: 'string', id: 2 } } },
    TimeSeries: { fields: { labels: { rule: 'repeated', type: 'Label', id: 1 } } },
    WriteRequest: { fields: { timeseries: { rule: 'repeated', type: 'TimeSeries', id: 1 } } },
  },
}).lookupType('WriteRequest');

interface Decoded {
  timeseries?: { labels?: { name?: string; value?: string }[] }[];
}

/** Each series' labels, or null where the body is not a snappy remote-write protobuf. */
export function seriesLabels(body: Uint8Array): Record<string, string>[] | null {
  try {
    const raw = uncompress(body, MAX_DECOMPRESSED);
    const decoded = WriteRequest.decode(raw) as unknown as Decoded;
    return (decoded.timeseries ?? []).map((series) =>
      Object.fromEntries((series.labels ?? []).map((l) => [l.name ?? '', l.value ?? ''])),
    );
  } catch {
    return null;
  }
}

/** The project label of every series not `slug`'s, at most `limit` of them, for the refusal. */
export function foreignProjects(
  series: readonly Record<string, string>[],
  label: string,
  slug: string,
  limit = 5,
): string[] {
  const foreign = new Set<string>();
  for (const labels of series) {
    const value = labels[label];
    if (value !== slug) foreign.add(value === undefined ? '(none)' : value);
    if (foreign.size >= limit) break;
  }
  return [...foreign];
}
