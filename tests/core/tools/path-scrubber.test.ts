import { expect, it } from "vitest";
import { createPathScrubber } from "../../../src/core/tools/registry.js";
it("scrubs Windows paths case-insensitively with either slash, and POSIX paths exactly", () => {
  const s = createPathScrubber(
    { home: "C:\\Users\\Me", dataDir: "C:\\Users\\Me\\.plughive" },
    "win32",
  );
  expect(s("at c:/users/me/.plughive/x and C:\\\\Users\\\\Me\\\\doc and C:\\Users\\Me")).toBe(
    "at $PLUGHIVE_HOME/x and ~\\\\doc and ~",
  );
  const p = createPathScrubber({ home: "/Users/me" }, "darwin");
  expect(p("/Users/me/a /users/me")).toBe("~/a /users/me");
});
