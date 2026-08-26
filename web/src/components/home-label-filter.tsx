import { Check, ChevronsUpDown, Tag } from "lucide-react";
import type { Label } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LABEL_CHIP_BASE_CLASS, labelColorClass } from "@/lib/label-color";
import { cn } from "@/lib/utils";

export function HomeLabelFilter({
  labels,
  selectedLabels,
  onChange,
  disabled = false,
}: {
  labels: Label[];
  selectedLabels: string[];
  onChange: (labels: string[]) => void;
  disabled?: boolean;
}) {
  const toggleLabel = (label: string) => {
    onChange(
      selectedLabels.includes(label)
        ? selectedLabels.filter((selected) => selected !== label)
        : [...selectedLabels, label],
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          aria-label="Label filter"
          className="h-9 min-w-36 justify-between gap-2 border bg-background px-3 font-normal shadow-sm"
          disabled={disabled}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Tag
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="truncate">
              {selectedLabels.length === 0
                ? "Labels"
                : selectedLabels.length === 1
                  ? selectedLabels[0]
                  : `${selectedLabels.length} selected`}
            </span>
          </span>
          <ChevronsUpDown
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[min(20rem,calc(100vh-5rem))] w-64 overflow-y-auto"
      >
        <DropdownMenuLabel className="flex items-center justify-between gap-2">
          <span>Filter by label</span>
          {selectedLabels.length > 0 ? (
            <button
              type="button"
              aria-label="Clear label filters"
              className="font-normal text-primary hover:underline"
              onClick={() => onChange([])}
            >
              Clear
            </button>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {labels.length > 0 ? (
          labels.map((label) => {
            const selected = selectedLabels.includes(label.name);
            return (
              <DropdownMenuCheckboxItem
                key={label.name}
                checked={selected}
                className="gap-2 pl-2"
                onSelect={(event) => {
                  event.preventDefault();
                  toggleLabel(label.name);
                }}
              >
                <span
                  className={cn(
                    LABEL_CHIP_BASE_CLASS,
                    labelColorClass(label.name),
                    "max-w-56",
                  )}
                >
                  <span className="truncate">{label.name}</span>
                </span>
                <Check
                  className={cn(
                    "ml-auto size-4 shrink-0",
                    selected ? "opacity-100" : "opacity-0",
                  )}
                  aria-hidden="true"
                />
              </DropdownMenuCheckboxItem>
            );
          })
        ) : (
          <DropdownMenuItem disabled>No labels available</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
