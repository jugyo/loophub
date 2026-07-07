import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import animate from "tailwindcss-animate";

// Absolute content globs: `lh-web` runs from the repo root, so cwd-relative globs would
// scan the wrong tree and emit no utilities for the SPA.
const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [join(here, "index.html"), join(here, "src/**/*.{ts,tsx}")],
  theme: {
    extend: {
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      maxWidth: {
        content: "60rem",
        // Wider cap for the two-column PR detail (main + sidebar), so the diff
        // column keeps room once the Sessions sidebar takes its share (#346).
        "content-wide": "80rem",
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          hover: "hsl(var(--primary-hover))",
          active: "hsl(var(--primary-active))",
          subtle: "hsl(var(--primary-subtle))",
          border: "hsl(var(--primary-border))",
          foreground: "hsl(var(--primary-foreground))",
        },
        link: "hsl(var(--link))",
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
    },
  },
  plugins: [animate],
};
