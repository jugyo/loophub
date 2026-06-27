// One xterm.js terminal wired to a backend PTY over the /terminal WebSocket. Mount == open a
// session; unmount == close the socket (which kills the PTY server-side). Keep this component
// a single terminal so a future tab feature can mount several side by side.
//
// The session is window-scoped and persists across all navigation: the repo in view is read
// once at mount to pick the cwd (a repo's base dir, or $HOME on non-repo screens) and then never
// changes — navigating to another repo keeps the same shell. Only a reload or collapsing the
// pane (unmount) tears it down.
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { useCurrentRepo } from "@/lib/use-current-repo";

// WebSocket close code for a normal shell exit (`exit` / Ctrl-D). Only this collapses the pane.
// Everything else — including 1001 "server going away" (a restart, not a user action) and the
// 4xxx error codes — keeps a note visible so the pane and its persisted open-state survive a
// server bounce instead of being silently flipped off by a non-user event.
const SHELL_EXIT_CODE = 1000;

// Minimal palettes tuned to the app's light/dark surfaces. Picked once at mount; toggling the
// app theme while a terminal is open is rare enough to defer to a remount.
const DARK_THEME = {
  background: "#0b0b0e",
  foreground: "#e4e4e7",
  cursor: "#e4e4e7",
  selectionBackground: "#3f3f46",
};
const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#18181b",
  cursor: "#18181b",
  selectionBackground: "#d4d4d8",
};

export function TerminalView({
  onExit,
}: {
  // Called when the shell exits so the parent can collapse the pane. Held in a ref so a new
  // callback identity doesn't remount the terminal.
  onExit?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  // Capture the repo in view at mount only. The ref is never reassigned, so later navigation
  // does not change the session's cwd (an empty value → $HOME, resolved server-side).
  const repoAtMount = useRef(useCurrentRepo() ?? "");
  // True only while the WebSocket (hence the PTY) is actually open. Set in the socket effect.
  const aliveRef = useRef(false);

  // Guard the tab/window against an accidental close or reload while a live shell is attached.
  // Gated on aliveRef so a failed-to-start or already-closed session doesn't prompt for nothing.
  // The browser shows its native "leave site?" prompt; confirming still proceeds (kills the PTY).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!aliveRef.current) return;
      e.preventDefault();
      e.returnValue = ""; // required for Chrome to actually show the prompt
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const isDark = document.documentElement.classList.contains("dark");
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Liberation Mono", monospace',
      theme: isDark ? DARK_THEME : LIGHT_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/terminal?repo=${encodeURIComponent(
      repoAtMount.current,
    )}&cols=${term.cols}&rows=${term.rows}`;
    const ws = new WebSocket(url);

    const send = (m: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };
    const fitAndResize = () => {
      try {
        fit.fit();
      } catch {
        // host detached mid-resize; ignore
      }
      send({ type: "resize", cols: term.cols, rows: term.rows });
    };

    ws.onopen = () => {
      aliveRef.current = true;
      fitAndResize();
      term.focus();
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") term.write(e.data);
    };
    ws.onclose = (e) => {
      aliveRef.current = false;
      if (e.code === SHELL_EXIT_CODE) {
        // The shell exited — collapse the pane instead of showing a dead terminal.
        onExitRef.current?.();
        return;
      }
      term.write(
        `\r\n\x1b[31m[terminal: ${e.reason || "disconnected"}]\x1b[0m\r\n`,
      );
    };

    const dataSub = term.onData((d) => send({ type: "input", data: d }));
    const ro = new ResizeObserver(() => fitAndResize());
    ro.observe(host);

    return () => {
      ro.disconnect();
      dataSub.dispose();
      ws.onclose = null; // don't write the close note into a disposing terminal
      ws.close();
      term.dispose();
    };
    // Mount once: the session must survive navigation. repoAtMount/onExit are refs.
  }, []);

  return <div ref={hostRef} className="h-full w-full" />;
}
