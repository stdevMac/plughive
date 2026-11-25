---
name: sandbox
description: Run code or shell commands in isolation, on E2B or Daytona cloud sandboxes or in a throwaway local Docker container (sandbox_create, sandbox_run_command, sandbox_run_code, sandbox_write_file, sandbox_read_file, sandbox_destroy, docker_run). Use when the user wants untrusted or generated code executed without touching their machine.
---

# Sandboxes

## Cloud (E2B, Daytona)

1. `sandbox_create` with `provider` ("e2b" or "daytona"); keep the `sandbox_id`.
2. `sandbox_write_file` (text `content` or a library `artifact_id`), then `sandbox_run_command` or `sandbox_run_code` (python or javascript).
3. `sandbox_read_file` to get results back; `save_to_library: true` stores images, videos and other outputs as artifacts.
4. `sandbox_destroy` when done. Sandboxes bill while running; do not leave them up.

`template` is the E2B template (default "base") or the Daytona snapshot.

## Local Docker

`docker_run` runs one command in a fresh container from an image in the `allowedImages` setting. It sees only `/work`, seeded from `files`; list outputs in `collect` to save them to the library. No network unless the user turned on `allowNetwork`. Needs docker installed; if docker cannot find its socket, the user sets `dockerHost`.

## Setup

The pack is off by default; the user enables it. Secrets `E2B_API_KEY` and `DAYTONA_API_KEY`, one per provider. If a call fails with `MISSING_SECRET`, tell the user which secret to set.
