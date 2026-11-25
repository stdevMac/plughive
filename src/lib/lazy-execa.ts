// src/lib/lazy-execa.ts: execa, loaded on first use.
//
// execa pulls in about 100 modules (~60 ms of CPU) that the daemon only needs
// once a tool spawns a program or the installer runs one. Loading it on demand
// keeps it off the startup path. The promise is shared, so the cost is paid
// once.
let loading: Promise<typeof import("execa")> | undefined;

export function loadExeca(): Promise<typeof import("execa")> {
  loading ??= import("execa");
  return loading;
}
