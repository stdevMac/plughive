// Smoke test against a running daemon: health, initialize, tools/list and
// list_artifacts, all free. `generate_image` is a paid provider call, so it
// runs only with an explicit `--paid` flag: `pnpm smoke -- --paid`.
import { config } from "dotenv";
config();

const PAID = process.argv.slice(2).includes("--paid");

const base = process.env.PLUGHIVE_URL ?? "http://127.0.0.1:7777";

let sessionId: string | undefined;
let nextId = 1;

async function rpc(
  method: string,
  params: unknown,
  expectResponse = true,
): // biome-ignore lint/suspicious/noExplicitAny: smoke script reads JSON-RPC replies loosely
Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const body = expectResponse
    ? { jsonrpc: "2.0", id: nextId++, method, params }
    : { jsonrpc: "2.0", method, params };

  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const incomingSession = r.headers.get("mcp-session-id");
  if (incomingSession) sessionId = incomingSession;

  if (!expectResponse) return null; // notifications have no response

  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  const ct = r.headers.get("content-type") ?? "";
  const raw = await r.text();
  if (ct.includes("text/event-stream")) {
    const line = raw.split("\n").find((l) => l.startsWith("data: "));
    return line ? JSON.parse(line.slice(6)) : null;
  }
  return JSON.parse(raw);
}

console.log("health:", await (await fetch(`${base}/health`)).json());

console.log("initialize...");
const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "plughive-smoke", version: "0.1.0" },
});
console.log("  session:", sessionId);
console.log("  server:", init.result?.serverInfo);

await rpc("notifications/initialized", {}, false);

console.log("tools/list...");
const list = await rpc("tools/list", {});
const tools = list.result?.tools ?? [];
console.log(`  ${tools.length} tools:`, tools.map((t: { name: string }) => t.name).join(", "));

if (PAID) {
  console.log("calling generate_image (paid)...");
  const out = await rpc("tools/call", {
    name: "generate_image",
    arguments: { prompt: "A tiny red square on white background, flat illustration" },
  });
  const firstPayload = JSON.parse(out.result.content[0].text);
  if (!firstPayload.ok) {
    console.error("generate_image failed:", JSON.stringify(firstPayload.error, null, 2));
    process.exit(1);
  }
  const img = firstPayload.result.artifacts[0];
  console.log(`  artifact: ${img.id}  ${img.bytes} bytes  ${img.mime}  $${img.cost_usd}`);
  console.log(`  url: ${img.url}`);
} else {
  console.log("skipping generate_image: it is a paid call; pass --paid to run it");
}

console.log("calling list_artifacts...");
const listed = await rpc("tools/call", { name: "list_artifacts", arguments: { limit: 5 } });
const listPayload = JSON.parse(listed.result.content[0].text);
if (!listPayload.ok) {
  console.error("list_artifacts failed:", JSON.stringify(listPayload.error, null, 2));
  process.exit(1);
}
console.log(`  ${listPayload.result.artifacts.length} artifact(s) listed`);
