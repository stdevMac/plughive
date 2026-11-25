// packs/machines/providers/types.ts
//
// The provider seam. Tools speak only to this interface, so a cloud provider
// (Runpod, E2B, Daytona, Fly) plugs in by implementing it and being added to
// providersFor() in ../index.ts; the tool surface does not change.

export interface MachineInfo {
  /** The registered machine name (what tools take as `machine`). */
  id: string;
  provider: string;
  /** Human-readable target, e.g. "deploy@1.2.3.4:22". Never a credential. */
  target: string;
  details?: Record<string, unknown>;
}

export interface MachineStatus {
  id: string;
  reachable: boolean;
  latencyMs: number;
  /** Short system description when reachable (untrusted remote output). */
  info?: string;
  error?: string;
}

export interface RunOptions {
  /** Kills the local client process when exceeded. */
  timeoutMs: number;
  /** Cap per stream (stdout, stderr). */
  maxOutputBytes: number;
  /** Bytes for the remote command's stdin. */
  input?: Uint8Array;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  /** null when the process did not exit by itself (timeout, cap, cancel). */
  exitCode: number | null;
  /** The output cap was hit; the process was stopped and its output dropped. */
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface CreateSpec {
  name: string;
  [key: string]: unknown;
}

export interface MachineProvider {
  readonly kind: string;
  list(): Promise<MachineInfo[]>;
  /** Cloud providers: provision a machine. SSH hosts are registered, not created. */
  create?(spec: CreateSpec): Promise<MachineInfo>;
  /** Cloud providers: tear a machine down. */
  destroy?(id: string): Promise<void>;
  status(id: string): Promise<MachineStatus>;
  /** `command` is a shell string evaluated by the remote side. */
  run(id: string, command: string, opts: RunOptions): Promise<RunResult>;
  putFile?(
    id: string,
    remotePath: string,
    bytes: Uint8Array,
    opts: { timeoutMs: number; mode?: string },
  ): Promise<{ bytes: number }>;
  getFile?(
    id: string,
    remotePath: string,
    opts: { timeoutMs: number; maxBytes: number },
  ): Promise<Uint8Array>;
}
