// packs/local/index.ts
//
// Zero-key tools that run on this machine, and the free last-resort providers
// (priority 10) for most capabilities. Every backend (ffmpeg, the speech
// engines, Ollama, Kokoro, ComfyUI and the command-line tools in imaging.ts,
// documents.ts and transcript.ts) is detected at call time, never assumed: a
// missing one produces an error that says how to install or start it.
import { definePack } from "plughive/pack";
import { LIFETIME_FETCH, comfyTools } from "./comfy.js";
import { kokoroTools } from "./kokoro.js";
import { sweepStaleWorkDirs } from "./lib/util.js";
import { mediaTools } from "./media.js";
import { ollamaTools } from "./ollama.js";
import { sheetTools } from "./sheet.js";
import { statusTools } from "./status.js";
import { whisperTools } from "./whisper.js";

import { providers } from "./capabilities.js";

export { capabilities } from "./capabilities.js";

export default definePack({
  providers,
  tools: [
    ...statusTools,
    ...mediaTools,
    ...sheetTools,
    ...ollamaTools,
    ...whisperTools,
    ...kokoroTools,
    ...comfyTools,
  ],
  setup(ctx) {
    // Work dirs a crashed daemon left behind; never blocks loading.
    void sweepStaleWorkDirs(ctx.pack.dataDir)
      .then((n) => {
        if (n > 0) ctx.logger.info(`removed ${n} stale work folder(s)`);
      })
      .catch(() => undefined);
    // A fetch bound to the pack lifetime, so the ComfyUI stop request after a cancel still goes out.
    return { [LIFETIME_FETCH]: ctx.fetch };
  },
});
