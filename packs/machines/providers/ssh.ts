// packs/machines/providers/ssh.ts
//
// SSH provider over the system `ssh` binary, run through ctx.spawn (argv array,
// no local shell). File transfer also goes over `ssh` (stdin for uploads,
// base64 on stdout for downloads), so no scp/sftp path semantics are involved.
//
// Host key policy: StrictHostKeyChecking=accept-new against the pack's OWN
// known_hosts file (<dataDir>/known_hosts) only. The user's ~/.ssh/known_hosts
// and the system-wide files are neither read nor written, and servers cannot
// push extra keys (UpdateHostKeys=no). The FIRST connection to a host trusts
// and records its key; a CHANGED key fails. Only allow-listed hosts are ever
// contacted (policy.ts), so first-contact trust is limited to hosts the user
// listed.
//
// A machine registered with a `host_key` (one known_hosts line) instead pins
// that key: StrictHostKeyChecking=yes against a per-machine file
// (<dataDir>/host_keys/<name>) holding exactly that line, so even the first
// connection must present the pinned key. Pinning is opt-in; without it the
// accept-new behaviour above applies.
//
// ssh config files are not read (-F none): the registered host, user, port and
// identity are all that decide where and how we connect, so no ProxyCommand,
// LocalCommand or forwarding can come in through ~/.ssh/config either.
//
// Auth is explicit only: an identity_file is used with IdentitiesOnly=yes; the
// agent (SSH_AUTH_SOCK) and ssh's default ~/.ssh keys are used ONLY when the
// machine was registered with use_agent / use_default_keys, and a machine with
// no auth method at all is refused before ssh runs. Uploads and downloads
// refuse symlinks at the remote leaf (the remote side is a shell, so the pack
// cannot canonicalise a remote directory tree; the remote account's own
// permissions are the boundary there).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PackContext, SpawnError } from "plughive/pack";
import { type AccessPolicy, assertTargetAllowed, hostAllowed, identityAllowed } from "../policy.js";
import { shellQuote } from "../shell.js";
import type { MachineRecord, MachineStore } from "../state.js";
import type {
  MachineInfo,
  MachineProvider,
  MachineStatus,
  RunOptions,
  RunResult,
} from "./types.js";

export interface SshProviderOptions {
  store: MachineStore;
  spawn: PackContext["spawn"];
  dataDir: string;
  /** Path of the ssh-agent socket (pack setting `sshAuthSock`); the child env is otherwise bare. */
  agentSocket?: string | undefined;
  connectTimeoutSeconds?: number;
  /** The allow-lists, checked before every connection. */
  policy: AccessPolicy;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars
const UNSAFE_OPTION_VALUE = /["\u0000-\u001f\u007f]/;
const MODE_PATTERN = /^[0-7]{3,4}$/;

export function targetLabel(m: MachineRecord): string {
  const host = m.ssh.host.includes(":") ? `[${m.ssh.host}]` : m.ssh.host;
  return `${m.ssh.user}@${host}:${m.ssh.port}`;
}

/** The per-machine pinned host key file (one known_hosts line) inside dataDir. */
export function hostKeyFilePath(dataDir: string, machine: string): string {
  // machine names match NAME_PATTERN (no separators), so this stays one file.
  return join(dataDir, "host_keys", machine);
}

/**
 * Make sure the pinned-key file exists and holds exactly the registered line.
 * Called before every connection of a pinned machine, so a deleted or edited
 * file is restored (and a hand-edited state line is what gets written).
 */
function ensureHostKeyFile(dataDir: string, m: MachineRecord): void {
  const line = m.ssh.hostKey;
  if (line === null || line === undefined) return;
  const dir = join(dataDir, "host_keys");
  const file = hostKeyFilePath(dataDir, m.name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let current: string | null = null;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    /* missing: written below */
  }
  if (current !== `${line}\n`) writeFileSync(file, `${line}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** The full ssh argv for one remote command. Exported for tests. */
export function buildSshArgs(
  m: MachineRecord,
  remoteCommand: string,
  opts: { dataDir: string; connectTimeoutSeconds: number },
): string[] {
  if (UNSAFE_OPTION_VALUE.test(opts.dataDir)) {
    throw new Error("the pack data directory path contains characters ssh options cannot carry");
  }
  const pinned = m.ssh.hostKey ?? null;
  const knownHosts = `"${pinned !== null ? hostKeyFilePath(opts.dataDir, m.name) : join(opts.dataDir, "known_hosts")}"`;
  const args = [
    "-T", // no pty
    "-a", // no agent forwarding
    "-x", // no X11 forwarding
    "-F",
    "none",
    "-o",
    "BatchMode=yes",
    // A pinned machine must present exactly its registered key, even on the
    // first connection; otherwise first contact trusts and records the key.
    "-o",
    pinned !== null ? "StrictHostKeyChecking=yes" : "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-o",
    `GlobalKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-o",
    "UpdateHostKeys=no",
    "-o",
    `ConnectTimeout=${Math.max(1, Math.floor(opts.connectTimeoutSeconds))}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "LogLevel=ERROR",
    "-p",
    String(m.ssh.port),
    "-l",
    m.ssh.user,
  ];
  if (m.ssh.identityFile !== null) {
    // An explicit key file: only that key is offered (IdentitiesOnly also
    // stops the agent's other keys from being tried).
    args.push("-o", "IdentitiesOnly=yes", "-i", m.ssh.identityFile);
  } else if (m.ssh.useDefaultKeys || m.ssh.useAgent) {
    if (!m.ssh.useDefaultKeys) {
      // Agent only: IdentityFile=none drops the default ~/.ssh key files
      // while the agent (SSH_AUTH_SOCK, passed only when useAgent) is still
      // consulted, because IdentitiesOnly is not set.
      args.push("-o", "IdentityFile=none");
    }
    // useDefaultKeys: no IdentityFile option, so ssh tries its default files.
  } else {
    // No auth method configured: offer nothing at all, fail closed. (The
    // provider refuses earlier with a clearer message; this keeps the argv
    // itself safe if buildSshArgs is ever called directly.)
    args.push("-o", "IdentityFile=none", "-o", "IdentitiesOnly=yes");
  }
  // "--" ends option parsing: nothing after it can be read as an ssh option.
  args.push("--", m.ssh.host, remoteCommand);
  return args;
}

export class SshProvider implements MachineProvider {
  readonly kind = "ssh";

  constructor(private readonly opts: SshProviderOptions) {}

  private machine(id: string): MachineRecord {
    const m = this.opts.store.getMachine(id);
    if (m.provider !== "ssh") throw new Error(`machine "${id}" is not an ssh machine`);
    // A stored machine whose host or key was taken off the lists is refused.
    assertTargetAllowed(this.opts.policy, m.ssh, m.name);
    // No silent auth fallback: without identity_file, use_agent or
    // use_default_keys the machine has no auth method and is refused here,
    // before ssh could try the user's default keys or an agent.
    if (m.ssh.identityFile === null && !m.ssh.useAgent && !m.ssh.useDefaultKeys) {
      throw new Error(
        `machine "${id}" has no auth method: pass identity_file, use_agent=true or use_default_keys=true when registering it. The pack never falls back to ssh's default keys or an agent on its own.`,
      );
    }
    // A pinned machine always has its key file in place before connecting.
    ensureHostKeyFile(this.opts.dataDir, m);
    return m;
  }

  async list(): Promise<MachineInfo[]> {
    return this.opts.store
      .read()
      .machines.filter((m) => m.provider === "ssh")
      .map((m) => ({
        id: m.name,
        provider: "ssh",
        target: targetLabel(m),
        details: {
          auth: m.ssh.identityFile
            ? "identity_file"
            : [
                ...(m.ssh.useAgent ? ["agent"] : []),
                ...(m.ssh.useDefaultKeys ? ["default_keys"] : []),
              ].join("+") || "none",
          allowed:
            hostAllowed(this.opts.policy, m.ssh) &&
            identityAllowed(this.opts.policy, m.ssh.identityFile),
          ...(m.ssh.identityFile ? { identity_file: m.ssh.identityFile } : {}),
          ...(m.ssh.hostKey ? { host_key: "pinned" } : {}),
        },
      }));
  }

  async run(id: string, command: string, opts: RunOptions): Promise<RunResult> {
    const m = this.machine(id);
    const args = buildSshArgs(m, command, {
      dataDir: this.opts.dataDir,
      connectTimeoutSeconds: this.opts.connectTimeoutSeconds ?? 10,
    });
    const env: Record<string, string> = {};
    // The agent socket is handed to ssh only when the machine explicitly
    // opted in with use_agent (and the user configured sshAuthSock).
    if (this.opts.agentSocket && m.ssh.useAgent) env.SSH_AUTH_SOCK = this.opts.agentSocket;
    const started = Date.now();
    try {
      const r = await this.opts.spawn("ssh", args, {
        timeoutMs: opts.timeoutMs,
        maxOutputBytes: opts.maxOutputBytes,
        env,
        ...(opts.input !== undefined ? { input: opts.input } : {}),
      });
      const durationMs = Date.now() - started;
      // The partial output is kept; the note says why the command stopped.
      const note = r.timedOut
        ? `ssh was stopped after the ${opts.timeoutMs} ms timeout`
        : r.truncated
          ? `output exceeded ${opts.maxOutputBytes} bytes; ssh was stopped (raise max_output_bytes or filter the output remotely, e.g. | tail -n 200)`
          : null;
      if (note !== null) {
        return {
          stdout: r.stdout,
          stderr: r.stderr ? `${r.stderr}\n${note}` : note,
          exitCode: null,
          truncated: r.truncated,
          timedOut: r.timedOut,
          durationMs,
        };
      }
      return {
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.exitCode,
        truncated: false,
        timedOut: false,
        durationMs,
      };
    } catch (err) {
      const code = err instanceof SpawnError ? err.code : null;
      if (code === "not_started" || code === "not_installed") {
        throw new Error("could not start ssh: is OpenSSH installed and on PATH?");
      }
      throw err;
    }
  }

  async status(id: string): Promise<MachineStatus> {
    const timeoutMs = ((this.opts.connectTimeoutSeconds ?? 10) + 10) * 1000;
    const r = await this.run(id, "uname -srm", { timeoutMs, maxOutputBytes: 64 * 1024 });
    // ssh itself exits 255 on connection / auth / host key failures.
    const reachable = r.exitCode !== null && r.exitCode !== 255;
    return {
      id,
      reachable,
      latencyMs: r.durationMs,
      ...(reachable ? { info: r.stdout.trim().slice(0, 500) } : {}),
      ...(!reachable ? { error: (r.stderr.trim() || "connection failed").slice(0, 2000) } : {}),
    };
  }

  async putFile(
    id: string,
    remotePath: string,
    bytes: Uint8Array,
    opts: { timeoutMs: number; mode?: string },
  ): Promise<{ bytes: number }> {
    if (opts.mode !== undefined && !MODE_PATTERN.test(opts.mode)) {
      throw new Error("mode must be an octal string like 644 or 0600");
    }
    const p = shellQuote(remotePath);
    // The remote side always runs a shell, and this pack cannot canonicalise
    // a remote directory tree (remote_path may be any absolute path the
    // remote account can reach; there is no remote allow-list to contain it
    // in), so uploads refuse symlinks at the leaf: the named path must be the
    // file itself, never a link to somewhere else.
    const script = [
      `if [ -L ${p} ]; then echo "refusing to upload through a remote symlink" >&2; exit 6; fi`,
      `if [ -e ${p} ] && [ ! -f ${p} ]; then echo "remote path exists and is not a regular file" >&2; exit 7; fi`,
      `cat > ${p} || exit 1`,
      ...(opts.mode ? [`chmod ${opts.mode} ${p}`] : []),
    ].join("\n");
    const r = await this.run(id, script, {
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: 64 * 1024,
      input: bytes,
    });
    if (r.timedOut) throw new Error(`upload timed out after ${opts.timeoutMs} ms`);
    if (r.exitCode !== 0) {
      throw new Error(`upload failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 2000)}`);
    }
    return { bytes: bytes.byteLength };
  }

  async getFile(
    id: string,
    remotePath: string,
    opts: { timeoutMs: number; maxBytes: number },
  ): Promise<Uint8Array> {
    const max = Math.floor(opts.maxBytes);
    // First line: exact size (integrity check), then the content as base64.
    // A symlink at the leaf is refused: the pack reads the named file itself,
    // never what a link points at (see putFile for why full remote-directory
    // containment cannot be checked from here).
    const script = [
      `f=${shellQuote(remotePath)}`,
      `if [ -L "$f" ]; then echo "refusing to download a remote symlink" >&2; exit 3; fi`,
      `[ -f "$f" ] || { echo "not a regular file" >&2; exit 3; }`,
      `s=$(wc -c < "$f" | tr -d ' ') || exit 4`,
      `[ "$s" -le ${max} ] || { echo "file is $s bytes, over the ${max} byte limit" >&2; exit 5; }`,
      `echo "$s"`,
      `base64 < "$f"`,
    ].join("\n");
    const encodedCap = Math.ceil(max / 3) * 4 + Math.ceil(max / 48) + 64;
    const r = await this.run(id, script, { timeoutMs: opts.timeoutMs, maxOutputBytes: encodedCap });
    if (r.timedOut) throw new Error(`download timed out after ${opts.timeoutMs} ms`);
    if (r.truncated) throw new Error(`download is larger than ${max} bytes`);
    if (r.exitCode !== 0) {
      throw new Error(`download failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 2000)}`);
    }
    const nl = r.stdout.indexOf("\n");
    const size = Number(r.stdout.slice(0, nl).trim());
    const bytes = Buffer.from(r.stdout.slice(nl + 1), "base64");
    if (nl < 0 || !Number.isInteger(size) || bytes.byteLength !== size) {
      throw new Error("download was corrupted in transit (size mismatch)");
    }
    return new Uint8Array(bytes);
  }
}
