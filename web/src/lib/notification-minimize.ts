// Whether the notification stack is collapsed to its unread count. Stored per browser in
// localStorage so folding the stack away survives a reload; it is a view preference only and
// never marks a notification read.

const MINIMIZED_KEY = "lh_notifications_minimized";

export function getNotificationsMinimized(): boolean {
  return localStorage.getItem(MINIMIZED_KEY) === "1";
}

export function setNotificationsMinimized(minimized: boolean): void {
  if (!minimized) {
    localStorage.removeItem(MINIMIZED_KEY);
    return;
  }
  localStorage.setItem(MINIMIZED_KEY, "1");
}
