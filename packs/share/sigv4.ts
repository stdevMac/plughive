// packs/share/sigv4.ts
//
// AWS Signature Version 4 presigned URLs (query-string authentication), done
// locally with node:crypto so the pack needs no SDK:
//   https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
// The payload is not signed (UNSIGNED-PAYLOAD), as S3 allows for presigned
// URLs. Cloudflare R2 accepts the same signatures with region "auto".
import { createHash, createHmac } from "node:crypto";
import { noControl } from "./http.js";

/** S3's hard ceiling for a presigned URL's lifetime: 7 days. */
export const MAX_PRESIGN_SECONDS = 604_800;

export interface PresignInput {
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  /** Full URL without query string, e.g. https://host/bucket/key. */
  url: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Lifetime in seconds, 1 to 604800. */
  expiresIn: number;
  /** Signing time. Default: now. */
  now?: Date;
  /** Extra headers the request will send and that are signed (lowercase names). */
  headers?: Record<string, string>;
  /** Extra query parameters, signed with the rest (e.g. response-content-disposition). */
  query?: Record<string, string>;
}

/** RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encodes each path segment of an object key, keeping the slashes. */
export function encodeKeyPath(path: string): string {
  return path.split("/").map(rfc3986).join("/");
}

/** "20130524T000000Z" */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** Returns the URL with the X-Amz-* query parameters and signature added. */
export function presignUrl(input: PresignInput): string {
  const expires = Math.floor(input.expiresIn);
  if (!(expires >= 1 && expires <= MAX_PRESIGN_SECONDS)) {
    throw new RangeError(`expiresIn must be 1 to ${MAX_PRESIGN_SECONDS} seconds`);
  }
  const u = new URL(input.url);
  if (u.search) throw new Error("presignUrl takes a URL without a query string");
  const service = input.service ?? "s3";
  const time = amzDate(input.now ?? new Date());
  const day = time.slice(0, 8);
  const scope = `${day}/${input.region}/${service}/aws4_request`;

  const headers: Record<string, string> = { host: u.host };
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    // A name or value that could split the canonical request is refused.
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) || !noControl(v)) {
      throw new Error(`presignUrl: header ${JSON.stringify(k)} is not a valid header`);
    }
    headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  }
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");

  const params: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", time],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ];
  for (const [k, v] of Object.entries(input.query ?? {})) {
    if (/^x-amz-(algorithm|credential|date|expires|signedheaders|signature)$/i.test(k)) {
      throw new Error(`presignUrl: query parameter ${JSON.stringify(k)} is set by the signer`);
    }
    if (!noControl(k) || !noControl(v)) {
      throw new Error(`presignUrl: query parameter ${JSON.stringify(k)} has control characters`);
    }
    params.push([k, v]);
  }
  const query = params
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  // URL already holds the path percent-encoded once, which is what S3 signs.
  const canonical = [
    input.method,
    u.pathname || "/",
    query,
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", time, scope, sha256Hex(canonical)].join("\n");

  const kDate = hmac(`AWS4${input.secretAccessKey}`, day);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign, "utf8").digest("hex");
  return `${u.origin}${u.pathname}?${query}&X-Amz-Signature=${signature}`;
}
