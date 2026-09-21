import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** The `text-<step>` suffixes of the ramp `@theme` declares in `src/app/globals.css`.
 *  tailwind-merge does not read `@theme`, so without this every step falls through to
 *  the text-COLOUR group and a size is deleted by a colour beside it (ISS-1119). */
export const TEXT_RAMP_STEPS = [
	"8-5",
	"9",
	"9-5",
	"10",
	"11",
	"11-5",
	"12",
	"12-5",
	"13",
	"13-5",
	"14",
	"15",
	"16",
	"20",
	"22",
	"34",
] as const;

const twMerge = extendTailwindMerge({
	extend: { classGroups: { "font-size": [{ text: [...TEXT_RAMP_STEPS] }] } },
});

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
