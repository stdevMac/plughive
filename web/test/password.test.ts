import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SecretEditor } from "../src/components/SecretEditor";
import { ToastProvider } from "../src/components/Toast";
import { PasswordInput } from "../src/components/ui";
import { SignIn } from "../src/pages/SignIn";

// React writes the attribute as autoComplete; HTML attribute names are case-insensitive.
describe("PasswordInput autocomplete attributes", () => {
  it('defaults to "off" and supports "new-password"', () => {
    const offHtml = renderToStaticMarkup(
      createElement(PasswordInput, {
        id: "p1",
        label: "Token",
        value: "",
        onChange: () => undefined,
      }),
    );
    expect(offHtml).toMatch(/autocomplete="off"/i);

    const newHtml = renderToStaticMarkup(
      createElement(PasswordInput, {
        id: "p2",
        label: "API key",
        value: "",
        onChange: () => undefined,
        autoComplete: "new-password",
      }),
    );
    expect(newHtml).toMatch(/autocomplete="new-password"/i);
  });

  it('uses autocomplete="off" on SignIn and "new-password" on SecretEditor', () => {
    const signInHtml = renderToStaticMarkup(createElement(SignIn, { onSignedIn: () => undefined }));
    expect(signInHtml).toMatch(/autocomplete="off"/i);
    expect(signInHtml).not.toMatch(/autocomplete="new-password"/i);

    const secretHtml = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(SecretEditor, {
          row: {
            pack: "fal",
            name: "FAL_KEY",
            label: "fal.ai API key",
            help_url: null,
            required: true,
            granted: true,
            present: false,
            source: null,
          },
          autoOpen: true,
          onChanged: () => undefined,
        }),
      ),
    );
    expect(secretHtml).toMatch(/autocomplete="new-password"/i);
  });
});
