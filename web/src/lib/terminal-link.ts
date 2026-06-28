// Decide how a URL clicked inside the terminal should open. A link whose origin matches the
// app's own origin (the loophub server that serves this SPA) is "internal" and should be taken
// over for client-side navigation; anything else is "external" and opens in a new tab as before.
// The origin is passed in (window.location.origin at the call site) so the rule depends on the
// live serving origin, never a hardcoded host/port.
export type TerminalLinkTarget =
  | { kind: "internal"; path: string }
  | { kind: "external"; uri: string };

export function classifyTerminalLink(
  uri: string,
  origin: string,
): TerminalLinkTarget {
  try {
    const url = new URL(uri);
    if (url.origin === origin) {
      return { kind: "internal", path: url.pathname + url.search + url.hash };
    }
  } catch {
    // Not parseable as an absolute URL — fall through and treat it as external.
  }
  return { kind: "external", uri };
}
