// Theme control that switches between light and dark themes. A compact segmented toggle:
// Sun / Moon icons in a pill, the active theme's side highlighted. With only two themes,
// selecting the inactive side is just a toggle, so it reuses useTheme().toggle as-is.

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";

  // Two themes only: picking the side that is not currently active is equivalent to a toggle;
  // clicking the already-active side is a no-op.
  const select = (target: "light" | "dark") => {
    if ((target === "dark") !== isDark) toggle();
  };

  const item =
    "inline-flex size-7 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  const active = "bg-accent text-accent-foreground";
  const inactive =
    "text-muted-foreground hover:bg-accent hover:text-accent-foreground";

  return (
    <div
      role="group"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-md border p-0.5"
    >
      <button
        type="button"
        onClick={() => select("light")}
        aria-pressed={!isDark}
        title="Light theme"
        aria-label="Light theme"
        className={cn(item, isDark ? inactive : active)}
      >
        <Sun className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => select("dark")}
        aria-pressed={isDark}
        title="Dark theme"
        aria-label="Dark theme"
        className={cn(item, isDark ? active : inactive)}
      >
        <Moon className="size-4" />
      </button>
    </div>
  );
}
