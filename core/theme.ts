export const THEME_IDS = [
  "light",
  "dark",
  "solarized",
  "solarized-dark",
  "midnight",
  "graphite",
  "forest",
  "rose",
] as const;

export type Theme = (typeof THEME_IDS)[number];

export function isTheme(value: unknown): value is Theme {
  return (
    typeof value === "string" &&
    THEME_IDS.includes(value as (typeof THEME_IDS)[number])
  );
}
