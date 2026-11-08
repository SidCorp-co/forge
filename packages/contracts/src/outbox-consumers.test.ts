// ISS-822 (REQ-12 BC-18): `source.merged` was emitted by three adapters with `OUTBOX_CONSUMERS`
// naming nobody for it since ISS-774, and no gate refused it, so dead events accumulated in silence.
// Every event type the registry names has a consumer, or it is not an event.
//
// @direct-test-of packages/contracts/src/outbox-consumers.ts
// @direct-test-of packages/contracts/src/outbox-events.ts

import { describe, expect, it } from "vitest";
import { OUTBOX_CONSUMERS } from "./outbox-consumers.js";
import { OUTBOX_EVENT_TYPES } from "./outbox-events.js";

describe("an outbox event type has a consumer", () => {
	// read as data, as the workers read it: the type already refuses an empty list where it is written
	const consumers: Readonly<Record<string, readonly string[] | undefined>> = OUTBOX_CONSUMERS;

	it("names none that no consumer reads", () => {
		const unread = OUTBOX_EVENT_TYPES.filter((t) => (consumers[t] ?? []).length === 0);
		expect(unread, `emitted with no consumer: ${unread.join(", ")}; stop emitting each and remove it from OUTBOX_EVENT_TYPES`).toEqual([]);
	});

	it("declares the consumers of every type it names, and of no type it does not", () => {
		expect(Object.keys(consumers).sort()).toEqual([...OUTBOX_EVENT_TYPES].sort());
	});
});
