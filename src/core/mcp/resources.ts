// src/core/mcp/resources.ts
//
// MCP resources and prompts, next to the tools of the same exposure profile.
//
//   Resources: library artifacts as `artifact://<id>`. resources/list pages
//   through the library (newest first), resources/read returns the file as
//   text (text/*, JSON) or as a base64 blob with its media type, and the
//   template `artifact://{id}` names any artifact. A profile sees resources
//   only when it exposes `list_artifacts`, the tool that already lists the
//   whole library: resources never show a profile more than its tools do.
//   A read resolves the id through the library and refuses any file that is
//   not inside the library's artifacts folder (symlinks resolved), so no URI
//   can name a file elsewhere on disk.
//
//   Prompts: one per workflow (`wf_<name>`) the profile exposes. The
//   workflow's top-level input properties are the prompt's arguments;
//   prompts/get returns a user message that asks the model to dry-run, then
//   run, the workflow tool with those arguments. A prompt runs nothing.
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
} from "@modelcontextprotocol/server";
import type { Exposure } from "../profiles.js";
import type { RegisteredTool } from "../tools/registry.js";

export const ARTIFACT_URI_PREFIX = "artifact://";
export const ARTIFACT_URI_TEMPLATE = "artifact://{id}";
/** Artifacts per resources/list page. */
export const RESOURCE_PAGE_SIZE = 50;
/** Largest file resources/read returns; larger ones are fetched through their URL. */
export const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
/** The tool whose exposure turns resources on for a profile. */
export const RESOURCES_GATE_TOOL = "list_artifacts";
const MAX_OFFSET = 1_000_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TEXT_MIME = /^(?:text\/[a-z0-9.+-]+|application\/(?:json|x-subrip|[a-z0-9.+-]+\+json))$/;

/** The part of the Library resources need. */
export interface ResourceLibrary {
  get(id: string): ResourceArtifact | null;
  list(filter: Record<string, never>, limit: number, offset: number): ResourceArtifact[];
  /** The library folder; artifacts live in `<root>/artifacts`. */
  readonly rootValue?: string;
}

export interface ResourceArtifact {
  id: string;
  kind?: string;
  mime: string;
  path: string;
  bytes: number;
  tool?: string;
  prompt?: string | null;
  createdAt?: string;
}

export interface McpResourceItem {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
  size: number;
}

const invalidParams = (message: string) =>
  new ProtocolError(ProtocolErrorCode.InvalidParams, message);

/** Whether this exposure may see the library. */
export function resourcesVisible(exposure: Pick<Exposure, "exposed">): boolean {
  return exposure.exposed.some((t) => t.name === RESOURCES_GATE_TOOL);
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: unknown): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (typeof cursor !== "string" || cursor.length > 64) throw invalidParams("invalid cursor");
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const m = /^o:(\d{1,7})$/.exec(text);
  const n = m ? Number(m[1]) : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_OFFSET) throw invalidParams("invalid cursor");
  return n;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function itemOf(a: ResourceArtifact, redact?: (text: string) => string): McpResourceItem {
  const label = a.kind ? `${a.kind} ${a.id}` : a.id;
  const parts = [a.tool ? `made by ${a.tool}` : "", a.createdAt ? `on ${a.createdAt}` : ""].filter(
    Boolean,
  );
  // The prompt is redacted whole, before it is cut, so no part of a secret pasted
  // into it is listed.
  const raw = typeof a.prompt === "string" ? (redact ? redact(a.prompt) : a.prompt) : "";
  const prompt = raw.trim() ? oneLine(raw, 160) : "";
  const description = [parts.join(" "), prompt ? `prompt: ${prompt}` : ""]
    .filter(Boolean)
    .join("; ");
  return {
    uri: `${ARTIFACT_URI_PREFIX}${a.id}`,
    name: a.id,
    title: label,
    ...(description ? { description } : {}),
    mimeType: a.mime,
    size: a.bytes,
  };
}

/** One page of resources/list. */
export function listResources(
  library: ResourceLibrary,
  cursor: unknown,
  redact?: (text: string) => string,
): { resources: McpResourceItem[]; nextCursor?: string } {
  const offset = decodeCursor(cursor);
  // One extra row tells whether another page exists.
  const rows = library.list({}, RESOURCE_PAGE_SIZE + 1, offset);
  const page = rows.slice(0, RESOURCE_PAGE_SIZE);
  return {
    resources: page.map((a) => itemOf(a, redact)),
    ...(rows.length > RESOURCE_PAGE_SIZE
      ? { nextCursor: encodeCursor(offset + RESOURCE_PAGE_SIZE) }
      : {}),
  };
}

export function resourceTemplates() {
  return {
    resourceTemplates: [
      {
        uriTemplate: ARTIFACT_URI_TEMPLATE,
        name: "artifact",
        title: "Library artifact",
        description:
          "A file in the plughive library, by id (img_…, vid_…, aud_…, pdf_…, doc_…, dat_…, art_…). Ids come from tool results and list_artifacts.",
      },
    ],
  };
}

function strictlyInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/** The artifact id named by an `artifact://<id>` URI, or null. */
export function artifactIdOf(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri.startsWith(ARTIFACT_URI_PREFIX)) return null;
  const id = uri.slice(ARTIFACT_URI_PREFIX.length);
  return ID.test(id) ? id : null;
}

/**
 * resources/read of one artifact. Unknown ids, ids the library does not hold
 * and files outside its artifacts folder all answer "resource not found".
 */
export function readResource(library: ResourceLibrary, uri: unknown) {
  const id = artifactIdOf(uri);
  const notFound = () =>
    new ResourceNotFoundError(typeof uri === "string" ? uri.slice(0, 200) : "");
  if (!id) throw notFound();
  const artifact = library.get(id);
  if (!artifact || artifact.id !== id || typeof artifact.path !== "string") throw notFound();
  const root = library.rootValue;
  if (!root || !isAbsolute(artifact.path) || artifact.path.includes("\0")) throw notFound();
  let fd: number | undefined;
  let data: Buffer;
  try {
    const realRoot = realpathSync(join(root, "artifacts"));
    const real = realpathSync(artifact.path);
    if (!strictlyInside(realRoot, real)) throw notFound();
    fd = openSync(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) throw notFound();
    if (st.size > MAX_RESOURCE_BYTES) {
      throw invalidParams(
        `${artifact.id} is ${st.size} bytes, over the ${MAX_RESOURCE_BYTES} byte limit of resources/read; open it through its link (list_artifacts gives the url)`,
      );
    }
    data = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, data, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    data = data.subarray(0, read);
  } catch (err) {
    if (err instanceof ProtocolError) throw err;
    throw notFound();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const mime = (artifact.mime.split(";", 1)[0] ?? "").trim().toLowerCase();
  const uriText = `${ARTIFACT_URI_PREFIX}${artifact.id}`;
  if (TEXT_MIME.test(mime)) {
    return { contents: [{ uri: uriText, mimeType: artifact.mime, text: data.toString("utf8") }] };
  }
  return { contents: [{ uri: uriText, mimeType: artifact.mime, blob: data.toString("base64") }] };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments: McpPromptArgument[];
}

interface JsonProp {
  type?: unknown;
  description?: unknown;
  enum?: unknown;
  default?: unknown;
}

function properties(tool: RegisteredTool): Record<string, JsonProp> {
  const props = (tool.inputSchema as { properties?: unknown }).properties;
  if (props === null || typeof props !== "object") return {};
  const out: Record<string, JsonProp> = {};
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (k === "dry_run" || v === null || typeof v !== "object") continue;
    out[k] = v as JsonProp;
  }
  return out;
}

function requiredOf(tool: RegisteredTool): Set<string> {
  const req = (tool.inputSchema as { required?: unknown }).required;
  return new Set(Array.isArray(req) ? req.filter((r): r is string => typeof r === "string") : []);
}

function typeOf(p: JsonProp): string {
  if (typeof p.type === "string") return p.type;
  if (Array.isArray(p.type)) return p.type.filter((t) => t !== "null").join("|");
  return "string";
}

function argDescription(p: JsonProp): string {
  const parts: string[] = [];
  if (typeof p.description === "string" && p.description.trim())
    parts.push(oneLine(p.description, 200));
  const type = typeOf(p);
  if (type !== "string") parts.push(`(${type}, as JSON)`);
  if (Array.isArray(p.enum))
    parts.push(`one of ${p.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  return parts.join(" ") || type;
}

/** The workflows of this exposure as prompts. */
export function workflowPrompts(exposure: Pick<Exposure, "exposed">): RegisteredTool[] {
  return exposure.exposed.filter((t) => t.origin === "workflow");
}

export function promptOf(tool: RegisteredTool): McpPrompt {
  const required = requiredOf(tool);
  const firstParagraph = tool.description.split(/\n\s*\n/, 1)[0] ?? tool.description;
  return {
    name: tool.name,
    ...(tool.annotations?.title ? { title: tool.annotations.title } : {}),
    description: oneLine(firstParagraph, 400),
    arguments: Object.entries(properties(tool)).map(([name, p]) => ({
      name,
      description: argDescription(p),
      ...(required.has(name) ? { required: true } : {}),
    })),
  };
}

export function listPrompts(exposure: Pick<Exposure, "exposed">): { prompts: McpPrompt[] } {
  return { prompts: workflowPrompts(exposure).map(promptOf) };
}

/** Prompt arguments are strings: values of a non-string property are read as JSON when they parse. */
function coerce(p: JsonProp, value: string): unknown {
  if (typeOf(p) === "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function getPrompt(exposure: Pick<Exposure, "exposed">, name: unknown, args: unknown) {
  // Same answer for "does not exist" and "not in this profile".
  const tool =
    typeof name === "string" ? workflowPrompts(exposure).find((t) => t.name === name) : undefined;
  if (!tool)
    throw invalidParams(`unknown prompt: ${typeof name === "string" ? name.slice(0, 80) : ""}`);
  const given = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const props = properties(tool);
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(given)) {
    const p = Object.hasOwn(props, k) ? props[k] : undefined;
    if (!p) throw invalidParams(`unknown argument for ${tool.name}: ${k.slice(0, 80)}`);
    if (typeof v !== "string") throw invalidParams(`argument ${k} must be a string`);
    input[k] = coerce(p, v);
  }
  const missing = [...requiredOf(tool)].filter((r) => r !== "dry_run" && !(r in input));
  if (missing.length > 0) throw invalidParams(`missing required arguments: ${missing.join(", ")}`);
  const title = tool.annotations?.title ?? tool.name;
  const text = [
    `Run the plughive workflow "${title}" (tool ${tool.name}).`,
    "",
    `First call ${tool.name} with these arguments plus "dry_run": true to see the steps, what is missing and how many paid calls it can make. If the plan is blocked, tell me what to fix. Otherwise call it again without dry_run. It runs as a job: wait for it with the job tools and show me the result and its artifacts.`,
    "",
    "Arguments:",
    "```json",
    JSON.stringify(input, null, 2),
    "```",
  ].join("\n");
  return {
    description: promptOf(tool).description,
    messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
  };
}
