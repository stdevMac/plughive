// Pure focus rules for dialogs, kept apart from the DOM so they can be tested.

export interface FocusCandidate {
  /** Marked with data-autofocus. */
  autofocus: boolean;
  /** A destructive control (.btn-danger). */
  danger: boolean;
  /** Sits in the dialog footer (the action row). */
  inFooter: boolean;
}

/**
 * Which element a dialog focuses when it opens, as an index into the
 * focusable elements in document order, or -1 for the dialog itself.
 * A destructive control is never focused first: Enter right after opening
 * must not destroy anything. Confirmation dialogs (alertdialog) start on the
 * first safe action in the footer, usually Cancel.
 */
export function initialFocusIndex(items: FocusCandidate[], alert: boolean): number {
  const marked = items.findIndex((x) => x.autofocus && !x.danger);
  if (marked >= 0) return marked;
  if (alert) {
    const safe = items.findIndex((x) => x.inFooter && !x.danger);
    if (safe >= 0) return safe;
  }
  const first = items.findIndex((x) => !x.danger);
  return first;
}

/** Enter on a destructive button inside a dialog does nothing; it takes a click or Space. */
export function shouldSwallowEnter(key: string, targetIsDanger: boolean): boolean {
  return key === "Enter" && targetIsDanger;
}

/**
 * Where Tab goes inside a focus trap. `current` is the index of the focused
 * element (-1 when focus is outside the dialog). Returns the index to focus,
 * or null to let the browser move focus normally.
 */
export function nextTrapIndex(current: number, count: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (shift && current <= 0) return count - 1;
  if (!shift && (current === count - 1 || current === -1)) return 0;
  return null;
}
