// REST surface for the Update Packet artifact (Update Pipeline §3, ISS-799).
// Single POST — creates a packet, enforces the story gate, emits packet.published.
// The Master agent's consumption of packets (step 5) is out of scope here.

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { db } from "../db/client.js";
import { skillActivityTriggers } from "../db/schema.js";
import {
	type AuthVars,
	assertEmailVerified,
	requireAuth,
} from "../middleware/auth.js";
import { createUpdatePacket } from "../skills/update-packets.js";

const badRequest = (details: unknown) =>
	new HTTPException(400, {
		message: "Invalid input",
		cause: { code: "BAD_REQUEST", details },
	});

const bodySchema = z.object({
	change: z.string(),
	story: z.string().trim().min(1, "story is required"),
	intentClass: z.enum(["invariant", "procedure", "enhancement"]),
	appliesTo: z.string().min(1),
	provenance: z
		.object({
			commit: z.string().optional(),
			version: z.string().optional(),
			author: z.string().optional(),
		})
		.optional(),
	trigger: z.enum(skillActivityTriggers).default("manual"),
});

export const updatePacketRoutes = new Hono<{ Variables: AuthVars }>();
updatePacketRoutes.use("*", requireAuth(), assertEmailVerified());

updatePacketRoutes.post(
	"/",
	zValidator("json", bodySchema, (result, c) => {
		if (!result.success) throw badRequest(z.flattenError(result.error));
	}),
	async (c) => {
		const userId = c.get("userId");
		const { trigger, ...input } = c.req.valid("json");
		const packet = await createUpdatePacket(db, input, {
			actor: `human:${userId}`,
			trigger,
		});
		return c.json(packet, 201);
	},
);
