#!/usr/bin/env tsx
// scripts/doctor.ts: `pnpm check`, the same check as `plughive doctor`
// (src/cli/doctor.ts). Offline: no server required, no network.
import { processIo } from "../src/cli/args.js";
import { runDoctor } from "../src/cli/doctor.js";

process.exitCode = await runDoctor(process.argv.slice(2), processIo());
