// packs/share/index.ts
//
// Public links for library artifacts: upload the artifact to an S3-compatible
// bucket (Cloudflare R2 or AWS S3) and return a presigned GET URL that expires.
//   PutObject:    https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html
//   DeleteObject: https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html
//   Presigning:   https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
//   R2:           https://developers.cloudflare.com/r2/api/s3/presigned-urls/
// Every request is signed locally (sigv4.ts) with short-lived presigned URLs,
// so the secret access key never leaves the process. A presigned link carries
// the access key ID (not the secret) in X-Amz-Credential, as all S3 links do.
import { openAsBlob } from "node:fs";
import { type PackContext, type PackFetchInit, definePack, defineTool, z } from "plughive/pack";
import { readCapped, scrub, send } from "./http.js";
import { MAX_PRESIGN_SECONDS, encodeKeyPath, presignUrl } from "./sigv4.js";

/** Lifetime of the signed upload and delete requests themselves. */
const OP_SECONDS = 900;
/** S3's single-PUT limit. */
const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;
const DEFAULT_MAX_EXPIRY = 86_400;
const DEFAULT_PREFIX = "plughive/";

interface Target {
  base: string;
  bucket: string;
  region: string;
  prefix: string;
  maxExpiry: number;
  accessKeyId: string;
  secretAccessKey: string;
}

function setting(ctx: PackContext, name: string): string | null {
  const v = ctx.settings[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

async function target(ctx: PackContext): Promise<Target> {
  const endpoint = setting(ctx, "endpoint");
  const bucket = setting(ctx, "bucket");
  if (!endpoint || !bucket) {
    throw new Error(
      "set this pack's endpoint and bucket settings first (for R2: https://<account id>.r2.cloudflarestorage.com)",
    );
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("the endpoint setting is not a URL");
  }
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("the endpoint setting must be a bare https origin, like https://host");
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw new Error("the bucket setting is not a valid bucket name");
  }
  const prefix = setting(ctx, "keyPrefix") ?? DEFAULT_PREFIX;
  if (
    !/^[A-Za-z0-9!_.*'()/-]{0,200}$/.test(prefix) ||
    prefix.split("/").some((seg) => seg === "." || seg === "..")
  ) {
    throw new Error("the keyPrefix setting may hold only letters, digits, / and -_.!*'()");
  }
  const region =
    setting(ctx, "region") ??
    (url.hostname.endsWith(".r2.cloudflarestorage.com") ? "auto" : "us-east-1");
  if (!/^[a-z0-9-]{1,32}$/.test(region)) throw new Error("the region setting is not valid");
  const rawMax = ctx.settings.maxExpirySeconds;
  const maxExpiry =
    typeof rawMax === "number" && Number.isFinite(rawMax)
      ? Math.max(1, Math.min(MAX_PRESIGN_SECONDS, Math.floor(rawMax)))
      : DEFAULT_MAX_EXPIRY;
  return {
    base: url.origin,
    bucket,
    region,
    prefix,
    maxExpiry,
    accessKeyId: await ctx.secrets.get("SHARE_S3_ACCESS_KEY_ID"),
    secretAccessKey: await ctx.secrets.get("SHARE_S3_SECRET_ACCESS_KEY"),
  };
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
  "application/json": "json",
  "text/plain": "txt",
  "text/csv": "csv",
};

/**
 * The Content-Type an artifact is uploaded with. Only the passive types above
 * keep theirs; anything else (HTML, SVG, XML, JavaScript...) is stored as
 * application/octet-stream, so the bucket's origin downloads it instead of
 * rendering it, and a shared page cannot run script there.
 */
function uploadMime(mime: string): string {
  const [base = "", ...params] = mime.split(";");
  const type = base.trim().toLowerCase();
  if (!EXT[type]) return "application/octet-stream";
  const utf8 = params.some((p) => /^\s*charset\s*=\s*"?utf-8"?\s*$/i.test(p));
  return utf8 ? `${type}; charset=utf-8` : type;
}

/** Object key of an artifact: the prefix, its id and an extension from its mime. */
function objectKey(t: Target, id: string, mime: string): string {
  const ext = EXT[mime.split(";")[0]!.trim().toLowerCase()];
  return `${t.prefix}${id}${ext ? `.${ext}` : ""}`;
}

function objectUrl(t: Target, key: string): string {
  return `${t.base}/${t.bucket}/${encodeKeyPath(key)}`;
}

function sign(
  t: Target,
  method: "GET" | "PUT" | "DELETE",
  url: string,
  expiresIn: number,
  headers?: Record<string, string>,
): string {
  return presignUrl({
    method,
    url,
    region: t.region,
    accessKeyId: t.accessKeyId,
    secretAccessKey: t.secretAccessKey,
    expiresIn,
    ...(headers ? { headers } : {}),
  });
}

/**
 * S3 answers errors in XML. Only <Code> and <Message> are kept: a signature
 * error also echoes the string to sign and the access key id.
 */
async function s3Call(
  ctx: PackContext,
  url: string,
  init: PackFetchInit,
  secrets: readonly string[],
): Promise<Response> {
  let res: Response;
  try {
    res = await send(ctx.fetch, "S3", url, init, secrets);
  } catch (err) {
    // A transport error may quote the URL, and a presigned URL is a live
    // credential until it expires: report the failure without it.
    const e = err as Error;
    if (e.message?.startsWith("S3: request failed")) {
      throw new Error("S3: request failed (network error)");
    }
    // Permission, abort and timeout errors pass through for the router, but
    // never with the signed query string in them.
    if (typeof e?.message === "string" && /X-Amz-/i.test(`${e.message} ${e.stack}`)) {
      e.message = e.message.replace(/\?\S*/g, "");
      e.stack = `${e.name}: ${e.message}`;
    }
    throw err;
  }
  if (res.ok) return res;
  let detail = "";
  try {
    const text = new TextDecoder().decode((await readCapped(res, 16_384)).bytes);
    const code = /<Code>([^<]{1,100})<\/Code>/.exec(text)?.[1];
    const message = /<Message>([^<]{1,300})<\/Message>/.exec(text)?.[1];
    detail = [code, message].filter(Boolean).join(": ");
  } catch {
    // the status alone
  }
  detail = scrub(detail, secrets);
  throw new Error(`S3 ${res.status}${detail ? `: ${detail}` : ""}`);
}

const artifactId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, "an artifact id");

const shareArtifact = defineTool({
  name: "share_artifact",
  description:
    "Publish a library artifact as a public link that expires: uploads it to the configured R2/S3 bucket and returns a presigned download URL. Anyone with the link can download it until it expires (capped by the maxExpirySeconds setting, at most 7 days). share_unshare removes it.",
  secrets: ["SHARE_S3_ACCESS_KEY_ID", "SHARE_S3_SECRET_ACCESS_KEY"],
  // A public link reaches whoever gets it, so ask_before_sending applies.
  tags: ["sends"],
  annotations: {
    title: "Share artifact link",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    artifact_id: artifactId,
    expires_in_s: z.number().int().min(60).max(MAX_PRESIGN_SECONDS).default(3600),
  }),
  async run(input, ctx) {
    const t = await target(ctx);
    if (input.expires_in_s > t.maxExpiry) {
      throw new Error(
        `expires_in_s is over this pack's maxExpirySeconds setting (${t.maxExpiry}); ask for a shorter link`,
      );
    }
    const art = await ctx.library.get(input.artifact_id);
    if (!art) throw new Error(`artifact ${input.artifact_id} not found`);
    if (art.bytes > MAX_UPLOAD_BYTES) throw new Error("the artifact is over the 5 GB upload limit");
    const mime = uploadMime(art.mime);
    const key = objectKey(t, art.id, mime);
    const url = objectUrl(t, key);
    const secrets = [t.secretAccessKey];

    const copy = await ctx.library.materialize(art.id);
    try {
      const body = await openAsBlob(copy.path, { type: mime });
      const put = sign(t, "PUT", url, OP_SECONDS, { "content-type": mime });
      await s3Call(
        ctx,
        put,
        {
          method: "PUT",
          headers: { "Content-Type": mime, "Content-Length": String(copy.bytes) },
          body,
          timeoutMs: 15 * 60_000,
        },
        secrets,
      );
    } finally {
      await copy.cleanup();
    }
    const link = sign(t, "GET", url, input.expires_in_s);
    ctx.logger.info("share uploaded", { artifact: art.id, key });
    return {
      url: link,
      expires_at: new Date(Date.now() + input.expires_in_s * 1000).toISOString(),
      expires_in_s: input.expires_in_s,
      key,
      bucket: t.bucket,
      bytes: copy.bytes,
      mime,
    };
  },
});

const unshare = defineTool({
  name: "share_unshare",
  description:
    "Delete an artifact's shared copy from the R2/S3 bucket, so its links stop working at once.",
  secrets: ["SHARE_S3_ACCESS_KEY_ID", "SHARE_S3_SECRET_ACCESS_KEY"],
  // Like deleting a post: it changes what other people see.
  tags: ["sends"],
  annotations: {
    title: "Remove shared link",
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({ artifact_id: artifactId }),
  async run(input, ctx) {
    const t = await target(ctx);
    const art = await ctx.library.get(input.artifact_id);
    if (!art) throw new Error(`artifact ${input.artifact_id} not found`);
    const key = objectKey(t, art.id, art.mime);
    const del = sign(t, "DELETE", objectUrl(t, key), OP_SECONDS);
    await s3Call(ctx, del, { method: "DELETE", timeoutMs: 60_000 }, [t.secretAccessKey]);
    return { deleted: true, key, bucket: t.bucket };
  },
});

export default definePack({ tools: [shareArtifact, unshare] });
