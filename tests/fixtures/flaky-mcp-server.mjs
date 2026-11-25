// A dependency-free stdio MCP server for mount reconnect tests. Each session
// that lists tools appends "session N" to the file named by argv[2]. The first
// such session exits shortly after answering (a crash); later ones stay up.
// (The client may start a short-lived process first to probe the server;
// that one never lists tools, so it is not counted.)
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.argv[2];
const sessions = () =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === "initialize") {
    send({
      id: m.id,
      result: {
        protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "flaky", version: "1.0.0" },
      },
    });
  } else if (m.method === "tools/list") {
    const n = sessions() + 1;
    appendFileSync(log, `session ${n}\n`);
    send({
      id: m.id,
      result: { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }] },
    });
    if (n === 1) setTimeout(() => process.exit(1), 50);
  } else if (m.id !== undefined) {
    send({ id: m.id, error: { code: -32601, message: "no such method" } });
  }
});
