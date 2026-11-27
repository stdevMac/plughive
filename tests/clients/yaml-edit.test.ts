// tests/clients/yaml-edit.test.ts
import { describe, expect, it } from "vitest";
import {
  getYamlEntry,
  hasYamlEntry,
  removeYamlEntry,
  setYamlEntry,
} from "../../src/clients/yaml-edit.js";

const BOM = "﻿";

describe("D-M16: yaml-edit and a UTF-8 byte order mark", () => {
  const text = `${BOM}mcp_servers:\n  other:\n    url: "http://x"\n`;

  it("reads the first section of a file that starts with a BOM", () => {
    expect(hasYamlEntry(text, "mcp_servers", "other")).toBe(true);
    expect(getYamlEntry(text, "mcp_servers", "other")).toEqual({ url: "http://x" });
  });

  it("edits the existing section instead of adding a second one, keeping the BOM", () => {
    const out = setYamlEntry(text, "mcp_servers", "plughive", { url: "http://y" });
    expect(out.startsWith(BOM)).toBe(true);
    expect(out.match(/mcp_servers:/g)).toHaveLength(1);
    expect(out.indexOf(BOM, 1)).toBe(-1);
    expect(getYamlEntry(out, "mcp_servers", "plughive")).toEqual({ url: "http://y" });
    const back = removeYamlEntry(out, "mcp_servers", "plughive");
    expect(back).toBe(text);
  });
});
