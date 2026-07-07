const SHORTCUT_FOCUS_OWNER_SELECTOR =
  "[data-repo-switcher-dialog], [role='dialog'], [role='menu']";

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
    ),
  );
}

export function hasPlainShortcutModifiers(event: KeyboardEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

export function isShortcutOverlayActive(target: EventTarget | null): boolean {
  if (
    target instanceof Element &&
    target.closest(SHORTCUT_FOCUS_OWNER_SELECTOR)
  ) {
    return true;
  }
  return Boolean(document.querySelector(SHORTCUT_FOCUS_OWNER_SELECTOR));
}
