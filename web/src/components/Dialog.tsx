// Modal dialog and side drawer: focus moves in, stays in (Tab wraps), Esc
// closes, and focus goes back to what opened it. A destructive button is
// never focused first and ignores Enter (it takes a click or Space).
import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { initialFocusIndex, nextTrapIndex, shouldSwallowEnter } from "../lib/focus";
import { IconButton } from "./ui";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open traps, innermost last: only the top one handles keys, so a confirm
// opened over a drawer closes on Escape without closing the drawer too.
const openTraps: object[] = [];

export function useFocusTrap(open: boolean, onClose: () => void, initial?: string, alert = false) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const token = {};
    openTraps.push(token);
    const opener = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const first = () => {
      if (!root) return;
      const explicit = initial ? root.querySelector<HTMLElement>(initial) : null;
      if (explicit) return explicit.focus();
      const nodes = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      // The close icon in the header is not a sensible first stop.
      const items = nodes.map((n) => ({
        autofocus: n.hasAttribute("data-autofocus"),
        danger: n.classList.contains("btn-danger"),
        inFooter: n.closest(".dialog-foot") !== null,
      }));
      const skipClose = nodes.map((n) => n.closest(".dialog-head") !== null);
      const i = initialFocusIndex(
        items.map((x, k) => (skipClose[k] && !x.autofocus ? { ...x, danger: true } : x)),
        alert,
      );
      (i >= 0 ? (nodes[i] as HTMLElement) : root).focus();
    };
    first();
    const onKey = (e: KeyboardEvent) => {
      if (openTraps[openTraps.length - 1] !== token) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        root &&
        target &&
        root.contains(target) &&
        shouldSwallowEnter(e.key, target.classList.contains("btn-danger"))
      ) {
        e.preventDefault();
        return;
      }
      if (e.key !== "Tab" || !root) return;
      const nodes = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (n) => n.offsetParent !== null || n === document.activeElement,
      );
      const current = root.contains(document.activeElement)
        ? nodes.indexOf(document.activeElement as HTMLElement)
        : -1;
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const next = nextTrapIndex(current, nodes.length, e.shiftKey);
      if (next !== null) {
        e.preventDefault();
        nodes[next]?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const at = openTraps.indexOf(token);
      if (at >= 0) openTraps.splice(at, 1);
      document.body.style.overflow = prevOverflow;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open, initial, alert]);

  return ref;
}

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** CSS selector of the element to focus first. */
  initialFocus?: string;
  role?: "dialog" | "alertdialog";
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  initialFocus,
  role = "dialog",
}: DialogProps) {
  const ref = useFocusTrap(open, onClose, initialFocus, role === "alertdialog");
  const tid = useId();
  const did = useId();
  if (!open) return null;
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`dialog dialog-${size}`}
        role={role}
        aria-modal="true"
        aria-labelledby={tid}
        aria-describedby={description ? did : undefined}
        tabIndex={-1}
      >
        <div className="dialog-head">
          <h2 id={tid} className="dialog-title">
            {title}
          </h2>
          <IconButton icon="x" label={t("common.dialog.close")} onClick={onClose} />
        </div>
        {description ? (
          <div id={did} className="dialog-desc">
            {description}
          </div>
        ) : null}
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
}: Omit<DialogProps, "size" | "description" | "role">) {
  const ref = useFocusTrap(open, onClose);
  const tid = useId();
  if (!open) return null;
  return createPortal(
    <div
      className="overlay overlay-drawer"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        // biome-ignore lint/a11y/useSemanticElements: drawer with its own focus trap and backdrop; a native dialog changes both
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={tid}
        tabIndex={-1}
      >
        <div className="dialog-head">
          <h2 id={tid} className="dialog-title">
            {title}
          </h2>
          <IconButton icon="x" label={t("common.dialog.close")} onClick={onClose} />
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
