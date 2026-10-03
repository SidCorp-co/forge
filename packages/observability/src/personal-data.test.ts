import { describe, expect, it } from "vitest";
import { scrubPersonalData } from "./personal-data.js";

const scrub = (s: string) => scrubPersonalData(s).text;

// Each name in every shape a hospital record writes it: the shape decides whether it is caught.
const NAMES = [
	"Nguyễn Văn A",
	"Nguyễn Văn An",
	"Trần Thị Bích Ngọc",
	"Lê Hoàng",
	"Phạm Minh Tuấn",
	"Đặng Thị Hồng",
	"Huỳnh Ngọc Ánh",
	"Võ Thị Sáu",
	"Bùi Xuân Phái",
	"Đỗ Quyên",
	"Dương Văn Minh",
	"Hồ Thị Kỷ",
	"Ngô Bảo Châu",
	"Trương Mỹ Lan",
];

const shapes = (n: string) => ({ title: n, upper: n.toUpperCase() });

describe("a Vietnamese name is scrubbed whole, title-case or uppercase", () => {
	for (const name of NAMES) {
		for (const [form, written] of Object.entries(shapes(name))) {
			it(`${form} "${written}" after a label, after a marker, and with none`, () => {
				for (const text of [
					`Họ tên: ${written}`,
					`Người bệnh ${written} nhập viện`,
					`bệnh nhân ${written}, 45 tuổi`,
					`TEST ${written}`,
					`Gặp ${written} hôm qua.`,
					`(${written})`,
					`"${written}"`,
					written,
				]) {
					const out = scrub(text);
					for (const syllable of written.split(" ")) {
						expect(out, `${text} → ${out}`).not.toMatch(
							new RegExp(`(?<![\\p{L}\\p{M}])${syllable}(?![\\p{L}\\p{M}])`, "u"),
						);
					}
					expect(out, text).toContain("[name]");
				}
			});
		}
	}

	it('the e2e leak: "Người bệnh NGUYỄN VĂN A" leaves nothing of the name', () => {
		expect(scrub("Người bệnh NGUYỄN VĂN A")).toBe("Người bệnh [name]");
		expect(scrub("TEST Nguyễn Văn A")).toBe("TEST [name]");
	});

	it("a name typed decomposed (NFD) is read as the same name", () => {
		expect(scrub("Bệnh nhân Nguyễn Văn An".normalize("NFD"))).toBe(
			"Bệnh nhân [name]",
		);
		expect(scrub("TEST NGUYỄN VĂN A".normalize("NFD"))).toBe("TEST [name]");
	});

	it("a name beside punctuation keeps the punctuation", () => {
		expect(scrub("Lê Văn Tám, Trần Thị Mai; Phạm Hùng.")).toBe(
			"[name], [name]; [name].",
		);
	});

	it("each name is counted once", () => {
		expect(
			scrubPersonalData("Nguyễn Văn A và TRẦN THỊ B").redactions.name,
		).toBe(2);
	});
});

describe("false-positive guards: phrases that are not people stay", () => {
	const KEPT = [
		"Bệnh Viện",
		"BỆNH VIỆN ĐA KHOA",
		"Nam Sài Gòn",
		"Bệnh viện Nam Sài Gòn",
		"Care Coordination",
		"Patient Care Coordination",
		"Hà Nội",
		"BỆNH VIỆN HÀ NỘI",
		"Hồ Chí Minh",
		"TP. Hồ Chí Minh",
		"Sở Y Tế",
		"Khoa Nội",
		"Hồ Sơ Bệnh Án",
		"HỒ SƠ BỆNH ÁN",
		"Dương Tính",
		"Kết quả: DƯƠNG TÍNH",
		"Lâm Sàng",
		"Cao Huyết Áp",
		"Triệu Chứng",
		"Lưu Ý",
		"Đào Tạo",
		"Phạm Vi",
		"Lý Do Khám",
		"Thái Lan",
		"Châu Âu",
		"Discharge Integration Sequence",
		"Post Discharge Care",
		"trần nhà",
		"Trần nhà bị dột",
		"Mai tôi tái khám",
		"tái khám 2026-10-03 lúc 08:30",
	];
	for (const text of KEPT) {
		it(`"${text}" is not a name`, () => {
			expect(scrub(text)).toBe(text);
		});
	}

	it("a place before a name does not hide the name", () => {
		expect(scrub("Hà Nội Nguyễn Văn A")).toBe("Hà Nội [name]");
	});
});

describe("the scrub is idempotent, and numbers and emails still go", () => {
	const SAMPLES = [
		"Người bệnh NGUYỄN VĂN A, SĐT 0912 345 678, a.nguyen@gmail.com",
		"Họ tên: Trần Thị Bích Ngọc; CCCD 001203004567",
		"TEST Nguyễn Văn A tại Bệnh viện Nam Sài Gòn",
		"patient John Smith, phone +84 912 345 678",
	];
	for (const text of SAMPLES) {
		it(`scrub(scrub(x)) = scrub(x) for "${text}"`, () => {
			const once = scrub(text);
			expect(scrub(once)).toBe(once);
		});
	}

	it("a phone, an id and an email are replaced; a date is kept", () => {
		const out = scrubPersonalData(
			"SĐT 0912 345 678, CCCD 001203004567, an@x.vn, ngày 2026-10-03",
		);
		expect(out.text).toBe(
			"SĐT [number], CCCD [number], [email], ngày 2026-10-03",
		);
		expect(out.redactions).toMatchObject({ number: 2, email: 1, name: 0 });
	});
});
