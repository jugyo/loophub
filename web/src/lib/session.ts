// Agent session id, stored in sessionStorage to mirror v1 (src/ui.html).
// The id is sent as `session_id` in write request bodies (see API.md).

const SESSION_KEY = "lh_session_id";
const LAST_EVENT_KEY = "lh_last_event_id";

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Current session id, creating and persisting one on first access. */
export function getSessionId(): string {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = uuid();
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

/** Last event id seen by the web UI event poller. */
export function getLastEventId(): number {
  return Number(localStorage.getItem(LAST_EVENT_KEY) ?? 0) || 0;
}

export function setLastEventId(id: number): void {
  if (id <= 0) {
    localStorage.removeItem(LAST_EVENT_KEY);
    return;
  }
  localStorage.setItem(LAST_EVENT_KEY, String(id));
}

export function rememberEventId(id: number): void {
  if (!id || id <= getLastEventId()) return;
  setLastEventId(id);
}
