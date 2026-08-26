import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function getSnapshot(): boolean {
  return document.visibilityState === "visible";
}

// Web app は client-rendered だが、安定した server snapshot を返すことで、テストや将来の
// pre-rendering でも document が利用できない状態を hidden と扱わずに安全に利用できる。
function getServerSnapshot(): boolean {
  return true;
}

export function usePageVisibility(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
