import { type FormEvent, useState } from "react";
import { Icon } from "../components/Icon";
import { LanguagePicker } from "../components/LanguagePicker";
import { Button, PasswordInput } from "../components/ui";
import { t } from "../i18n";
import { ApiError, signIn } from "../lib/api";
import { useDocumentTitle } from "../lib/hooks";

export function signInErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return t("signin.errors.tooMany");
    if (
      e.status === 401 ||
      e.status === 403 ||
      e.code === "INVALID_TOKEN" ||
      e.code === "UNAUTHORIZED"
    ) {
      return t("signin.errors.badToken");
    }
    if (e.status === 400) return t("signin.errors.paste");
    if (e.isNetwork) return t("signin.errors.network");
    return e.message;
  }
  return t("signin.errors.failed");
}

export function SignIn({
  onSignedIn,
  initialError,
}: { onSignedIn: () => void; initialError?: string | null }) {
  useDocumentTitle(t("signin.title"));
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const tok = token.trim();
    if (!tok) {
      setError(t("signin.errors.empty"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(tok);
      setToken("");
      onSignedIn();
    } catch (err) {
      setError(signInErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="signin" id="main">
      <LanguagePicker className="signin-lang" />
      <div className="signin-card">
        <div className="brand brand-lg">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="package" size={18} />
          </span>
          <span>plughive</span>
        </div>
        <h1>{t("signin.heading")}</h1>
        <p className="muted">
          {t("signin.intro.before")} <strong>{t("signin.intro.link")}</strong>
          {t("signin.intro.after")}
        </p>
        <form onSubmit={submit} noValidate>
          <div className={`field ${error ? "field-invalid" : ""}`}>
            <label htmlFor="admin-token" className="field-label">
              {t("signin.tokenLabel")}
            </label>
            <PasswordInput
              id="admin-token"
              label={t("signin.tokenAria")}
              value={token}
              onChange={(v) => {
                setToken(v);
                if (error) setError(null);
              }}
              autoFocus
              invalid={!!error}
              describedBy={error ? "admin-token-error" : undefined}
            />
            {error ? (
              <p className="field-error" id="admin-token-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <Button type="submit" variant="primary" busy={busy} className="btn-block">
            {t("signin.submit")}
          </Button>
        </form>
        <p className="signin-foot small muted">
          {t("signin.foot.before")}
          <code>admin-token</code>
          {t("signin.foot.middle")}
          <code>~/.plughive/admin-token</code>
          {t("signin.foot.after")}
        </p>
      </div>
    </main>
  );
}
