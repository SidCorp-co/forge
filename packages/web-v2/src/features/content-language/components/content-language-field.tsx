"use client";

// Project settings → Basics → Content language: the language agents write this project's prose
// in. The value is the project document's `contentLanguage`, written at the revision read through
// PUT /api/projects/:id/content-language, which refuses a malformed tag by name.
import { useEffect, useId, useState } from "react";
import { Banner, Button, Field, Icon, Input, NativeSelect, Tooltip } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useContentLanguage, useWriteContentLanguage } from "../hooks";
import { CONTENT_LANGUAGE_CHOICES, contentLanguageName, contentLanguageProblem } from "../types";

const OTHER = "other";

export const CONTENT_LANGUAGE_HELP =
	"The language agents write this project's prose in: requirements and criteria, workflow design text, comments and notes, questionnaires and onboarding, feedback triage, suggestions, plans, summaries, release notes and assistant replies. A chat reply follows the language the person writes in. Never code, identifiers, commits, branch names, PR titles, machine-read fields or Forge's own UI: those stay English, as do technical terms such as API, webhook or deploy.";

const isChoice = (tag: string) => CONTENT_LANGUAGE_CHOICES.some((c) => c.tag === tag);

/** "checkout, storefront" → ["checkout", "storefront"]; blanks and repeats dropped. */
export function termsOf(text: string): string[] {
	return [...new Set(text.split(",").map((t) => t.trim()).filter(Boolean))];
}

export function ContentLanguageField({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
	const read = useContentLanguage(projectId);
	const write = useWriteContentLanguage(projectId);
	const held = read.data;
	const selectId = useId();

	const [choice, setChoice] = useState("en");
	const [tag, setTag] = useState("");
	const [terms, setTerms] = useState("");

	useEffect(() => {
		if (!held) return;
		setChoice(isChoice(held.contentLanguage) ? held.contentLanguage : OTHER);
		setTag(isChoice(held.contentLanguage) ? "" : held.contentLanguage);
		setTerms(held.keepTermsInEnglish.join(", "));
	}, [held]);

	if (read.error) return <Banner tone="danger">{formatApiError(read.error)}</Banner>;
	if (!held) return null;

	const wanted = choice === OTHER ? tag.trim() : choice;
	const problem = choice === OTHER && wanted !== "" ? contentLanguageProblem(wanted) : null;
	const nextTerms = termsOf(terms);
	const dirty =
		wanted !== held.contentLanguage || nextTerms.join("\n") !== held.keepTermsInEnglish.join("\n");
	const undeclared = held.revision === null;

	function save() {
		if (!dirty || held?.revision == null || wanted === "" || problem) return;
		write.mutate({
			baseRevision: held.revision,
			contentLanguage: wanted,
			keepTermsInEnglish: nextTerms.length ? nextTerms : null,
		});
	}

	return (
		<div className="space-y-4">
			<div className="flex flex-col gap-1.5">
				<div className="flex items-center gap-1.5">
					<label htmlFor={selectId} className="fg-label">
						Content language
					</label>
					<Tooltip label={CONTENT_LANGUAGE_HELP} multiline>
						<span role="img" aria-label="What the content language covers" className="text-muted">
							<Icon name="info" size={14} />
						</span>
					</Tooltip>
				</div>
				<NativeSelect
					id={selectId}
					value={choice}
					disabled={!canEdit || undeclared}
					onChange={(e) => setChoice(e.target.value)}
					options={[
						...CONTENT_LANGUAGE_CHOICES.map((c) => ({ value: c.tag, label: c.label })),
						{ value: OTHER, label: "Other (BCP-47 tag)" },
					]}
				/>
			</div>
			{choice === OTHER && (
				<Field
					label="Language tag"
					{...(problem
						? { error: problem }
						: { hint: wanted ? contentLanguageName(wanted) : "For example ja, pt-BR or zh-Hant-TW." })}
				>
					<Input
						value={tag}
						onChange={(e) => setTag(e.target.value)}
						disabled={!canEdit || undeclared}
						maxLength={35}
						placeholder="pt-BR"
					/>
				</Field>
			)}
			<Field label="Keep in English" hint="Extra terms the prose leaves untranslated, comma-separated.">
				<Input
					value={terms}
					onChange={(e) => setTerms(e.target.value)}
					disabled={!canEdit || undeclared}
					placeholder="checkout, storefront"
				/>
			</Field>
			{undeclared && (
				<Banner tone="attention">
					This project has no project document yet. Declare it on the Configuration tab to set a content
					language; until then agents write in English.
				</Banner>
			)}
			{write.error && <Banner tone="danger">{formatApiError(write.error)}</Banner>}
			{canEdit && (
				<Button
					variant="primary"
					loading={write.isPending}
					disabled={!dirty || undeclared || wanted === "" || problem !== null}
					onClick={save}
					className="min-h-11"
				>
					Save content language
				</Button>
			)}
		</div>
	);
}
