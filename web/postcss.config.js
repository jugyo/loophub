import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the Tailwind config by absolute path so PostCSS finds it regardless of cwd.
// `lh-web` runs from the repo root (cwd != web/), so Tailwind's default cwd-based config
// lookup would miss web/tailwind.config.js and silently fall back to its defaults.
const here = dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    tailwindcss: { config: join(here, "tailwind.config.js") },
    autoprefixer: {},
  },
};
