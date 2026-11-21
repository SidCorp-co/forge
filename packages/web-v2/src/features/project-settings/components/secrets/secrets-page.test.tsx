// The one place a person gives a secret (ISS-1348, owner 2026-11-19), from SidDesk's links of 19/11:
// the opened field had no focus, no highlight, said nothing of the value's shape, and nothing said
// the two slots already held values. Held here: a link lands on its request, highlighted and focused;
// a mailbox is given in labelled boxes and written as one JSON object, never typed as JSON; a file is
// picked; a request whose slot holds a value says so with nothing to do; the one-time command is
// minted on asking; and no secret:// reference or profile id is a main label. Layout is the screen
// witness's (`witness/secret-door.witness.tsx`).
import type { SecretRequestView, SecretSlotView, SecretSlotsRead } from "@forge/contracts/secret-slots";
import { MAILBOX_FIELDS } from "@forge/contracts/secret-slots";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore } from "@/test/render";
import { landedOn, landingOf, SecretsSettings } from "./secrets-page";

vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));

const P = "11111111-1111-4111-8111-111111111111";
const ASK = "22222222-2222-4222-8222-222222222222";
const FILLED_ASK = "33333333-3333-4333-8333-333333333333";

const slot = (over: Partial<SecretSlotView>): SecretSlotView => ({
	anchor: "slot-a",
	ref: { kind: "variable", environment: "production", key: "GOOGLE_CLIENT_SECRET" },
	label: "Google client secret",
	detail: "GOOGLE_CLIENT_SECRET",
	environment: "production",
	tier: "production",
	door: { kind: "variable", key: "GOOGLE_CLIENT_SECRET", environment: "production", variable: null },
	form: { kind: "value" },
	held: null,
	...over,
});

const MAILBOX = slot({
	anchor: "slot-m",
	ref: { kind: "testing", profile: "stg", service: "mail-support" },
	label: "Mail support",
	detail: "stg · mail-support",
	environment: null,
	tier: null,
	door: { kind: "secret", scope: "stg", name: "mail-support" },
	form: { kind: "fields", fields: [...MAILBOX_FIELDS] },
});

const request = (over: Partial<SecretRequestView>): SecretRequestView => ({
	id: ASK,
	askIds: [ASK],
	slot: slot({}),
	why: "Driver sign-in with Google needs it before the release.",
	example: "GOCSPX-…",
	askedAt: "2026-11-19T04:02:00.000Z",
	askedFor: "chuong",
	filled: null,
	...over,
});

function readOf(requests: SecretRequestView[]): SecretSlotsRead {
	return {
		requests,
		groups: [{ anchor: "app-production", kind: "app", name: "production", usedIn: [], tier: "production", slots: [slot({})] }],
		says: "",
	};
}

function renderPage(read: SecretSlotsRead, at = "") {
	window.history.replaceState(null, "", `/projects/epod/settings?tab=secrets${at}`);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY }, mutations: { retry: false } } });
	client.setQueryData(["project", P, "secret-slots"], read);
	return render(
		<QueryClientProvider client={client}>
			<SecretsSettings projectId={P} canWrite canEdit />
		</QueryClientProvider>,
	);
}

const requestNamed = (label: string) => screen.getByRole("article", { name: label });

afterEach(() => {
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/");
});

describe("a link lands on the request it names", () => {
	it("draws the request highlighted, its reason and shape, with its value box focused", async () => {
		fakeCore(() => ({ hang: true }));
		renderPage(readOf([request({})]), `&ask=${ASK}`);
		const linked = requestNamed("Google client secret");
		expect(linked).toHaveAttribute("data-linked", "true");
		expect(within(linked).getByText("From your link")).toBeInTheDocument();
		expect(linked).toHaveTextContent("Driver sign-in with Google needs it before the release.");
		expect(linked).toHaveTextContent("One value · e.g. GOCSPX-…");
		expect(linked).toHaveTextContent("Room agent · for chuong");
		await waitFor(() => expect(document.activeElement).toBe(within(linked).getByLabelText("Value")));
		expect(within(linked).getByLabelText("Value")).toHaveAttribute("type", "password");
	});

	it("lands an old Testing link on that account's request, and a link naming nothing on nothing", () => {
		const read = readOf([request({ id: ASK, slot: MAILBOX })]);
		read.groups.push({ anchor: "testing-stg", kind: "testing", name: "stg", usedIn: ["staging"], tier: null, slots: [MAILBOX] });
		expect(landedOn(read, landingOf("?tab=testing&profile=stg&service=mail-support"))).toEqual({ request: ASK, slot: null });
		expect(landedOn(read, landingOf("?tab=testing&profile=stg&actor=a&service=mail-support"))).toEqual({ request: null, slot: null });
		expect(landedOn(read, landingOf(`?tab=secrets&ask=${FILLED_ASK}`))).toEqual({ request: null, slot: null });
	});
});

describe("a value is given in one step, in a form fit for its shape", () => {
	it("writes a mailbox's labelled boxes as one JSON object at the slot's own door", async () => {
		const calls = fakeCore((c) => (c.method === "PUT" ? { body: { ref: "x", scope: "stg", name: "mail-support", updatedAt: "2026-11-19T07:00:00.000Z" } } : { hang: true }));
		renderPage(readOf([request({ slot: MAILBOX })]));
		const box = requestNamed("Mail support");
		const typed: Record<string, string> = {
			Address: "support@example.test",
			Password: "fake-mailbox-pass-0004",
			"IMAP host": "imap.example.test",
			"IMAP port": "993",
			"SMTP host": "smtp.example.test",
			"SMTP port": "465",
		};
		for (const [label, value] of Object.entries(typed)) fireEvent.change(within(box).getByLabelText(label), { target: { value } });
		expect(within(box).getByLabelText("Password")).toHaveAttribute("type", "password");
		expect(within(box).queryByRole("textbox", { name: /json/i }), "a box to type JSON into").toBeNull();
		fireEvent.click(within(box).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
		const put = calls.find((c) => c.method === "PUT");
		expect(put?.path).toBe(`/projects/${P}/secrets/stg/mail-support`);
		expect(JSON.parse((put?.body as { value: string }).value)).toEqual({
			username: "support@example.test",
			password: "fake-mailbox-pass-0004",
			imapHost: "imap.example.test",
			imapPort: "993",
			smtpHost: "smtp.example.test",
			smtpPort: "465",
		});
	});

	it("saves with an optional box left empty, writing no key for it, and not with a needed one empty (ISS-1393)", async () => {
		const calls = fakeCore((c) => (c.method === "PUT" ? { body: { ref: "x", scope: "stg", name: "proxy", updatedAt: "2026-11-21T07:00:00.000Z" } } : { hang: true }));
		const PROXY = slot({
			...MAILBOX,
			label: "Proxy pool",
			door: { kind: "secret", scope: "stg", name: "proxy" },
			form: {
				kind: "fields",
				fields: [
					{ key: "apiKey", label: "API key", secret: true },
					{ key: "endpoint", label: "Endpoint", example: "https://proxy.example.com", optional: true },
				],
			},
		});
		renderPage(readOf([request({ slot: PROXY })]));
		const box = requestNamed("Proxy pool");
		const save = within(box).getByRole("button", { name: "Save" });
		// the optional box says so in one word, the needed one says nothing
		expect(within(box).getByLabelText("Endpoint")).toHaveAccessibleDescription("Optional");
		expect(within(box).getByLabelText("API key")).not.toHaveAccessibleDescription("Optional");
		fireEvent.change(within(box).getByLabelText("Endpoint"), { target: { value: "https://proxy.example.test" } });
		expect(save, "a needed box left empty").toBeDisabled();
		fireEvent.change(within(box).getByLabelText("Endpoint"), { target: { value: " " } });
		fireEvent.change(within(box).getByLabelText("API key"), { target: { value: "fake-proxy-key-1393" } });
		expect(save).toBeEnabled();
		fireEvent.click(save);
		await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
		const put = calls.find((c) => c.method === "PUT");
		expect(JSON.parse((put?.body as { value: string }).value)).toEqual({ apiKey: "fake-proxy-key-1393" });
	});

	it("adds a production variable not held yet as a protected secret", async () => {
		const calls = fakeCore((c) => (c.method === "POST" ? { status: 201, body: {} } : { hang: true }));
		renderPage(readOf([request({})]));
		fireEvent.change(within(requestNamed("Google client secret")).getByLabelText("Value"), { target: { value: "fake-oauth-0005" } });
		fireEvent.click(within(requestNamed("Google client secret")).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
		expect(calls.find((c) => c.method === "POST")).toMatchObject({
			path: `/projects/${P}/variables`,
			body: { key: "GOOGLE_CLIENT_SECRET", environment: "production", value: "fake-oauth-0005", type: "secret", protected: true },
		});
	});

	it("reads a picked file as the value", async () => {
		const calls = fakeCore((c) => (c.method === "POST" ? { status: 201, body: {} } : { hang: true }));
		renderPage(readOf([request({ slot: slot({ form: { kind: "file" } }) })]));
		const box = requestNamed("Google client secret");
		const file = new File(['{"type":"service_account","fake":"0006"}'], "service-account.json", { type: "application/json" });
		fireEvent.change(within(box).getByLabelText("File"), { target: { files: [file] } });
		await waitFor(() => expect(within(box).getByRole("button", { name: "Save" })).toBeEnabled());
		fireEvent.click(within(box).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
		expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ value: '{"type":"service_account","fake":"0006"}', type: "file" });
	});

	it("mints the one-time command on asking, and shows it to copy", async () => {
		const calls = fakeCore((c) =>
			c.method === "POST"
				? {
						status: 201,
						body: { url: "https://forge.test/api/secret-writes/t", method: "PUT", expiresAt: "2026-11-19T07:15:00.000Z", minutes: 15, command: "curl -X PUT --data-binary @<file holding the value> 'https://forge.test/api/secret-writes/t'" },
					}
				: { hang: true },
		);
		renderPage(readOf([request({})]));
		fireEvent.click(within(requestNamed("Google client secret")).getByRole("button", { name: "Use a terminal" }));
		expect(await screen.findByTestId("secret-command")).toHaveTextContent("curl -X PUT --data-binary @secret.txt 'https://forge.test/api/secret-writes/t'");
		expect(screen.getByTestId("secret-command")).toHaveTextContent("Works once · 15 min · writes only");
		expect(calls.find((c) => c.method === "POST")?.path).toBe(`/projects/${P}/support/secrets/requests/${ASK}/write-url`);
	});
});

describe("filled is unmistakable", () => {
	it("opens a link to a filled slot on its value, when and by whom, with nothing to do and Replace beside it", () => {
		fakeCore(() => ({ hang: true }));
		const held = { at: "2026-11-19T06:12:00.000Z", by: "Chuong", via: "page" as const };
		renderPage(readOf([request({ id: FILLED_ASK, askIds: [FILLED_ASK], slot: { ...MAILBOX, held } })]), `&ask=${FILLED_ASK}`);
		const box = requestNamed("Mail support");
		expect(box).toHaveAttribute("data-linked", "true");
		expect(within(box).getByTestId("secret-request-held")).toHaveTextContent(/Has a value.*by Chuong.*Nothing needed/);
		expect(within(box).queryByRole("button", { name: "Save" }), "a form over a slot that needs nothing").toBeNull();
		fireEvent.click(within(box).getByRole("button", { name: "Replace" }));
		expect(within(box).getByLabelText("Address")).toBeInTheDocument();
	});

	it("says a value set through the command was set by command", () => {
		fakeCore(() => ({ hang: true }));
		renderPage(readOf([request({ filled: { at: "2026-11-19T06:12:00.000Z", by: null, via: "presigned" } })]));
		expect(within(requestNamed("Google client secret")).getByTestId("secret-request-held")).toHaveTextContent("by command");
	});
});

describe("labels are plain words", () => {
	it("shows no secret:// reference, and a profile or key only as secondary text", () => {
		fakeCore(() => ({ hang: true }));
		const read = readOf([request({ slot: MAILBOX })]);
		read.groups.push({ anchor: "testing-stg", kind: "testing", name: "stg", usedIn: ["staging"], tier: null, slots: [MAILBOX] });
		const { container } = renderPage(read);
		expect(container.textContent).not.toContain("secret://");
		expect(screen.getByRole("region", { name: "Test accounts · Staging" })).toBeInTheDocument();
		for (const heading of screen.getAllByRole("heading")) expect(heading.textContent).not.toMatch(/mail-support|stg\b/);
	});
});
