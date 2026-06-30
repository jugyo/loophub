// Deterministic colour for an issue label, derived purely from its name. The
// `Label.color` field exists in the API type but is never populated today, and
// it is a free-form string that could not be mapped to Tailwind utilities
// safely (a hex value needs a separate inline-style path). So we ALWAYS hash the
// name here: a stable, theme-readable colour for every label, with no data
// dependency. If/when explicit colours are supplied, an "explicit wins, hash
// fallback" branch can be added at the call sites — keep this function pure and
// name-only so it stays unit-testable. (#300)
//
// Tailwind v3 scans source for *literal* class strings (tailwind.config.js
// `content`), so the palette must hold full literal class strings — class names
// built at runtime (`bg-${hue}-100`) would be purged from the stylesheet. Each
// entry is readable in both themes: dark text on a light background in light
// mode, light text on a dark background under `dark:`.

// 64 entries: 16 hues × 4 shade bands. Wide enough that the hash spreads labels
// across many distinct colours; bands give within-hue variety without losing
// contrast.
const PALETTE: readonly string[] = [
  "bg-red-100 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-900",
  "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-950 dark:text-orange-300 dark:border-orange-900",
  "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900",
  "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-950 dark:text-yellow-300 dark:border-yellow-900",
  "bg-lime-100 text-lime-800 border-lime-200 dark:bg-lime-950 dark:text-lime-300 dark:border-lime-900",
  "bg-green-100 text-green-800 border-green-200 dark:bg-green-950 dark:text-green-300 dark:border-green-900",
  "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-900",
  "bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:border-teal-900",
  "bg-cyan-100 text-cyan-800 border-cyan-200 dark:bg-cyan-950 dark:text-cyan-300 dark:border-cyan-900",
  "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:border-sky-900",
  "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-900",
  "bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-900",
  "bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-900",
  "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-900",
  "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200 dark:bg-fuchsia-950 dark:text-fuchsia-300 dark:border-fuchsia-900",
  "bg-pink-100 text-pink-800 border-pink-200 dark:bg-pink-950 dark:text-pink-300 dark:border-pink-900",
  "bg-red-200 text-red-900 border-red-300 dark:bg-red-900 dark:text-red-200 dark:border-red-800",
  "bg-orange-200 text-orange-900 border-orange-300 dark:bg-orange-900 dark:text-orange-200 dark:border-orange-800",
  "bg-amber-200 text-amber-900 border-amber-300 dark:bg-amber-900 dark:text-amber-200 dark:border-amber-800",
  "bg-yellow-200 text-yellow-900 border-yellow-300 dark:bg-yellow-900 dark:text-yellow-200 dark:border-yellow-800",
  "bg-lime-200 text-lime-900 border-lime-300 dark:bg-lime-900 dark:text-lime-200 dark:border-lime-800",
  "bg-green-200 text-green-900 border-green-300 dark:bg-green-900 dark:text-green-200 dark:border-green-800",
  "bg-emerald-200 text-emerald-900 border-emerald-300 dark:bg-emerald-900 dark:text-emerald-200 dark:border-emerald-800",
  "bg-teal-200 text-teal-900 border-teal-300 dark:bg-teal-900 dark:text-teal-200 dark:border-teal-800",
  "bg-cyan-200 text-cyan-900 border-cyan-300 dark:bg-cyan-900 dark:text-cyan-200 dark:border-cyan-800",
  "bg-sky-200 text-sky-900 border-sky-300 dark:bg-sky-900 dark:text-sky-200 dark:border-sky-800",
  "bg-blue-200 text-blue-900 border-blue-300 dark:bg-blue-900 dark:text-blue-200 dark:border-blue-800",
  "bg-indigo-200 text-indigo-900 border-indigo-300 dark:bg-indigo-900 dark:text-indigo-200 dark:border-indigo-800",
  "bg-violet-200 text-violet-900 border-violet-300 dark:bg-violet-900 dark:text-violet-200 dark:border-violet-800",
  "bg-purple-200 text-purple-900 border-purple-300 dark:bg-purple-900 dark:text-purple-200 dark:border-purple-800",
  "bg-fuchsia-200 text-fuchsia-900 border-fuchsia-300 dark:bg-fuchsia-900 dark:text-fuchsia-200 dark:border-fuchsia-800",
  "bg-pink-200 text-pink-900 border-pink-300 dark:bg-pink-900 dark:text-pink-200 dark:border-pink-800",
  "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/60 dark:text-red-300 dark:border-red-800",
  "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/60 dark:text-orange-300 dark:border-orange-800",
  "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/60 dark:text-amber-300 dark:border-amber-800",
  "bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-900/60 dark:text-yellow-300 dark:border-yellow-800",
  "bg-lime-50 text-lime-700 border-lime-200 dark:bg-lime-900/60 dark:text-lime-300 dark:border-lime-800",
  "bg-green-50 text-green-700 border-green-200 dark:bg-green-900/60 dark:text-green-300 dark:border-green-800",
  "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/60 dark:text-emerald-300 dark:border-emerald-800",
  "bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-900/60 dark:text-teal-300 dark:border-teal-800",
  "bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-900/60 dark:text-cyan-300 dark:border-cyan-800",
  "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-900/60 dark:text-sky-300 dark:border-sky-800",
  "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/60 dark:text-blue-300 dark:border-blue-800",
  "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/60 dark:text-indigo-300 dark:border-indigo-800",
  "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/60 dark:text-violet-300 dark:border-violet-800",
  "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/60 dark:text-purple-300 dark:border-purple-800",
  "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-900/60 dark:text-fuchsia-300 dark:border-fuchsia-800",
  "bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-900/60 dark:text-pink-300 dark:border-pink-800",
  "bg-red-300 text-red-900 border-red-400 dark:bg-red-800 dark:text-red-100 dark:border-red-700",
  "bg-orange-300 text-orange-900 border-orange-400 dark:bg-orange-800 dark:text-orange-100 dark:border-orange-700",
  "bg-amber-300 text-amber-900 border-amber-400 dark:bg-amber-800 dark:text-amber-100 dark:border-amber-700",
  "bg-yellow-300 text-yellow-900 border-yellow-400 dark:bg-yellow-800 dark:text-yellow-100 dark:border-yellow-700",
  "bg-lime-300 text-lime-900 border-lime-400 dark:bg-lime-800 dark:text-lime-100 dark:border-lime-700",
  "bg-green-300 text-green-900 border-green-400 dark:bg-green-800 dark:text-green-100 dark:border-green-700",
  "bg-emerald-300 text-emerald-900 border-emerald-400 dark:bg-emerald-800 dark:text-emerald-100 dark:border-emerald-700",
  "bg-teal-300 text-teal-900 border-teal-400 dark:bg-teal-800 dark:text-teal-100 dark:border-teal-700",
  "bg-cyan-300 text-cyan-900 border-cyan-400 dark:bg-cyan-800 dark:text-cyan-100 dark:border-cyan-700",
  "bg-sky-300 text-sky-900 border-sky-400 dark:bg-sky-800 dark:text-sky-100 dark:border-sky-700",
  "bg-blue-300 text-blue-900 border-blue-400 dark:bg-blue-800 dark:text-blue-100 dark:border-blue-700",
  "bg-indigo-300 text-indigo-900 border-indigo-400 dark:bg-indigo-800 dark:text-indigo-100 dark:border-indigo-700",
  "bg-violet-300 text-violet-900 border-violet-400 dark:bg-violet-800 dark:text-violet-100 dark:border-violet-700",
  "bg-purple-300 text-purple-900 border-purple-400 dark:bg-purple-800 dark:text-purple-100 dark:border-purple-700",
  "bg-fuchsia-300 text-fuchsia-900 border-fuchsia-400 dark:bg-fuchsia-800 dark:text-fuchsia-100 dark:border-fuchsia-700",
  "bg-pink-300 text-pink-900 border-pink-400 dark:bg-pink-800 dark:text-pink-100 dark:border-pink-700",
];

export const LABEL_COLOR_PALETTE = PALETTE;

// Shared shape/size utilities for a label chip, so every place that renders a
// label (issue detail, list rows) stays visually identical. Pair with
// `labelColorClass(name)` for the colour. Vertical padding is intentionally
// tight (`py-px`) so the chip is not taller than the text needs — see #319;
// horizontal `px-2` keeps the text from touching the rounded edge.
// `leading-none` collapses the default ~1.5 line-height so the chip height
// tracks the glyphs (not an extra line-box band) and stays balanced against
// adjacent title text — see #375; `inline-flex items-center` centres the text
// so the tighter line-height never clips against the rounded edge, matching the
// status Badge.
export const LABEL_CHIP_BASE_CLASS =
  "inline-flex items-center rounded-full border px-2 py-px text-[11px] leading-none";

// djb2 string hash (Bernstein). Deterministic and well-distributed over short
// ASCII strings; `>>> 0` keeps it an unsigned 32-bit int so the modulo below is
// non-negative across engines.
function hash(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = (h * 33) ^ name.charCodeAt(i);
  }
  return h >>> 0;
}

/** Palette index for a label name. Stable: same name → same index. */
export function labelColorIndex(name: string): number {
  return hash(name) % PALETTE.length;
}

/**
 * Tailwind class string (background / text / border colour, light + dark) for a
 * label chip, chosen deterministically from the label name. Pair with the chip's
 * shape/size utilities at the call site (`rounded-full border px-2 …`).
 */
export function labelColorClass(name: string): string {
  return PALETTE[labelColorIndex(name)];
}
