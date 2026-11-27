// Security fixes, rounds 3 and 4, for the office-document scanner and the
// HTML sanitizer of the local pack: byte sniffing (R3-H1), DTDs and entities
// (R3-H2), every XML-like part and central-directory hardening (R3-M1 /
// R4-M1), encoded paths and schemes (R3-M2 / R3-L1), the end record and text
// encodings (R4-H3), the HTML attribute tokenizer (R4-H4), data: URLs
// (R3-L2), CSS image-set() and <meta http-equiv=refresh>.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { safeHtmlUrl, sanitizeHtmlRefs, stageDocument } from "../../../packs/local/documents.js";
import { scanXmlDocument, scanZipDocument } from "../../../packs/local/lib/zip-scan.js";
import { type Env, makeEnv } from "./harness.js";

interface Entry {
  name: string;
  data: string | Buffer;
  method?: 0 | 8;
  madeBy?: number;
  externalAttrs?: number;
  compressedOverride?: number;
  uncompressedOverride?: number;
  nameLenOverride?: number;
}

interface ZipOpts {
  prefix?: Buffer;
  comment?: Buffer;
  countOverride?: number;
}

function zip(entries: Entry[], opts: ZipOpts = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const base = opts.prefix?.length ?? 0;
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const method = e.method ?? 8;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt8(20, 4);
    central.writeUInt8(e.madeBy ?? 0, 5);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(e.compressedOverride ?? data.length, 20);
    central.writeUInt32LE(e.uncompressedOverride ?? raw.length, 24);
    central.writeUInt16LE(e.nameLenOverride ?? nameBuf.length, 28);
    central.writeUInt32LE((e.externalAttrs ?? 0) >>> 0, 38);
    central.writeUInt32LE(base + offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = opts.comment ?? Buffer.alloc(0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.countOverride ?? entries.length, 8);
  eocd.writeUInt16LE(opts.countOverride ?? entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(base + offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([opts.prefix ?? Buffer.alloc(0), ...locals, cd, eocd, comment]);
}

const docx = (doc: string, extra: Entry[] = []) =>
  zip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "word/document.xml", data: doc },
    ...extra,
  ]);

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("office-document scanner (rounds 3 and 4)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const write = (buf: Buffer | string, name = "in.docx") => {
    if (!dir) dir = mkdtempSync(join(tmpdir(), "r3r4-"));
    const p = join(dir, name);
    writeFileSync(p, buf);
    return p;
  };
  const scan = (buf: Buffer) => () => scanZipDocument(write(buf));

  it("R3-H1: a ZIP declared as .doc or text/plain gets the ZIP scan", async () => {
    const env: Env = makeEnv();
    try {
      const hostile = docx('<!DOCTYPE w [<!ENTITY e SYSTEM "file:///etc/passwd">]><w:document/>');
      const work = join(env.dir, "work");
      const asDoc = env.add("in.doc", hostile, "application/msword", "document");
      await expect(stageDocument(env.ctx, work, asDoc)).rejects.toThrow(/entity/);
      const asTxt = env.add("in.txt", hostile, "text/plain", "document");
      await expect(stageDocument(env.ctx, work, asTxt)).rejects.toThrow(/entity/);
      // Flat XML declared as .doc is scanned as XML.
      const flat = env.add(
        "flat.doc",
        Buffer.from('<?xml version="1.0"?><!DOCTYPE x SYSTEM "file:///etc/passwd"><x/>'),
        "application/msword",
        "document",
      );
      await expect(stageDocument(env.ctx, work, flat)).rejects.toThrow(/DOCTYPE|DTD/);
      // A plain text file still stages.
      const txt = env.add("ok.txt", Buffer.from("hello"), "text/plain", "document");
      expect((await stageDocument(env.ctx, work, txt)).type).toBe("txt");
    } finally {
      env.cleanup();
    }
  });

  it("R3-H2: internal entities, internal subsets and local DTDs are refused", () => {
    expect(scan(docx('<!DOCTYPE w [<!ENTITY a "aaaa">]><w:document>&a;</w:document>'))).toThrow(
      /entity/,
    );
    expect(scan(docx("<!DOCTYPE w [ ]><w:document/>"))).toThrow(/internal subset|DOCTYPE/);
    expect(scan(docx('<!DOCTYPE w SYSTEM "file:///etc/passwd"><w:document/>'))).toThrow(
      /DOCTYPE|DTD/,
    );
    expect(scan(docx('<!DOCTYPE w PUBLIC "-//x" "/etc/x.dtd"><w:document/>'))).toThrow(
      /DOCTYPE|DTD/,
    );
    // A DTD that names an entry in the package.
    expect(
      scan(
        docx('<!DOCTYPE w SYSTEM "evil.dtd"><w:document/>', [
          { name: "word/evil.txt", data: "x" },
          { name: "evil.dtd", data: '<!ENTITY x SYSTEM "file:///etc/passwd">' },
        ]),
      ),
    ).toThrow();
  });

  it("R3-M1: svg, xhtml, sniffed-XML and DTD parts are all scanned", () => {
    const svg = '<svg xmlns:xlink="x"><image xlink:href="file:///etc/passwd"/></svg>';
    expect(scan(docx("<w:document/>", [{ name: "word/media/a.svg", data: svg }]))).toThrow(
      /file:\/\/|UNC/,
    );
    expect(
      scan(
        docx("<w:document/>", [{ name: "a.xhtml", data: '<html><img src="/etc/passwd"/></html>' }]),
      ),
    ).toThrow(/absolute local path/);
    // Not named like XML, but the bytes are XML.
    expect(
      scan(
        docx("<w:document/>", [
          { name: "word/blob.bin", data: '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///x">]><x/>' },
        ]),
      ),
    ).toThrow(/entity/);
    expect(scan(docx("<w:document/>", [{ name: "x.dtd", data: "<!ELEMENT x ANY>" }]))).toThrow();
  });

  it("R4-M1: quote-aware attributes and relationships", () => {
    // A quote inside another attribute must not hide xlink:href.
    expect(scan(docx(`<w:document><a title='x"' xlink:href="file:///x"/></w:document>`))).toThrow(
      /file:\/\/|UNC/,
    );
    const rels =
      `<Relationships><Relationship Id="r1" Type="t" TargetMode='External' ` +
      `Note="a>b" Target="file:///etc/passwd"/></Relationships>`;
    expect(
      scan(docx("<w:document/>", [{ name: "word/_rels/document.xml.rels", data: rels }])),
    ).toThrow(/file:\/\/|UNC|external relationship/);
    // An https external relationship stays allowed.
    const ok =
      '<Relationships><Relationship Id="r1" Type="t" TargetMode="External" ' +
      'Target="https://example.com/"/></Relationships>';
    expect(
      scan(docx("<w:document/>", [{ name: "word/_rels/document.xml.rels", data: ok }])),
    ).not.toThrow();
  });

  it("R3-M2 / R3-L1: percent-encoded .. and hidden scheme characters are decoded first", () => {
    expect(
      scan(docx('<w:document><img src="%2e%2e/%2e%2e/%2e%2e/etc/passwd"/></w:document>')),
    ).toThrow();
    expect(scan(docx('<w:document><a xlink:href="fi le:///etc/passwd"/></w:document>'))).toThrow(
      /file:\/\/|UNC/,
    );
    expect(scan(docx('<w:document><a xlink:href="fi&#9;le:///etc/passwd"/></w:document>'))).toThrow(
      /file:\/\/|UNC/,
    );
  });

  it("R4-M1: symlink entries, bad central-directory bounds and bomb headers are refused", () => {
    expect(
      scan(
        docx("<w:document/>", [
          {
            name: "link",
            data: "/etc/passwd",
            method: 0,
            madeBy: 3,
            externalAttrs: 0o120777 << 16,
          },
        ]),
      ),
    ).toThrow(/symbolic link|symlink/);
    expect(
      scan(docx("<w:document/>", [{ name: "x.xml", data: "<x/>", nameLenOverride: 60000 }])),
    ).toThrow();
    expect(
      scan(
        docx("<w:document/>", [
          { name: "big.xml", data: "<x/>", compressedOverride: 0, uncompressedOverride: 10 },
        ]),
      ),
    ).toThrow(/zip bomb/);
  });

  it("R4-H3: the end record must be the only one and match the archive", () => {
    const clean = docx("<w:document/>");
    expect(scan(clean)).not.toThrow();
    // A second, fake end record hidden in the comment.
    const fake = Buffer.alloc(22);
    fake.writeUInt32LE(0x06054b50, 0);
    expect(
      scan(zip([{ name: "word/document.xml", data: "<w:document/>" }], { comment: fake })),
    ).toThrow();
    // Entry count mismatch.
    expect(
      scan(
        zip(
          [
            { name: "a.xml", data: "<a/>" },
            { name: "b.xml", data: "<b/>" },
          ],
          { countOverride: 1 },
        ),
      ),
    ).toThrow();
    // Data prepended before the first local header.
    expect(scan(zip([{ name: "a.xml", data: "<a/>" }], { prefix: Buffer.from("junk") }))).toThrow();
  });

  it("R4-H3: UTF-16 parts are decoded before the scan, UTF-32 is refused", () => {
    const bad =
      '<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///x">]><x/>';
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(bad, "utf16le")]);
    const be = Buffer.from(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(bad, "utf16le")]));
    for (let i = 2; i + 1 < be.length; i += 2) {
      const t = be[i] as number;
      be[i] = be[i + 1] as number;
      be[i + 1] = t;
    }
    expect(scan(docx("<w:document/>", [{ name: "u.xml", data: le }]))).toThrow(/entity/);
    expect(scan(docx("<w:document/>", [{ name: "u.xml", data: be }]))).toThrow(/entity/);
    const u32 = Buffer.from([0xff, 0xfe, 0, 0, 0x3c, 0, 0, 0, 0x78, 0, 0, 0]);
    expect(scan(docx("<w:document/>", [{ name: "u.xml", data: u32 }]))).toThrow();
    // A clean UTF-16 part passes.
    const good = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<x a='1'/>", "utf16le")]);
    expect(scan(docx("<w:document/>", [{ name: "u.xml", data: good }]))).not.toThrow();
  });

  it("scans a standalone XML document", () => {
    expect(() => scanXmlDocument(write('<!DOCTYPE x [<!ENTITY a "b">]><x/>', "a.xml"))).toThrow(
      /entity/,
    );
    expect(() => scanXmlDocument(write("<x/>", "b.xml"))).not.toThrow();
  });
});

describe("sanitizeHtmlRefs (rounds 3 and 4)", () => {
  it("R4-H4: a quote inside another attribute cannot hide src", () => {
    const out = sanitizeHtmlRefs(`<img title="href='#" src="file:///etc/passwd" alt="'">`);
    expect(out).not.toContain("file:");
    expect(out).toContain('src="#"');
  });

  it("R3-L2: data: is kept only as a raster image in an image source", () => {
    expect(safeHtmlUrl("data:image/svg+xml,<svg/>")).toBe(false);
    expect(safeHtmlUrl("data:text/html,<b>")).toBe(false);
    const out = sanitizeHtmlRefs(
      '<iframe src="data:text/html,<img src=file:///etc/passwd>"></iframe>' +
        '<img src="data:image/svg+xml,<svg/>">' +
        '<a href="data:image/png;base64,AAAA">x</a>' +
        '<img src="data:image/png;base64,AAAA">',
    );
    expect(out).not.toContain("data:text");
    expect(out).not.toContain("svg+xml");
    expect(out).toContain('<a href="#">');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
  });

  it("CSS image-set() with a nested url() cannot end the scan early", () => {
    const out = sanitizeHtmlRefs(
      `<style>a{background:image-set(url(#a) 1x, "file:///etc/passwd" 2x)}</style>` +
        `<div style="background:-webkit-image-set(url('#a') 1x, 'file:///etc/hosts' 2x)">x</div>`,
    );
    expect(out).not.toContain("file:");
  });

  it("drops every <meta http-equiv> whatever its case, spacing or quoting", () => {
    const out = sanitizeHtmlRefs(
      `<META HTTP-EQUIV=Refresh CONTENT="0; URL=file:///etc/passwd">` +
        `<meta http-equiv = 'refresh' content='0;url=file:///etc/hosts'>` +
        `<meta content="0;url=file:///etc/shadow" http-equiv="REFRESH">`,
    );
    expect(out).not.toContain("file:");
    expect(out).not.toMatch(/http-equiv/i);
  });

  it("character references in a URL are decoded before the check", () => {
    const out = sanitizeHtmlRefs(
      `<a href="&#x66;ile:///etc/passwd">x</a><svg fill="ur&#x6c;(file:///x)"/>`,
    );
    expect(out).not.toMatch(/file:/);
    expect(out).not.toMatch(/url\(file/);
  });
});
