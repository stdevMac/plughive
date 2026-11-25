# Installing software

plughive can install the local programs its packs use (ffmpeg, yt-dlp,
whisper.cpp and its models, pandoc, ...) for you, or tell you where to get
them. It never uses sudo or admin rights, and every download is checked
against a sha256 that was pinned when the catalog entry was written.

You can install from three places:

- the **Software** page on the dashboard,
- an agent, with the `install_software` tool,
- `setup_plan`, which names what a goal still needs and how to install it.

## The tools

| Tool | What it does |
| --- | --- |
| `list_installable` | The catalog for this computer: version, license, size, how it installs here, whether it is installed. `tag` filters it (video, audio, transcribe, ...). |
| `software_status` | One entry, probed now: installed or not, where, which version. |
| `install_software` | Starts an install as a job (`wait_for_job`), or answers `approval_required`. |
| `uninstall_software` | Removes what plughive installed. Software installed another way is left alone; the answer says how to remove it. |
| `setup_plan` | What a goal ("transcribe meetings", "make short videos", ...) still needs, free and local options first. |

## How an entry installs

The catalog lives in `src/core/installer/catalog.json`. For each entry, the
first method that applies on this computer wins:

1. **Pinned download.** A file from a GitHub release for this OS and CPU. It
   is checked against its sha256, unpacked into
   `<home>/tools/<id>/<version>/`, and its programs are linked into
   `<home>/tools/bin`. An entry can bring more than one file: ffmpeg comes
   with ffprobe, each file with its own sha256.
2. **uv.** A Python tool installed with `uv tool install <name>==<version>`,
   always pinned, into the same tools folder. The catalog's own uv is
   installed first when there is none.
3. **Package manager.** Homebrew (macOS) or winget (Windows), in your user
   scope. This needs your approval.
4. **apt.** Never run by plughive, because it needs sudo. You get the
   command to run yourself.
5. **Link only.** Detected, not installed: you get the official install page.
   The agent CLIs (`claude`, `codex`, `opencode`, `agy`) and Kokoro are
   handled this way.

A pinned download wins over Homebrew and winget, so the same version is
installed on every OS.

### Model files

A **model** entry is a data file, not a program. It is a file on Hugging
Face, pinned to one commit (`/resolve/<40-hex commit>/<file>`) and checked
against its sha256. It is saved into the data folder of the pack that uses it.

| Entry | File | Size |
| --- | --- | --- |
| `whisper-model-base` | `ggml-base.bin` (multilingual) | 148 MB |
| `whisper-model-large-v3-turbo` | `ggml-large-v3-turbo-q5_0.bin` | 574 MB, asks first |

Both go to `<home>/pack-data/local/models/`, where the local pack's
transcription already looks for models, so no setting is needed. When more
than one model is there, the pack uses `ggml-base.bin`. To use the large
model, set the pack setting `whisperModelPath` to its file.

`setup_plan` offers whisper.cpp together with the base model. The step counts
as done only when both are installed. Each part is still installed with its
own `install_software` call.

## Approvals

An install starts right away unless one of these applies:

- the entry is gated (LibreOffice, whisperX, Docker),
- it is over 200 MB,
- it goes through Homebrew or winget and an agent asked for it.

Then `install_software` answers `approval_required`. The request appears on
the **Approvals** page (and in Telegram, when that is set up; see
[spend-and-approvals.md](spend-and-approvals.md)). Approve it there, or press
**Install** on the Software page, which counts as your approval. The agent
then calls `install_software` once more. An agent cannot approve its own
install.

## What keeps installed programs honest

`<home>/tools/lock.json` records, for each install:

- the version,
- the method,
- the sha256 of the download,
- the path and sha256 of every program it put in `tools/bin`.

For a model it records the file's path relative to `<home>`.

Packs may run programs from `tools/bin` only through this lock. Before each
run, the spawn layer checks two things: the program's real path must be the
one in the lock, and its sha256 must still match. If a program was swapped or
edited after install, it does not run. Nothing else under `<home>` is trusted.

A new install is picked up without restarting the daemon or reloading the
pack.

On a filesystem without symlinks (some Windows setups), the program in
`tools/bin` is a copy, and the same lock check applies to it.

Uninstall removes only what the lock says plughive installed. A model is
removed from the path the catalog gives, never from a path read out of the
lock.

## Detection

Software already on the computer counts too. Each entry has a probe: a
command and the output it must print (for example `ffmpeg -version`), a local
HTTP endpoint for a service such as Ollama, or a fixed install location such
as an app bundle. The probe runs against `tools/bin` and your `PATH`. Results
are cached for 5 minutes; the Software page's refresh probes again.

The version shown is the one the program reports. The ffmpeg download for
macOS on Apple silicon (ffmpeg-static release b6.1.1) reports itself as
ffmpeg 6.0, even though the catalog lists 6.1.1, the release name.

## Admin API

All of these need the admin token; the `POST` routes also need the CSRF
header (see [security.md](security.md)).

| Route | What it does |
| --- | --- |
| `GET /api/software` | Every entry offered here, with its state. `?fresh=1` probes again. |
| `GET /api/software/:id` | One entry, probed now. |
| `POST /api/software/:id/install` | `{approve?: true, force?: true}`. `approve` is a person allowing a gated, large or package-manager install. |
| `POST /api/software/:id/uninstall` | Removes what plughive installed. |
| `GET /api/advisor/goals` | The goals `setup_plan` knows. |
| `GET /api/advisor/plan?goal=` | What a goal still needs on this computer. |

## Adding an entry

Every entry needs its license, its size and a probe (a model entry has no
probe). These rules apply:

- **Downloads:** https on `github.com` release hosts only, with the sha256 of
  the exact file. Compute the sha256 from the file itself; never copy it from
  somewhere else unchecked.
- **uv packages:** pinned as `name==version`.
- **Models:** only `huggingface.co/<owner>/<repo>/resolve/<commit>/<file>`,
  with the file's sha256 (Hugging Face shows it as the LFS "SHA256" of the
  file).

The schema (`catalog.ts`) refuses anything else, and the tests in
`tests/core/installer/` check every entry.
