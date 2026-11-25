// Library: every file the tools have made.
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { Icon, type IconName } from "../components/Icon";
import { MediaView } from "../components/ResultView";
import { useToast } from "../components/Toast";
import {
  Button,
  CopyButton,
  EmptyState,
  ErrorState,
  IconButton,
  Loading,
  PageHeader,
  Segmented,
} from "../components/ui";
import { t } from "../i18n";
import { api, errorMessage } from "../lib/api";
import { artifactSource, formatBytes, formatRelative, formatTime, formatUsd } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";
import {
  type MediaKind,
  absoluteUrl,
  artifactDownloadUrl,
  sameOriginArtifactUrl,
} from "../lib/media";
import { Link, useRouter } from "../lib/router";
import type { Artifact } from "../lib/types";

type KindFilter = "all" | "image" | "video" | "audio" | "document";
const PAGE = 48;

interface ArtifactsResponse {
  artifacts: Artifact[];
  total: number;
  limit: number;
  offset: number;
}

const KIND_ICON: Record<string, IconName> = {
  image: "image",
  video: "video",
  audio: "audio",
  pdf: "file",
  document: "file",
  data: "code",
  other: "file",
};

function kindLabel(kind: string): string {
  switch (kind) {
    case "image":
      return t("library.kind.image");
    case "video":
      return t("library.kind.video");
    case "audio":
      return t("library.kind.audio");
    case "pdf":
      return t("library.kind.pdf");
    case "document":
      return t("library.kind.document");
    case "data":
      return t("library.kind.data");
    default:
      return t("library.kind.file");
  }
}

function emptyTitle(kind: KindFilter): string {
  switch (kind) {
    case "image":
      return t("library.empty.images");
    case "video":
      return t("library.empty.video");
    case "audio":
      return t("library.empty.audio");
    case "document":
      return t("library.empty.documents");
    default:
      return t("library.empty.all");
  }
}

function mediaKind(k: Artifact["kind"]): MediaKind {
  return k === "image" || k === "video" || k === "audio" || k === "pdf" ? k : "file";
}

// Never throws: an unparsable url in a row is copied as it is.
const absolute = (url: string) => absoluteUrl(sameOriginArtifactUrl(url)) ?? url;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function Tile({ a, onOpen }: { a: Artifact; onOpen: () => void }) {
  // No prompt: name it by what it is and when, not by the tool (which repeats on every tile).
  // The prompt says what it is; without one, the file name or the tool that made it.
  const fileName = a.path ? a.path.split("/").pop() : undefined;
  const kind = kindLabel(a.kind);
  const label =
    a.prompt ??
    fileName ??
    (a.tool
      ? t("library.tile.fromTool", { kind, source: artifactSource(a.tool).label })
      : t("library.tile.madeAt", { kind, time: formatTime(a.createdAt) }));
  const video = useRef<HTMLVideoElement>(null);
  // Video previews play muted while hovered or focused, and stop when you leave.
  const play = () => {
    if (!video.current || prefersReducedMotion()) return;
    void video.current.play().catch(() => undefined);
  };
  const stop = () => {
    if (!video.current) return;
    video.current.pause();
    video.current.currentTime = 0;
  };
  const src = sameOriginArtifactUrl(a.url);
  return (
    <li className="tile">
      <button
        type="button"
        className="tile-btn"
        onClick={onOpen}
        onMouseEnter={play}
        onMouseLeave={stop}
        onFocus={play}
        onBlur={stop}
        aria-label={t("library.tile.ariaLabel", { kind, label, time: formatRelative(a.createdAt) })}
      >
        <span className="tile-media">
          {a.kind === "image" ? (
            <MediaView
              media={{ url: a.url, kind: "image", label: a.prompt, mime: a.mime }}
              compact
            />
          ) : a.kind === "video" ? (
            <>
              <video
                ref={video}
                src={src}
                muted
                loop
                playsInline
                preload="metadata"
                tabIndex={-1}
                aria-hidden="true"
              />
              <span className="tile-badge">
                <Icon name="video" size={12} /> {t("library.kind.video")}
              </span>
            </>
          ) : (
            <span className="tile-icon">
              <Icon name={KIND_ICON[a.kind] ?? "file"} size={32} />
              <span className="small">{kind}</span>
            </span>
          )}
        </span>
        <span className="tile-text">
          <span className="tile-title">{label}</span>
          <span className="tile-meta">{formatRelative(a.createdAt)}</span>
        </span>
      </button>
    </li>
  );
}

function Lightbox({
  a,
  onClose,
  onDeleted,
  onStep,
  position,
}: {
  a: Artifact;
  onClose: () => void;
  onDeleted: (id: string) => void;
  onStep: ((dir: -1 | 1) => void) | null;
  position: string;
}) {
  const href = sameOriginArtifactUrl(a.url);
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Left and right arrows walk the library, unless a player or the delete confirm has the keys.
  useEffect(() => {
    if (!onStep || asking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("video, audio, input, textarea, select") || t.isContentEditable)) return;
      e.preventDefault();
      onStep(e.key === "ArrowLeft" ? -1 : 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onStep, asking]);

  const remove = async () => {
    setAsking(false);
    setDeleting(true);
    try {
      await api.del(`/api/artifacts/${encodeURIComponent(a.id)}`);
      toast.ok(t("library.lightbox.deleted"));
      onDeleted(a.id);
    } catch (e) {
      toast.error(t("library.lightbox.deleteFailed", { error: errorMessage(e) }));
      setDeleting(false);
    }
  };

  const kind = kindLabel(a.kind);
  return (
    <Dialog
      open
      onClose={onClose}
      title={a.prompt ?? kind}
      description={[a.prompt ? kind : null, formatTime(a.createdAt), position || null]
        .filter(Boolean)
        .join(" · ")}
      size="xl"
      initialFocus=".dialog-foot .btn-primary"
      footer={
        <>
          <Button
            variant="ghost"
            icon="trash"
            busy={deleting}
            onClick={() => setAsking(true)}
            className="lightbox-delete"
          >
            {t("library.lightbox.delete")}
          </Button>
          <CopyButton
            text={absolute(a.url)}
            label={t("library.lightbox.copyLink")}
            what={t("library.copy.fileLink")}
            size="md"
          />
          <a className="btn btn-primary" href={artifactDownloadUrl(href)} download>
            <Icon name="download" /> {t("library.lightbox.download")}
          </a>
        </>
      }
    >
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        role="alertdialog"
        size="sm"
        title={t("library.deleteDialog.title")}
        footer={
          <>
            <Button variant="secondary" data-autofocus onClick={() => setAsking(false)}>
              {t("library.deleteDialog.keep")}
            </Button>
            <Button variant="danger" icon="trash" onClick={() => void remove()}>
              {t("library.deleteDialog.confirm")}
            </Button>
          </>
        }
      >
        <p>{t("library.deleteDialog.body", { kind: kind.toLowerCase() })}</p>
      </Dialog>
      <div className="lightbox">
        {onStep ? (
          <IconButton
            icon="chevronLeft"
            label={t("library.lightbox.previous")}
            onClick={() => onStep(-1)}
          />
        ) : (
          <span />
        )}
        <div className="lightbox-media">
          <MediaView
            key={a.id}
            media={{ url: a.url, kind: mediaKind(a.kind), label: a.prompt, mime: a.mime }}
          />
        </div>
        {onStep ? (
          <IconButton
            icon="chevronRight"
            label={t("library.lightbox.next")}
            onClick={() => onStep(1)}
          />
        ) : (
          <span />
        )}
      </div>
      <dl className="lightbox-meta">
        <div>
          <dt>{t("library.meta.madeBy")}</dt>
          <dd>
            {a.tool ? (
              artifactSource(a.tool).tool ? (
                <Link to={`/playground?tool=${encodeURIComponent(a.tool)}`} className="mono">
                  {a.tool}
                </Link>
              ) : (
                artifactSource(a.tool).label
              )
            ) : (
              t("library.meta.unknown")
            )}
          </dd>
        </div>
        {a.model ? (
          <div>
            <dt>{t("library.meta.model")}</dt>
            <dd>{a.model}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("library.meta.size")}</dt>
          <dd>
            {formatBytes(a.bytes)} · {a.mime}
          </dd>
        </div>
        {a.cost_usd === null ? null : (
          <div>
            <dt>{t("library.meta.cost")}</dt>
            <dd>{formatUsd(a.cost_usd, { estimate: true })}</dd>
          </div>
        )}
        <div>
          <dt>{t("library.meta.id")}</dt>
          <dd className="lightbox-id">
            <code className="small">{a.id}</code>
            <CopyButton
              text={a.id}
              what={t("library.copy.fileId")}
              variant="ghost"
              iconOnly
              size="sm"
            />
          </dd>
        </div>
      </dl>
    </Dialog>
  );
}

export function LibraryPage() {
  useDocumentTitle(t("library.title"));
  const { query, setQuery } = useRouter();
  const kind = (query.get("kind") as KindFilter | null) ?? "all";
  const openId = query.get("artifact");
  const data = useResource(
    (signal) =>
      api.get<ArtifactsResponse>(
        "/api/artifacts",
        { kind: kind === "all" ? undefined : kind, limit: PAGE },
        signal,
      ),
    [kind],
  );
  const [items, setItems] = useState<Artifact[]>([]);
  const [more, setMore] = useState(false);
  const toast = useToast();

  useEffect(() => setItems(data.data?.artifacts ?? []), [data.data]);

  const loadMore = async () => {
    setMore(true);
    try {
      const r = await api.get<ArtifactsResponse>("/api/artifacts", {
        kind: kind === "all" ? undefined : kind,
        limit: PAGE,
        offset: items.length,
      });
      setItems((cur) => [...cur, ...r.artifacts.filter((a) => !cur.some((x) => x.id === a.id))]);
    } catch (e) {
      toast.error(t("library.loadMoreFailed", { error: errorMessage(e) }));
    } finally {
      setMore(false);
    }
  };

  const openIndex = items.findIndex((a) => a.id === openId);
  const open = openIndex >= 0 ? items[openIndex] : undefined;
  const total = data.data?.total ?? 0;
  const step = useCallback(
    (dir: -1 | 1) => {
      if (items.length < 2 || openIndex < 0) return;
      const next = items[(openIndex + dir + items.length) % items.length];
      if (next) setQuery({ artifact: next.id }, { replace: true });
    },
    [items, openIndex, setQuery],
  );

  return (
    <>
      <PageHeader title={t("library.header.title")} description={t("library.header.description")} />
      <div className="toolbar">
        <Segmented<KindFilter>
          label={t("library.filter.label")}
          value={kind}
          onChange={(v) => setQuery({ kind: v === "all" ? null : v, artifact: null })}
          options={[
            { value: "all", label: t("library.filter.all") },
            { value: "image", label: t("library.filter.image") },
            { value: "video", label: t("library.filter.video") },
            { value: "audio", label: t("library.filter.audio") },
            { value: "document", label: t("library.filter.document") },
          ]}
        />
        {data.data ? (
          <span className="small muted">{t("library.filesCount", { count: total })}</span>
        ) : null}
      </div>
      {data.loading && !data.data ? (
        <Loading lines={6} />
      ) : data.error && !data.data ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : items.length === 0 ? (
        <EmptyState
          icon="image"
          title={emptyTitle(kind)}
          action={
            kind === "all" ? (
              <Link to="/playground" className="btn btn-primary">
                {t("library.empty.openPlayground")}
              </Link>
            ) : (
              <Button variant="secondary" onClick={() => setQuery({ kind: null })}>
                {t("library.empty.showAll")}
              </Button>
            )
          }
        >
          {t("library.empty.body")}
        </EmptyState>
      ) : (
        <>
          <ul className="tiles" aria-label={t("library.list.ariaLabel")}>
            {items.map((a) => (
              <Tile
                key={a.id}
                a={a}
                onOpen={() => setQuery({ artifact: a.id }, { replace: false })}
              />
            ))}
          </ul>
          {items.length < total ? (
            <div className="table-foot">
              <Button variant="secondary" onClick={loadMore} busy={more}>
                {t("library.showMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {open ? (
        <Lightbox
          a={open}
          onStep={items.length > 1 ? step : null}
          position={
            items.length > 1 ? t("library.lightbox.position", { index: openIndex + 1, total }) : ""
          }
          onClose={() => setQuery({ artifact: null }, { replace: false })}
          onDeleted={(id) => {
            setItems((cur) => cur.filter((x) => x.id !== id));
            setQuery({ artifact: null }, { replace: true });
            data.reload();
          }}
        />
      ) : null}
    </>
  );
}
