// packs/machines/providers/cloud-stub.ts
//
// STUB, NOT REGISTERED. Shows where a cloud provider (Runpod, E2B, Daytona,
// Fly) plugs in. To add one for real:
//   1. Implement MachineProvider here, talking to the vendor API via ctx.fetch
//      (declare the API host in pack.json permissions.network and the API key
//      in pack.json secrets, then read it with ctx.secrets.get).
//   2. Widen MachineRecordSchema.provider in ../state.ts to include the kind,
//      with the vendor's machine/sandbox id stored on the record.
//   3. Return it from providersFor() in ../index.ts for that kind.
// run() maps to the vendor's command endpoint (or to ssh once the sandbox
// exposes it); create()/destroy() become a machine_create / machine_destroy
// tool pair. The other tools need no change.
import type { MachineInfo, MachineProvider, MachineStatus, RunResult } from "./types.js";

export class CloudProviderStub implements MachineProvider {
  readonly kind = "cloud-stub";

  private notImplemented(): never {
    throw new Error("cloud providers are not implemented yet; only ssh machines are supported");
  }

  async list(): Promise<MachineInfo[]> {
    return [];
  }

  async status(_id: string): Promise<MachineStatus> {
    return this.notImplemented();
  }

  async run(_id: string, _command: string): Promise<RunResult> {
    return this.notImplemented();
  }
}
