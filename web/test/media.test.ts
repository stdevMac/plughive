import { describe, expect, it } from "vitest";
import {
  absoluteUrl,
  artifactDownloadUrl,
  extractMedia,
  isArtifactUrl,
  isHttpUrl,
  sameOriginArtifactUrl,
} from "../src/lib/media";

describe("isHttpUrl / isArtifactUrl (M-16)", () => {
  it("accepts absolute http(s) and single-slash paths", () => {
    expect(isHttpUrl("https://example.com/x")).toBe(true);
    expect(isHttpUrl("http://127.0.0.1:7777/artifacts/img_1")).toBe(true);
    expect(isHttpUrl("/artifacts/img_1")).toBe(true);
  });

  it("rejects protocol-relative urls, non-http schemes and unparsable urls", () => {
    expect(isHttpUrl("//evil.example/artifacts/x")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("data:text/html,x")).toBe(false);
    expect(isHttpUrl("https://[bad")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });

  it("isArtifactUrl no longer matches a protocol-relative url", () => {
    expect(isArtifactUrl("/artifacts/img_1")).toBe(true);
    expect(isArtifactUrl("http://127.0.0.1:7777/artifacts/img_1")).toBe(true);
    expect(isArtifactUrl("//evil.example/artifacts/x")).toBe(false);
    expect(isArtifactUrl("https://[bad/artifacts/x")).toBe(false);
    expect(isArtifactUrl("https://example.com/other")).toBe(false);
  });
});

describe("absoluteUrl never throws (M-16)", () => {
  it("returns the absolute form, or null for junk", () => {
    expect(absoluteUrl("/artifacts/img_1", "http://127.0.0.1:7777")).toBe(
      "http://127.0.0.1:7777/artifacts/img_1",
    );
    expect(absoluteUrl("https://[bad", "http://127.0.0.1:7777")).toBeNull();
    expect(absoluteUrl("https://example.com/x", "http://127.0.0.1:7777")).toBe(
      "https://example.com/x",
    );
  });
});

describe("extractMedia (M-16)", () => {
  it("skips invalid and protocol-relative urls instead of crashing later", () => {
    const refs = extractMedia({
      bad: "https://[bad",
      rel: "//evil.example/artifacts/x",
      good: "http://127.0.0.1:7777/artifacts/img_1",
      obj: { url: "https://[bad", mime: "image/png" },
      obj2: { url: "//evil.example/a.png", mime: "image/png" },
      obj3: { url: "https://example.com/pic.png", mime: "image/png" },
      obj4: { uri: "/artifacts/doc_1", mime: "application/pdf" },
    });
    const urls = refs.map((r) => r.url);
    expect(urls).toContain("http://127.0.0.1:7777/artifacts/img_1");
    expect(urls).toContain("https://example.com/pic.png");
    expect(urls).toContain("/artifacts/doc_1");
    expect(urls).not.toContain("https://[bad");
    expect(urls).not.toContain("//evil.example/artifacts/x");
    expect(urls).not.toContain("//evil.example/a.png");
  });
});

describe("sameOriginArtifactUrl / artifactDownloadUrl", () => {
  it("keeps artifact links relative, leaves other hosts alone, survives junk", () => {
    expect(
      sameOriginArtifactUrl("http://127.0.0.1:7777/artifacts/img_1", "http://127.0.0.1:7777"),
    ).toBe("/artifacts/img_1");
    expect(
      sameOriginArtifactUrl("http://localhost:7777/artifacts/img_1", "http://127.0.0.1:7777"),
    ).toBe("/artifacts/img_1");
    expect(sameOriginArtifactUrl("https://evil.example/artifacts/x", "http://127.0.0.1:7777")).toBe(
      "https://evil.example/artifacts/x",
    );
    expect(sameOriginArtifactUrl("https://[bad", "http://127.0.0.1:7777")).toBe("https://[bad");
    expect(artifactDownloadUrl("https://[bad", "http://127.0.0.1:7777")).toBe("https://[bad");
    expect(artifactDownloadUrl("/artifacts/img_1", "http://127.0.0.1:7777")).toBe(
      "/artifacts/img_1?download=1",
    );
  });
});
