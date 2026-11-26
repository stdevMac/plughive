// src/cli/raw.ts
//
//   plughive api <METHOD> <path> [--data JSON|@file|-]
//   plughive watch            (alias: events)
//
// The escape hatch (anything the dashboard can do, through the same /api it
// uses) and the live feed the dashboard listens to.
import type { HttpMethod } from "./api.js";
import { CliError, type CliIo, EXIT_FAIL, EXIT_OK, EXIT_USAGE, jsonText } from "./args.js";
import { COMMON_HELP, readJsonInput, sub } from "./common.js";

export const API_HELP = `Usage: plughive api <METHOD> <path> [options]

Calls the daemon's management API with the admin token, as the dashboard
does, and prints the JSON answer. Exits 1 when the status is 4xx or 5xx.

  METHOD                GET, POST, PUT, PATCH or DELETE
  path                  /api/... (the leading /api may be left out)
  --data JSON           the request body (or @file, or - for stdin)
  --include             print the HTTP status first

${COMMON_HELP}

Examples:
  plughive api GET /api/info
  plughive api PUT /api/preferences --data '{"locale":"fr"}'`;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export async function runApi(argv: string[], io: CliIo): Promise<number> {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    io.out(API_HELP);
    return argv.length ? EXIT_OK : EXIT_USAGE;
  }
  const { values, positionals, ctx } = sub(
    "api",
    argv,
    io,
    { data: { type: "string", short: "d" }, include: { type: "boolean", short: "i" } },
    { min: 2, max: 2, usage: "<METHOD> <path> [--data JSON]" },
  );
  const method = (positionals[0] ?? "").toUpperCase();
  if (!METHODS.has(method))
    throw new CliError(`"${positionals[0]}" is not GET, POST, PUT, PATCH or DELETE`, EXIT_USAGE);
  let path = positionals[1] ?? "";
  if (!path.startsWith("/")) path = `/${path}`;
  if (!path.startsWith("/api/") && path !== "/api") path = `/api${path}`;
  const body = values.data !== undefined ? readJsonInput(values.data, "--data") : undefined;
  if (body !== undefined && (method === "GET" || method === "DELETE"))
    throw new CliError(`a ${method} has no body`, EXIT_USAGE);
  const res = await ctx.api().raw(method as HttpMethod, path, body, { timeoutMs: 0 });
  if (values.include) io.err(`HTTP ${res.status}`);
  if (res.body !== undefined && res.body !== null) {
    (res.status >= 400 ? io.err : io.out)(
      typeof res.body === "string" ? res.body : jsonText(res.body, 2),
    );
  }
  return res.status >= 400 ? EXIT_FAIL : EXIT_OK;
}

// ---- watch ------------------------------------------------------------------

export const WATCH_HELP = `Usage: plughive watch [options]

Follows the daemon's live events, as the dashboard does: jobs starting and
finishing, packs changing state, approvals requested and decided. Stops on
Ctrl-C.

  --only KINDS          job, pack and/or approval, comma-separated
  --json                one JSON object per line: {"event": ..., "data": ...}
  --home DIR            the plughive home (default ~/.plughive)`;

interface Frame {
  event: string;
  data: unknown;
}

/** The most of one event the CLI holds while waiting for its end. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Splits an SSE byte stream into frames; comments and malformed data are skipped. */
export async function* sseFrames(
  body: ReadableStream<Uint8Array>,
  maxFrame = MAX_FRAME_BYTES,
): AsyncGenerator<Frame> {
  const decoder = new TextDecoder();
  let buf = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      // Normalised on the whole buffer: a "\r\n" can be split across two chunks.
      buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let end = buf.indexOf("\n\n");
      while (end !== -1) {
        const chunk = buf.slice(0, end);
        buf = buf.slice(end + 2);
        end = buf.indexOf("\n\n");
        let event = "message";
        const data: string[] = [];
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (!data.length) continue;
        try {
          yield { event, data: JSON.parse(data.join("\n")) };
        } catch {
          // Not JSON: skipped.
        }
      }
      if (buf.length > maxFrame) throw new CliError("the daemon sent an event that is too large");
    }
  } finally {
    reader.releaseLock();
  }
}

function describe(f: Frame): string | null {
  const time = new Date().toLocaleTimeString();
  const d = f.data as Record<string, unknown>;
  switch (f.event) {
    case "job": {
      const progress = d.progress as { message?: string; percent?: number } | null | undefined;
      const err = d.error as { message?: string } | string | null | undefined;
      const extra =
        d.status === "failed" && err
          ? `: ${typeof err === "string" ? err : (err.message ?? "")}`
          : progress?.message
            ? `: ${progress.message}${progress.percent !== undefined ? ` (${progress.percent}%)` : ""}`
            : "";
      return `${time}  job       ${d.job_id} ${d.tool ?? ""} ${d.status}${extra}`;
    }
    case "pack":
      return `${time}  pack      ${d.id} ${d.state}${d.enabled === false ? " (off)" : ""}${d.error ? `: ${d.error}` : ""}`;
    case "approval":
      return `${time}  approval  ${d.id} ${d.tool} ${d.status} (${d.pending} pending)`;
    default:
      return null;
  }
}

export async function runWatch(argv: string[], io: CliIo): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.out(WATCH_HELP);
    return EXIT_OK;
  }
  const { values, ctx } = sub("watch", argv, io, { only: { type: "string" } });
  const only = values.only ? new Set(values.only.split(",").map((s) => s.trim())) : null;
  if (only) {
    for (const k of only) {
      if (!["job", "pack", "approval"].includes(k))
        throw new CliError(`--only: "${k}" is not job, pack or approval`, EXIT_USAGE);
    }
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  try {
    const res = await ctx.api().stream("/api/events", controller.signal);
    if (!res.body) throw new CliError("the daemon sent no event stream");
    if (!ctx.json) io.err("Watching jobs, packs and approvals. Ctrl-C to stop.");
    for await (const f of sseFrames(res.body)) {
      if (f.event === "hello") continue;
      if (only && !only.has(f.event)) continue;
      if (ctx.json) io.out(jsonText(f));
      else {
        const line = describe(f);
        if (line) io.out(line);
      }
    }
    io.err("The daemon closed the stream.");
    return EXIT_FAIL;
  } catch (e) {
    if (controller.signal.aborted) return EXIT_OK;
    throw e;
  } finally {
    process.off("SIGINT", stop);
  }
}
