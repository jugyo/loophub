// Theme control for the app shell. Multiple themes use a compact dropdown so
// the header stays dense while keeping theme selection explicit.

import { Check, Moon, Palette, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getThemeDefinition, THEMES } from "@/lib/theme";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const activeTheme = getThemeDefinition(theme);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label="Theme"
          title={`Theme: ${activeTheme.label}`}
          className="border bg-background shadow-sm"
        >
          <Palette
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="sr-only">Theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {THEMES.map((candidate) => {
          const selected = candidate.id === theme;
          const Icon = candidate.appearance === "dark" ? Moon : Sun;

          return (
            <DropdownMenuItem
              key={candidate.id}
              onSelect={() => setTheme(candidate.id)}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "min-h-11 justify-between gap-3",
                selected && "bg-accent text-accent-foreground",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate text-sm">
                    {candidate.label}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {candidate.description}
                  </span>
                </span>
              </span>
              {selected ? (
                <Check className="size-4 shrink-0" aria-hidden="true" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
