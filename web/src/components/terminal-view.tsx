// One xterm.js terminal wired to a backend PTY over the /terminal WebSocket. Mount == open a
// session; unmount == close the socket (which kills the PTY server-side). The tab feature
// (TerminalPane) mounts several of these side by side — one per tab, all kept mounted so
// inactive tabs keep running, and only the active one is shown (display toggled by the parent).
//
// The session is window-scoped and persists across all navigation: the cwd is chosen from the
// `repo` prop captured once at mount (a repo's base dir, or $HOME for an empty repo) and then
// never changes. Only a reload or closing the tab (unmount) tears it down.
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

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
  repo,
  command,
  active = true,
  onExit,
}: {
  // "owner/name" of the repo whose base dir is the cwd, or "" for $HOME. Captured once at
  // mount; later changes do not move the running session.
  repo: string;
  // Optional command to run once the shell starts (e.g. New Issue / Build launches). Captured
  // once at mount and run server-side after the shell is interactive; the shell stays usable.
  command?: string;
  // Whether this terminal is the visible/active tab. When it flips to true the terminal is
  // refit and focused (it may have been hidden at display:none and gone stale). Defaults to
  // true for a standalone (single-tab) mount.
  active?: boolean;
  // Called when the shell exits so the parent can close this tab. Held in a ref so a new
  // callback identity doesn't remount the terminal.
  onExit?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  // Capture the repo at mount only. The ref is never reassigned, so later navigation does not
  // change the session's cwd (an empty value → $HOME, resolved server-side).
  const repoAtMount = useRef(repo);
  // Capture the initial command at mount only, for the same reason as repo (the session is
  // created once; a later prop change must not re-run it).
  const commandAtMount = useRef(command);
  // True only while the WebSocket (hence the PTY) is actually open. Set in the socket effect.
  const aliveRef = useRef(false);
  // Latest `active`, read inside the async socket callbacks. Sockets connect asynchronously, so a
  // tab can finish connecting after the user has already switched away — without this the late
  // onopen would steal focus to a now-hidden terminal.
  const activeRef = useRef(active);
  activeRef.current = active;
  // Refs to the live terminal + a fit-and-resize callback, so the activation effect can refit
  // and focus this tab when it becomes visible without remounting.
  const termRef = useRef<Terminal | null>(null);
  const fitAndResizeRef = useRef<(() => void) | null>(null);

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
    termRef.current = term;

    const proto = location.protocol === "https:" ? "wss" : "ws";
    let url = `${proto}://${location.host}/terminal?repo=${encodeURIComponent(
      repoAtMount.current,
    )}&cols=${term.cols}&rows=${term.rows}`;
    // Pass the initial command (if any) so the server runs it in the spawned shell.
    if (commandAtMount.current?.trim()) {
      url += `&cmd=${encodeURIComponent(commandAtMount.current)}`;
    }
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
    fitAndResizeRef.current = fitAndResize;

    ws.onopen = () => {
      aliveRef.current = true;
      fitAndResize();
      // Only grab focus if this tab is still the active one — a tab switched away from during
      // the connect window must not pull keystrokes back to its hidden terminal.
      if (activeRef.current) term.focus();
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
      termRef.current = null;
      fitAndResizeRef.current = null;
    };
    // Mount once: the session must survive navigation. repoAtMount/onExit are refs.
  }, []);

  // When this tab becomes active it may have been hidden (display:none → 0-sized host), so the
  // terminal's geometry is stale. Refit on the next frame (after display:block applies) and
  // move focus to it. No-op while inactive or before the terminal/socket are up.
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      fitAndResizeRef.current?.();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  return <div ref={hostRef} className="h-full w-full" />;
}
