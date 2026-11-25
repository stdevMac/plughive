// A tool result: media inline, text parts as text, the rest as JSON.
import { useMemo, useState } from "react";
import { t } from "../i18n";
import { formatDuration } from "../lib/format";
import {
  type MediaRef,
  absoluteUrl,
  extractMedia,
  isArtifactUrl,
  sameOriginArtifactUrl,
  textParts,
} from "../lib/media";
import { Link } from "../lib/router";
import { Icon } from "./Icon";
import { CopyButton } from "./ui";

export function MediaView({
  media,
  compact,
}: { media: Pick<MediaRef, "url" | "kind" | "label" | "mime">; compact?: boolean }) {
  const src = sameOriginArtifactUrl(media.url);
  const [broken, setBroken] = useState(false);
  const name = media.label ?? src.split("?")[0]?.split("/").pop() ?? "file";
  // Only same-origin links render inline (the page's CSP allows 'self' media
  // only); a link to another host is shown as a plain link.
  const inline = src.startsWith("/");
  if (!inline || broken) {
    return (
      <div className="media-missing">
        <Icon name="file" />
        <span>{t("library.media.cannotShow")}</span>
        <a href={src} target="_blank" rel="noreferrer noopener">
          {t("library.media.openIt")}
        </a>
      </div>
    );
  }
  switch (media.kind) {
    case "image":
      return (
        <img
          className={compact ? "media media-thumb" : "media"}
          src={src}
          alt={
            media.label
              ? t("library.media.altResult", { label: media.label })
              : t("library.media.altImage")
          }
          loading="lazy"
          onError={() => setBroken(true)}
        />
      );
    case "video":
      return (
        // biome-ignore lint/a11y/useMediaCaption: generated media has no captions
        <video
          className="media"
          src={src}
          controls
          preload="metadata"
          onError={() => setBroken(true)}
        />
      );
    case "audio":
      return (
        // biome-ignore lint/a11y/useMediaCaption: generated media has no captions
        <audio
          className="media-audio"
          src={src}
          controls
          preload="metadata"
          onError={() => setBroken(true)}
        />
      );
    default:
      return (
        <a className="media-file" href={src} target="_blank" rel="noreferrer noopener">
          <Icon name="file" />
          {name}
        </a>
      );
  }
}

export function JsonView({
  value,
  label = t("library.json.defaultLabel"),
}: { value: unknown; label?: string }) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2) ?? "undefined";
    } catch {
      return String(value);
    }
  }, [value]);
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">JSON</span>
        <CopyButton text={text} what={label} variant="ghost" />
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable code block must be reachable by keyboard to scroll it */}
      <pre tabIndex={0} aria-label={label} className="json">
        <code>{text}</code>
      </pre>
    </div>
  );
}

export function ResultView({
  result,
  durationMs,
}: { result: unknown; durationMs?: number | null }) {
  const media = useMemo(() => extractMedia(result), [result]);
  const texts = useMemo(() => textParts(result), [result]);
  const plain = typeof result === "string" ? result : null;
  return (
    <div className="result">
      {durationMs !== undefined && durationMs !== null ? (
        <p className="result-meta">
          <Icon name="clock" />
          {t("library.result.finishedIn", { duration: formatDuration(durationMs) })}
        </p>
      ) : null}
      {media.length > 0 ? (
        <div className={`result-media ${media.length > 1 ? "result-media-grid" : ""}`}>
          {media.map((m) => (
            <figure key={m.url} className="result-figure">
              <MediaView media={m} />
              <figcaption>
                <a href={sameOriginArtifactUrl(m.url)} target="_blank" rel="noreferrer noopener">
                  {t("library.result.openFile")}
                </a>
                <CopyButton
                  text={absoluteUrl(sameOriginArtifactUrl(m.url)) ?? m.url}
                  label={t("library.result.copyLink")}
                  what={t("library.copy.fileLink")}
                  variant="ghost"
                />
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      {media.some((m) => isArtifactUrl(m.url)) ? (
        <p className="result-saved small">
          <Icon name="check" /> {t("library.result.savedTo")}
          <Link to="/library">{t("library.result.openLibrary")}</Link>
        </p>
      ) : null}
      {plain !== null ? <pre className="result-text">{plain}</pre> : null}
      {texts.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: text parts are ordered
        <pre className="result-text" key={i}>
          {t}
        </pre>
      ))}
      {plain === null ? (
        <details className="result-json" open={media.length === 0 && texts.length === 0}>
          <summary>
            <Icon name="chevronRight" className="details-chevron" />
            {t("library.result.fullResult")}
          </summary>
          <JsonView value={result} />
        </details>
      ) : null}
    </div>
  );
}
