import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ui";
import { useLocale } from "./i18n/react";
import { applyTheme, readTheme } from "./lib/theme";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";

applyTheme(readTheme());

// Changing language remounts the app, so every t() call, including ones in
// lib helpers and memoized values, renders in the new language.
function Root() {
  const locale = useLocale();
  return <App key={locale} />;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <Root />
      </ErrorBoundary>
    </StrictMode>,
  );
}
