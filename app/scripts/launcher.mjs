// Payload entry point used by the menu-bar app (copied to app/launcher.mjs).
//
// Orphan guard: the app spawns node with a stdin pipe it never writes to and
// never closes while it is alive. When the app goes away for ANY reason
// (normal quit, crash, SIGKILL, force quit) the kernel closes the write end,
// stdin reaches EOF and the daemon shuts down through its own SIGTERM handler.
// A ppid poll is a second, independent guard (reparenting to launchd).
const parent = process.ppid;
let stopping = false;
function stop(why) {
  if (stopping) return;
  stopping = true;
  console.error(`[launcher] ${why}; shutting down`);
  process.kill(process.pid, "SIGTERM");
  setTimeout(() => process.exit(0), 5000).unref();
}
if (process.env.PLUGHIVE_PARENT_WATCH === "1") {
  process.stdin.on("end", () => stop("parent pipe closed"));
  process.stdin.on("error", () => stop("parent pipe error"));
  process.stdin.resume();
  setInterval(() => {
    if (process.ppid !== parent) stop(`parent ${parent} gone`);
  }, 2000).unref();
}
// Keep V8's compiled code on disk, in a private per-user directory, so every
// start after the first reads the daemon's modules from the cache instead of
// compiling them again (a few percent of startup CPU; docs/performance.md). It
// must be on before the daemon's modules load; compile-cache.js imports only
// node: built-ins. NODE_DISABLE_COMPILE_CACHE=1 turns it off.
try {
  (await import("../dist/src/lib/compile-cache.js")).enablePrivateCompileCache();
} catch {
  /* the cache only costs speed */
}
// server.js only boots itself when it is the process entry point, so the
// launcher starts it explicitly.
const { startDaemon } = await import("../dist/src/server.js");
try {
  await startDaemon();
} catch (e) {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exit(1);
}
