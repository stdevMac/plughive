// The one language picker, used everywhere the language can be changed:
//
//   <LanguagePicker variant="compact" />   sign-in page corner, sidebar footer
//   <LanguagePicker variant="choices" />   first-run card on Home: every language
//                                          as a button while there are few
//   <LanguagePicker variant="select" labelledBy="…" />   Settings row
//
// Languages come from web/src/i18n/locales/<code>/ (each shown in its own
// name), so adding a translation adds it here with no code change. Picks go
// through chooseLocale(), which also shares the choice with the daemon.
import { useId } from "react";
import { availableLocales, t } from "../i18n";
import { useLocale } from "../i18n/react";
import { chooseLocale } from "../i18n/sync";
import { Icon } from "./Icon";

/** Up to this many languages show as buttons in the "choices" variant. */
const MAX_BUTTONS = 6;

export function LanguagePicker({
  variant = "compact",
  labelledBy,
  className,
}: {
  variant?: "compact" | "choices" | "select";
  /** id of a visible label (the "select" variant); else the picker labels itself. */
  labelledBy?: string;
  className?: string;
}) {
  const locale = useLocale();
  const locales = availableLocales();
  const id = useId();

  if (variant === "choices" && locales.length <= MAX_BUTTONS) {
    return (
      <div
        className={["lang-choices", className].filter(Boolean).join(" ")}
        role="radiogroup"
        aria-label={t("language.label")}
      >
        {locales.map((l) => (
          <button
            key={l.code}
            // biome-ignore lint/a11y/useSemanticElements: language buttons in an ARIA radiogroup
            type="button"
            role="radio"
            aria-checked={l.code === locale}
            lang={l.code}
            className="lang-choice"
            onClick={() => chooseLocale(l.code)}
          >
            {l.code === locale ? <Icon name="check" size={14} /> : null}
            {l.name}
          </button>
        ))}
      </div>
    );
  }

  const select = (
    <select
      id={id}
      className={variant === "compact" ? "lang-select" : "input input-sm"}
      aria-label={labelledBy ? undefined : t("language.label")}
      aria-labelledby={labelledBy}
      value={locale}
      onChange={(e) => chooseLocale(e.target.value)}
    >
      {locales.map((l) => (
        <option key={l.code} value={l.code} lang={l.code}>
          {l.name}
        </option>
      ))}
    </select>
  );
  if (variant !== "compact") return className ? <div className={className}>{select}</div> : select;
  return (
    <div className={["lang-compact", className].filter(Boolean).join(" ")}>
      <Icon name="globe" size={14} aria-hidden="true" />
      {select}
      <Icon name="chevronDown" size={12} className="lang-caret" aria-hidden="true" />
    </div>
  );
}
