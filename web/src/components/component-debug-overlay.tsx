import { Check, Copy, ScanSearch } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const DEBUG_COMPONENT_ATTRIBUTE = "data-debug-component";

let debugModeEnabled = false;
const debugModeListeners = new Set<() => void>();

function subscribeToDebugMode(listener: () => void) {
  debugModeListeners.add(listener);
  return () => debugModeListeners.delete(listener);
}

export function setComponentDebugMode(enabled: boolean) {
  debugModeEnabled = enabled;
  for (const listener of debugModeListeners) listener();
}

function useDebugMode() {
  return useSyncExternalStore(
    subscribeToDebugMode,
    () => debugModeEnabled,
    () => false,
  );
}

export function ComponentDebugToggle() {
  const enabled = useDebugMode();

  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      aria-label="Component debug mode"
      aria-pressed={enabled}
      title={`Component debug mode: ${enabled ? "on" : "off"}`}
      data-debug-component="ComponentDebugToggle"
      onClick={() => setComponentDebugMode(!enabled)}
      className={cn(
        "border bg-background shadow-sm",
        enabled &&
          "border-red-600 bg-red-500/15 text-red-700 hover:bg-red-500/25 dark:text-red-300",
      )}
    >
      <ScanSearch className="size-4" aria-hidden="true" />
      <span className="sr-only">Component debug mode</span>
    </Button>
  );
}

interface DebugBox {
  element: HTMLElement;
  name: string;
  rect: DOMRect;
}

function findDebugTargets(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[${DEBUG_COMPONENT_ATTRIBUTE}]`),
  );
}

export function ComponentDebugOverlay() {
  const enabled = useDebugMode();
  const [boxes, setBoxes] = useState<DebugBox[]>([]);

  useEffect(() => {
    if (!enabled) {
      setBoxes([]);
      return;
    }

    let frame = 0;
    let targets: HTMLElement[] = [];
    const resizeObserver = new ResizeObserver(() => scheduleRefresh());

    function refresh() {
      frame = 0;
      const nextTargets = findDebugTargets();
      if (
        nextTargets.length !== targets.length ||
        nextTargets.some((target, index) => target !== targets[index])
      ) {
        resizeObserver.disconnect();
        targets = nextTargets;
        for (const target of targets) resizeObserver.observe(target);
      }
      setBoxes(
        targets.flatMap((element) => {
          const name = element.getAttribute(DEBUG_COMPONENT_ATTRIBUTE);
          const rect = element.getBoundingClientRect();
          return name && rect.width > 0 && rect.height > 0
            ? [{ element, name, rect }]
            : [];
        }),
      );
    }

    function scheduleRefresh() {
      if (frame === 0) frame = requestAnimationFrame(refresh);
    }

    const mutationObserver = new MutationObserver((mutations) => {
      const targetsChanged = mutations.some((mutation) =>
        mutation.type === "attributes"
          ? true
          : [...mutation.addedNodes, ...mutation.removedNodes].some(
              (node) =>
                node instanceof HTMLElement &&
                (node.hasAttribute(DEBUG_COMPONENT_ATTRIBUTE) ||
                  node.querySelector(`[${DEBUG_COMPONENT_ATTRIBUTE}]`) != null),
            ),
      );
      if (targetsChanged) scheduleRefresh();
    });

    refresh();
    mutationObserver.observe(document.body, {
      attributeFilter: [DEBUG_COMPONENT_ATTRIBUTE],
      attributes: true,
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", scheduleRefresh);
    window.addEventListener("scroll", scheduleRefresh, true);

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleRefresh);
      window.removeEventListener("scroll", scheduleRefresh, true);
    };
  }, [enabled]);

  if (!enabled || boxes.length === 0) return null;

  return createPortal(
    <div
      data-testid="component-debug-overlay"
      className="pointer-events-none fixed inset-0 z-[100]"
    >
      {boxes.map(({ name, rect }, index) => (
        <DebugBoxOverlay key={`${name}-${index}`} name={name} rect={rect} />
      ))}
    </div>,
    document.body,
  );
}

function DebugBoxOverlay({ name, rect }: { name: string; rect: DOMRect }) {
  const [copied, setCopied] = useState(false);
  const [labelHovered, setLabelHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copyName() {
    try {
      await navigator.clipboard.writeText(name);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // The label remains visible and selectable when clipboard access is denied.
    }
  }

  return (
    <div
      className="fixed border border-red-600 bg-red-500/10"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }}
    >
      <div className="pointer-events-auto absolute left-0 top-0 flex max-w-full items-center bg-red-700 text-[10px] font-medium text-white shadow-sm">
        <span
          className="relative min-w-0 truncate px-[3px] py-[1px]"
          onMouseEnter={() => setLabelHovered(true)}
          onMouseLeave={() => setLabelHovered(false)}
        >
          {name}
          {labelHovered ? (
            <span
              role="tooltip"
              data-testid="component-debug-name-tooltip"
              className="absolute left-0 top-full z-10 mt-0.5 max-w-[min(24rem,80vw)] whitespace-normal break-all rounded bg-red-950 px-[3px] py-[1px] text-[10px] font-medium text-white shadow-md"
            >
              {name}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={copyName}
          aria-label={`Copy component name: ${name}`}
          title={copied ? "Copied" : `Copy ${name}`}
          className="inline-flex size-5 shrink-0 items-center justify-center border-l border-white/40 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white"
        >
          {copied ? (
            <Check className="size-3" aria-hidden="true" />
          ) : (
            <Copy className="size-3" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
