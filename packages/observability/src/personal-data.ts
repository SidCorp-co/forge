import { scrubLogText } from "./index.js";

/** What a redaction replaced, by kind; `secret` counts lines the secret scrubber changed. */
export type PersonalDataKind = "email" | "number" | "name" | "secret";

export interface PersonalDataScrub {
	text: string;
	redactions: Record<PersonalDataKind, number>;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// cm:why a run of 9 to 19 digits, spaced or dashed, is a phone, national id or card number; a date
// or a time holds at most 8 digits, so it is left alone
const DIGIT_RUN = /\+?\d[\d .-]{6,}\d/g;
const MIN_DIGITS = 9;
const MAX_DIGITS = 19;

const NAME_LABELS = [
	"name",
	"full name",
	"patient",
	"patient name",
	"bệnh nhân",
	"tên",
	"họ tên",
	"họ và tên",
	"người bệnh",
	"bn",
];

// cm:why a labelled field ("Họ tên: …", "patient: …") names a person up to the end of its clause;
// one already scrubbed is left as it is, so a second scrub changes nothing
const LABELLED = new RegExp(
	`(^|[\\s(\\[,;])((?:${NAME_LABELS.join("|")})\\s*[:=]\\s*)(?!\\s*\\[name\\])([^\\n,;)\\]]+)`,
	"giu",
);

// A capitalised word, title-case or uppercase, whole: diacritics are letters or combining marks,
// so "NGUYỄN" is one word and never four.
const WORD = "\\p{Lu}\\p{M}*[\\p{L}\\p{M}]*";
const GAP = "[^\\S\\n]+";
const NOT_AFTER_LETTER = "(?<![\\p{L}\\p{M}\\d_])";
const NOT_BEFORE_LETTER = "(?![\\p{L}\\p{M}])";

// cm:why "bệnh nhân Nguyễn Văn An" / "Người bệnh NGUYỄN VĂN A" / "patient John Smith": two to four
// capitalised words after the noun that marks a patient. "Patient" capitalised opens headings
// ("Patient Care Coordination"), so the English marker counts only in lower case.
const MARKED = new RegExp(
	`(^|[\\s(\\[,;])((?:[bB]ệnh nhân|[nN]gười bệnh|patient|BN)${GAP})(${WORD}(?:${GAP}${WORD}){1,3})${NOT_BEFORE_LETTER}`,
	"gu",
);

// The most common Vietnamese surnames, together about nine in ten people.
const SURNAMES = [
	"Nguyễn", "Trần", "Lê", "Phạm", "Hoàng", "Huỳnh", "Phan", "Vũ", "Võ", "Đặng",
	"Bùi", "Đỗ", "Hồ", "Ngô", "Dương", "Lý", "Đinh", "Đoàn", "Trịnh", "Trương",
	"Lâm", "Mai", "Đào", "Cao", "Hà", "Lưu", "Tạ", "Châu", "Tô", "Vương",
	"Phùng", "Quách", "Lương", "Thái", "Kiều", "Diệp", "Triệu", "Lục", "Khúc", "Ông",
].flatMap((s) => [s, s.toUpperCase()]);

// cm:why a place, or a common term, that opens with a surname is not a person: matched on the
// surname and the word after it, in either case
const NOT_A_NAME = new Set(
	[
		"Hà Nội", "Hà Giang", "Hà Nam", "Hà Tĩnh", "Hà Đông", "Hà Tiên",
		"Hồ Chí", "Hồ Sơ", "Hồ Gươm", "Hồ Tây",
		"Lâm Đồng", "Lâm Sàng",
		"Cao Bằng", "Cao Cấp", "Cao Huyết", "Cao Đẳng", "Cao Điểm", "Cao Su",
		"Thái Bình", "Thái Nguyên", "Thái Lan", "Thái Độ",
		"Châu Âu", "Châu Á", "Châu Phi", "Châu Mỹ", "Châu Đốc", "Châu Thành",
		"Phan Thiết", "Phan Rang",
		"Lý Do", "Lý Lịch", "Lý Thuyết", "Lý Sơn",
		"Đào Tạo", "Dương Tính", "Dương Lịch", "Phạm Vi", "Trương Lực",
		"Lưu Ý", "Lưu Trữ", "Lưu Lượng", "Lương Tháng", "Lương Cơ", "Lương Thưởng",
		"Triệu Chứng", "Ông Bà",
	].map((p) => p.toUpperCase()),
);

// cm:why an unlabelled name is a known surname and one to three more capitalised words; see the
// trade-off on scrubPersonalData
const UNLABELLED = new RegExp(
	`${NOT_AFTER_LETTER}(?:${SURNAMES.join("|")})(?:${GAP}${WORD}){1,3}${NOT_BEFORE_LETTER}`,
	"gu",
);

function scrubUnlabelled(text: string, onName: () => void): string {
	let out = "";
	let last = 0;
	UNLABELLED.lastIndex = 0;
	for (let m = UNLABELLED.exec(text); m; m = UNLABELLED.exec(text)) {
		const [surname = "", first = ""] = m[0].split(/[^\S\n]+/u);
		if (NOT_A_NAME.has(`${surname} ${first}`.toUpperCase())) {
			UNLABELLED.lastIndex = m.index + surname.length;
			continue;
		}
		onName();
		out += text.slice(last, m.index) + PERSONAL_DATA_PLACEHOLDER.name;
		last = m.index + m[0].length;
	}
	return out + text.slice(last);
}

export const PERSONAL_DATA_PLACEHOLDER = {
	email: "[email]",
	number: "[number]",
	name: "[name]",
} as const;

/**
 * Redacts personal data a sensitive project must not store or send to a provider: email
 * addresses, phone / id / card numbers, labelled, patient-marked and surname-led names, and every
 * secret shape `scrubLogText` knows. Text is read in NFC, so a name typed decomposed is one word.
 *
 * Trade-off, chosen: an unlabelled name is recognised only when it opens with one of the common
 * surnames above, title-case or uppercase, followed by one to three capitalised words. A name with
 * a rarer surname still passes unscrubbed, and a capitalised phrase opening with a surname (a
 * street such as Lê Lợi, a clinic named for its founder) is scrubbed unless `NOT_A_NAME` lists it:
 * over-scrubbing loses a word, leaking loses a patient.
 */
export function scrubPersonalData(input: string): PersonalDataScrub {
	const redactions: Record<PersonalDataKind, number> = {
		email: 0,
		number: 0,
		name: 0,
		secret: 0,
	};
	const normalised = input.normalize("NFC");
	const secretsOut = scrubLogText(normalised);
	if (secretsOut !== normalised) {
		const before = normalised.split("\n");
		redactions.secret = secretsOut
			.split("\n")
			.filter((line, i) => line !== before[i]).length;
	}
	let text = secretsOut.replace(EMAIL, () => {
		redactions.email += 1;
		return PERSONAL_DATA_PLACEHOLDER.email;
	});
	text = text.replace(LABELLED, (_m, lead: string, label: string) => {
		redactions.name += 1;
		return `${lead}${label}${PERSONAL_DATA_PLACEHOLDER.name}`;
	});
	text = text.replace(MARKED, (_m, lead: string, marker: string) => {
		redactions.name += 1;
		return `${lead}${marker}${PERSONAL_DATA_PLACEHOLDER.name}`;
	});
	text = scrubUnlabelled(text, () => {
		redactions.name += 1;
	});
	text = text.replace(DIGIT_RUN, (run) => {
		const digits = run.replace(/\D/g, "").length;
		if (digits < MIN_DIGITS || digits > MAX_DIGITS) return run;
		redactions.number += 1;
		return PERSONAL_DATA_PLACEHOLDER.number;
	});
	return { text, redactions };
}

/** How many things a scrub replaced. */
export const redactionCount = (r: Record<PersonalDataKind, number>) =>
	r.email + r.number + r.name + r.secret;
