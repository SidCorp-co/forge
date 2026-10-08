import { describe, expect, it } from "vitest";
import {
	CONVERSATION_MIMES,
	conversationAcceptedList,
	conversationAttachmentType,
	conversationTypeOfFile,
} from "./attachments.js";

describe("what a conversation takes", () => {
	it("takes the documents a requirement comes from, beside pictures", () => {
		for (const mime of [
			"text/markdown",
			"text/plain",
			"text/csv",
			"application/json",
			"application/pdf",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"image/png",
		]) {
			expect(CONVERSATION_MIMES).toContain(mime);
		}
	});

	it("caps a text document far below a picture", () => {
		expect(conversationAttachmentType("text/markdown")?.maxBytes).toBe(
			2 * 1024 * 1024,
		);
		expect(conversationAttachmentType("image/png")?.maxBytes).toBe(
			10 * 1024 * 1024,
		);
	});

	it("names every accepted extension with its cap, lowered by the deployment's own ceiling", () => {
		expect(conversationAcceptedList()).toBe(
			".png, .jpg, .jpeg, .gif, .webp, .pdf or .docx up to 10 MB; .md, .markdown, .txt, .csv or .json up to 2 MB",
		);
		expect(conversationAcceptedList(1024 * 1024)).toBe(
			".png, .jpg, .jpeg, .gif, .webp, .pdf, .docx, .md, .markdown, .txt, .csv or .json up to 1 MB",
		);
	});

	it("stages a file by its extension where the browser names no type, or a wrong one", () => {
		expect(conversationTypeOfFile("spec.md", "")).toBe("text/markdown");
		expect(
			conversationTypeOfFile("criteria.csv", "application/vnd.ms-excel"),
		).toBe("text/csv");
		expect(conversationTypeOfFile("spec.md", "text/markdown")).toBe(
			"text/markdown",
		);
		expect(conversationTypeOfFile("tool.exe", "application/x-msdownload")).toBe(
			"application/x-msdownload",
		);
	});
});
