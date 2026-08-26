import type { Notification } from "@/api/types";

const APP_ORIGIN = "http://loophub.local";

// 通知の href はアプリ内の canonical path である。解析後の pathname だけを比較することで、
// query string は対象リソースに影響させず、外部 URL と不正なデータは一致させない。
export function notificationMatchesPath(
  notification: Notification,
  pathname: string,
): boolean {
  try {
    const href = new URL(notification.resource.href, APP_ORIGIN);
    return href.origin === APP_ORIGIN && href.pathname === pathname;
  } catch {
    return false;
  }
}
