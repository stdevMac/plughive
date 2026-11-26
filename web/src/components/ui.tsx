// Small building blocks shared by every screen.
import {
  type ButtonHTMLAttributes,
  Component,
  type ErrorInfo,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { t } from "../i18n";
import { type HumanError, humanError } from "../lib/humanError";
import { Link } from "../lib/router";
import { Icon, type IconName } from "./Icon";
import { useToast } from "./Toast";

// ---- Error boundary ------------------------------------------------------------

/**
 * Catches a render crash (an unparsable url in a result, a schema the form
 * cannot handle) and shows a reload prompt instead of a blank page.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("dashboard crashed:", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="page-loading" role="alert">
          <p>{t("common.ui.crashed")}</p>
          <p className="small">{this.state.error.message.slice(0, 300)}</p>
          <Button onClick={() => window.location.reload()}>{t("common.ui.reload")}</Button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---- Button ------------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  icon?: IconName;
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    icon,
    busy,
    children,
    className,
    disabled,
    type = "button",
    ...rest
  },
  ref,
) {
  const cls = ["btn", `btn-${variant}`, size === "sm" ? "btn-sm" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
});

/** A square button with only an icon; `label` is required for screen readers. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, "children"> & { label: string; icon: IconName }
>(function IconButton(
  { label, icon, variant = "ghost", size = "md", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={[
        "btn",
        `btn-${variant}`,
        "btn-icon",
        size === "sm" ? "btn-sm" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
});

export function Spinner({ label }: { label?: string }) {
  return (
    <span
      className="spinner"
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

// ---- Badge / status ---------------------------------------------------------

export type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

export function Badge({
  tone = "neutral",
  children,
  dot,
}: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot ? <span className="badge-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

// ---- Page structure -----------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
}: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1 id="page-title" tabIndex={-1}>
          {title}
        </h1>
        {description ? <p className="page-desc">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
  id,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const hid = useId();
  return (
    <section
      className={`card ${className ?? ""}`}
      aria-labelledby={title ? hid : undefined}
      id={id}
    >
      {title || actions ? (
        <div className="card-head">
          {title ? (
            <h2 className="card-title" id={hid}>
              {title}
            </h2>
          ) : (
            <span />
          )}
          {actions ? <div className="card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

// ---- States -------------------------------------------------------------------

export function Skeleton({ lines = 3, height }: { lines?: number; height?: number }) {
  return (
    <div className="skeleton-group" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          key={i}
          className="skeleton"
          style={{ height: height ?? 14, width: i === lines - 1 && lines > 1 ? "60%" : "100%" }}
        />
      ))}
    </div>
  );
}

export function Loading({
  label = t("common.ui.loading"),
  lines = 4,
}: { label?: string; lines?: number }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: block live region for loading; output is for form results
    <div className="loading" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      <Skeleton lines={lines} />
    </div>
  );
}

export function EmptyState({
  icon = "info",
  title,
  children,
  action,
}: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <p className="empty-title">{title}</p>
      {children ? <p className="empty-body">{children}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title,
  pack,
}: { error: unknown; onRetry?: () => void; title?: string; pack?: string }) {
  const h = humanError(error, pack ? { pack } : {});
  return (
    <div className="empty empty-error" role="alert">
      <span className="empty-icon">
        <Icon name="alert" size={22} />
      </span>
      <p className="empty-title">{title ?? h.what}</p>
      {title ? <p className="empty-body">{h.what}</p> : null}
      {h.why ? <p className="empty-body">{h.why}</p> : null}
      <div className="empty-action">
        {h.next ? <NextStep next={h.next} primary /> : null}
        {onRetry ? (
          <Button icon="refresh" variant={h.next ? "ghost" : "secondary"} onClick={onRetry}>
            {t("common.ui.tryAgain")}
          </Button>
        ) : null}
      </div>
      <ErrorDetail h={h} />
    </div>
  );
}

/** The one next step of a human error, as a link or a reload. */
export function NextStep({
  next,
  primary,
}: { next: NonNullable<HumanError["next"]>; primary?: boolean }) {
  const cls = primary ? "btn btn-primary" : "btn btn-secondary btn-sm";
  if (next.to === "reload:")
    return (
      <button type="button" className={cls} onClick={() => window.location.reload()}>
        {next.label}
      </button>
    );
  return (
    <Link to={next.to} className={cls}>
      {next.label}
    </Link>
  );
}

function ErrorDetail({ h }: { h: HumanError }) {
  if (!h.detail || h.detail === h.what || h.detail === h.why) return null;
  return (
    <details className="error-detail">
      <summary>{t("common.ui.details")}</summary>
      <p className="mono small">{h.detail}</p>
    </details>
  );
}

/** Inline: what happened, why, and the next step. For results and forms. */
export function HumanErrorAlert({
  error,
  pack,
  canUseKey,
}: { error: unknown; pack?: string; canUseKey?: boolean }) {
  const h = humanError(error, {
    ...(pack ? { pack } : {}),
    ...(canUseKey !== undefined ? { canUseKey } : {}),
  });
  return (
    <div className="alert alert-danger" role="alert">
      <Icon name="alert" />
      <div>
        <p className="alert-title">{h.what}</p>
        {h.why || h.next ? (
          <div className="alert-body">
            {h.why ? <span>{h.why} </span> : null}
            {h.next ? <NextStep next={h.next} /> : null}
          </div>
        ) : null}
        <ErrorDetail h={h} />
      </div>
    </div>
  );
}

export function InlineAlert({
  tone = "warn",
  children,
  title,
}: { tone?: "warn" | "danger" | "info" | "ok"; children: ReactNode; title?: string }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === "danger" ? "alert" : undefined}>
      <Icon name={tone === "ok" ? "check" : tone === "info" ? "info" : "alert"} />
      <div>
        {title ? <p className="alert-title">{title}</p> : null}
        <div className="alert-body">{children}</div>
      </div>
    </div>
  );
}

// ---- Form controls -------------------------------------------------------------

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  describedBy,
  showLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  describedBy?: string;
  showLabel?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={showLabel ? undefined : label}
      aria-describedby={describedBy}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      {showLabel ? <span className="switch-label">{label}</span> : null}
    </button>
  );
}

/** A checkbox that can show "some" (mixed). */
export function TriCheckbox({
  state,
  onToggle,
  label,
  tabIndex,
  decorative,
}: {
  state: "on" | "off" | "mixed";
  onToggle: () => void;
  label: string;
  tabIndex?: number;
  /** The state is announced by the row that holds the box (a treeitem with aria-checked). */
  decorative?: boolean;
}) {
  if (decorative) {
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: decorative mouse target; the labelled checkbox beside it takes the keyboard
      <span
        aria-hidden="true"
        className={`tri tri-${state}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {state === "on" ? (
          <Icon name="check" size={12} />
        ) : state === "mixed" ? (
          <Icon name="minus" size={12} />
        ) : null}
      </span>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: tri-state checkbox (mixed), which a native input cannot render
    <span
      role="checkbox"
      aria-checked={state === "on" ? true : state === "off" ? false : "mixed"}
      aria-label={label}
      tabIndex={tabIndex ?? 0}
      className={`tri tri-${state}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }
      }}
    >
      {state === "on" ? (
        <Icon name="check" size={12} />
      ) : state === "mixed" ? (
        <Icon name="minus" size={12} />
      ) : null}
    </span>
  );
}

export function FieldRow({
  label,
  htmlFor,
  hint,
  error,
  children,
  required,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <div className={`field ${error ? "field-invalid" : ""}`}>
      <label htmlFor={htmlFor} className="field-label">
        {label}
        {required ? <span className="field-req">{t("common.ui.fieldRequired")}</span> : null}
      </label>
      {children}
      {hint ? (
        <p className="field-hint" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${htmlFor}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...rest }, ref) {
    return <input ref={ref} className={`input ${className ?? ""}`} {...rest} />;
  },
);

/** A secret field: hidden by default, with a reveal toggle. The value never leaves this input except on save. */
export function PasswordInput({
  id,
  value,
  onChange,
  label,
  placeholder,
  autoComplete = "off",
  autoFocus,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  autoComplete?: "off" | "new-password";
  autoFocus?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password">
      <input
        id={id}
        className="input input-mono"
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        // biome-ignore lint/a11y/noAutofocus: focus moves to the field the user opened
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        data-1p-ignore
      />
      <IconButton
        size="sm"
        icon={shown ? "eyeOff" : "eye"}
        label={
          shown ? t("common.ui.password.hide", { label }) : t("common.ui.password.show", { label })
        }
        aria-pressed={shown}
        onClick={() => setShown((s) => !s)}
      />
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  label,
  placeholder,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  id?: string;
}) {
  return (
    <div className="search">
      <Icon name="search" />
      <input
        id={id}
        type="search"
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? t("common.ui.searchPlaceholder")}
        aria-label={label}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          }
        }}
      />
    </div>
  );
}

// ---- Copy ---------------------------------------------------------------------

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Some webviews do not expose the async clipboard: fall back to a hidden textarea.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({
  text,
  label = t("common.ui.copy.label"),
  what,
  size = "sm",
  variant = "secondary",
  iconOnly = false,
}: {
  text: string;
  label?: string;
  what?: string;
  size?: "sm" | "md";
  variant?: Variant;
  iconOnly?: boolean;
}) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      size={size}
      variant={variant}
      icon={done ? "check" : "copy"}
      className={iconOnly ? "btn-icon" : undefined}
      title={iconOnly ? (what ? t("common.ui.copy.copyWhat", { what }) : label) : undefined}
      aria-label={what ? t("common.ui.copy.copyWhat", { what }) : label}
      onClick={async () => {
        const ok = await copyText(text);
        if (ok) {
          setDone(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setDone(false), 1600);
        } else
          toast.show({
            tone: "danger",
            text: t("common.ui.copy.unavailable"),
          });
      }}
    >
      {iconOnly ? (
        <span className="visually-hidden">{done ? t("common.ui.copy.copied") : label}</span>
      ) : done ? (
        t("common.ui.copy.copied")
      ) : (
        label
      )}
    </Button>
  );
}

export function CopyField({
  value,
  label,
  mono = true,
}: { value: string; label: string; mono?: boolean }) {
  const id = useId();
  return (
    <div className="copy-field">
      <label htmlFor={id} className="visually-hidden">
        {label}
      </label>
      <input
        id={id}
        className={`input ${mono ? "input-mono" : ""}`}
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
      />
      <CopyButton text={value} what={label} />
    </div>
  );
}

export function CodeBlock({
  code,
  label,
  language,
}: { code: string; label: string; language?: string }) {
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{language ?? ""}</span>
        <CopyButton text={code} what={label} variant="ghost" />
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable code block must be reachable by keyboard to scroll it */}
      <pre tabIndex={0} aria-label={label}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ---- Tabs ---------------------------------------------------------------------

export interface TabItem {
  id: string;
  label: ReactNode;
}

/** Roving-focus tabs; arrows move between tabs, Home/End jump. */
/** `manual`: arrow keys only move focus and Enter or Space picks the tab, for tabs whose change can ask a question. */
export function Tabs({
  items,
  value,
  onChange,
  label,
  idPrefix,
  manual,
}: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  idPrefix: string;
  manual?: boolean;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % items.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next >= 0) {
      e.preventDefault();
      const item = items[next];
      if (item) {
        if (!manual) onChange(item.id);
        refs.current[next]?.focus();
      }
    }
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${t.id}`}
          aria-selected={t.id === value}
          aria-controls={`${idPrefix}-panel`}
          tabIndex={t.id === value ? 0 : -1}
          className="tab"
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          // biome-ignore lint/a11y/useSemanticElements: segmented control: buttons in an ARIA radiogroup
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className="segmented-item"
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            const i = options.findIndex((x) => x.value === value);
            if (
              e.key === "ArrowRight" ||
              e.key === "ArrowDown" ||
              e.key === "ArrowLeft" ||
              e.key === "ArrowUp"
            ) {
              e.preventDefault();
              const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
              const next = options[(i + d + options.length) % options.length];
              if (next) {
                onChange(next.value);
                const parent = (e.currentTarget as HTMLElement).parentElement;
                requestAnimationFrame(() =>
                  (parent?.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus(),
                );
              }
            }
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A definition list row set: label / value pairs. */
export function KeyValues({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are static per render
        <div className="kv-row" key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  // Opens in the system browser through the user's own click (no window.open).
  // Only http(s) links are links: a "javascript:" or "data:" href from an
  // untrusted schema or result renders as plain text.
  if (!/^https?:\/\//i.test(href)) {
    return (
      <span className="ext-link">
        {children}
        <Icon name="external" size={12} />
      </span>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="ext-link">
      {children}
      <Icon name="external" size={12} />
      <span className="visually-hidden">{t("common.ui.externalNewTab")}</span>
    </a>
  );
}
