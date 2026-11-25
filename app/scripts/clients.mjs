// app/scripts/clients.mjs  (copied to app/clients.mjs in the bundled daemon)
//
// Bridge between the menu-bar app and the "connect a client" module
// (dist/src/clients). The app runs it with the bundled Node:
//
//   node app/clients.mjs   < request.json   > response.json
//
// The request comes on stdin, so an access key never shows up in the process
// list. One JSON object per call:
//
//   { "op": "list",       "home": "/Users/me" }
//   { "op": "connect",    "home": ..., "id": "cursor", "url": "http://127.0.0.1:61234/mcp", "accessKey"?: ... }
//   { "op": "disconnect", "home": ..., "id": "cursor" }
//   { "op": "retarget",   "home": ..., "from": "http://127.0.0.1:61234/mcp", "url": ..., "accessKey"?: ... }
//       rewrites every connected client whose entry points at `from` (the
//       app's previous URL) to `url`; used when the app had to change its
//       port. Entries pointing anywhere else are left alone.
//
// Response: { "ok": true, "result": ... } or { "ok": false, "error": "..." }.
// Output never contains the access key: results carry paths, flags and notes only.

import {
  connectClient,
  disconnectClient,
  listClients,
  planConnect,
} from "../dist/src/clients/index.js";

const NAME = "plughive";

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function isLoopbackUrl(u) {
  try {
    const h = new URL(u).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
  } catch {
    return false;
  }
}

function run(req) {
  const env = { home: req.home, name: NAME };
  switch (req.op) {
    case "list":
      return listClients(env).map(
        ({ id, name, configPath, installed, connected, url, restartHint, error }) => ({
          id,
          name,
          configPath,
          installed,
          connected,
          url: url ?? null,
          restartHint,
          error: error ?? null,
        }),
      );
    case "connect": {
      const opts = { ...env, url: req.url, accessKey: req.accessKey || undefined };
      const { note } = planConnect(req.id, opts);
      const r = connectClient(req.id, opts);
      const info = listClients(env).find((c) => c.id === req.id);
      return { ...r, note: note ?? null, restartHint: info?.restartHint ?? null };
    }
    case "disconnect": {
      const r = disconnectClient(req.id, env);
      const info = listClients(env).find((c) => c.id === req.id);
      return { ...r, restartHint: info?.restartHint ?? null };
    }
    case "retarget": {
      if (typeof req.from !== "string" || !req.from) throw new Error("from is required");
      const out = [];
      for (const c of listClients(env)) {
        if (!c.connected || c.url !== req.from || c.url === req.url || !isLoopbackUrl(c.url))
          continue;
        try {
          const r = connectClient(c.id, {
            ...env,
            url: req.url,
            accessKey: req.accessKey || undefined,
          });
          out.push({
            id: c.id,
            name: c.name,
            path: r.path,
            changed: r.changed,
            restartHint: c.restartHint,
            error: null,
          });
        } catch (err) {
          out.push({
            id: c.id,
            name: c.name,
            path: c.configPath,
            changed: false,
            restartHint: c.restartHint,
            error: String(err.message),
          });
        }
      }
      return out;
    }
    default:
      throw new Error(`unknown op ${JSON.stringify(req.op)}`);
  }
}

try {
  const req = JSON.parse(await readStdin());
  if (!req || typeof req.home !== "string" || !req.home) throw new Error("home is required");
  process.stdout.write(`${JSON.stringify({ ok: true, result: run(req) })}\n`);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.message ?? err) })}\n`);
  process.exitCode = 1;
}
