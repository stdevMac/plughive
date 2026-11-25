// Toasts: short results of actions, announced politely, dismissible.
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { t } from "../i18n";
import { Icon } from "./Icon";

export interface ToastInput {
  tone?: "ok" | "danger" | "info";
  text: string;
  action?: { label: string; onClick: () => void };
  /** ms; errors stay longer. */
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  show(t: ToastInput): void;
  ok(text: string): void;
  error(text: string): void;
  /** A done action that can be reversed: shows Undo for a few seconds. */
  undo(text: string, onUndo: () => void): void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
  }, []);

  const show = useCallback(
    (t: ToastInput) => {
      const id = next.current++;
      setItems((list) => [...list.slice(-3), { ...t, id }]);
      const ms = t.duration ?? (t.tone === "danger" ? 8000 : 4000);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ms),
      );
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      ok: (text) => show({ tone: "ok", text }),
      error: (text) => show({ tone: "danger", text }),
      undo: (text, onUndo) =>
        show({
          tone: "ok",
          text,
          action: { label: t("common.toast.undo"), onClick: onUndo },
          duration: 6000,
        }),
    }),
    [show],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" aria-relevant="additions">
        {items.map((item) => (
          <div
            key={item.id}
            className={`toast toast-${item.tone ?? "info"}`}
            role={item.tone === "danger" ? "alert" : "status"}
          >
            <Icon name={item.tone === "ok" ? "check" : item.tone === "danger" ? "alert" : "info"} />
            <span className="toast-text">{item.text}</span>
            {item.action ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  item.action?.onClick();
                  dismiss(item.id);
                }}
              >
                {item.action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="toast-close"
              aria-label={t("common.toast.dismiss")}
              onClick={() => dismiss(item.id)}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast outside ToastProvider");
  return v;
}
