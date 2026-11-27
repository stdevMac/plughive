// Round 5, office scanner: packages nested inside a document are scanned
// with the same rules and the same limits, and Word fields that load files
// (INCLUDEPICTURE, INCLUDETEXT, LINK, DDE...) are refused.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_ZIP_ENTRIES, scanZipDocument } from "../../../packs/local/lib/zip-scan.js";

interface Entry {
  name: string;
  data: string | Buffer;
  method?: 0 | 8;
}

function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
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
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const body = (inner: string) =>
  `<w:document ${W}><w:body><w:p>${inner}</w:p></w:body></w:document>`;
const docx = (doc: string, extra: Entry[] = []) =>
  zip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "word/document.xml", data: doc },
    ...extra,
  ]);

/** A complex field: begin, its instruction in one or more runs, separate, end. */
const complexField = (...instr: string[]) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r>${instr
    .map((t) => `<w:r><w:instrText xml:space="preserve">${t}</w:instrText></w:r>`)
    .join(
      "",
    )}<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;

const FILE_REL =
  '<Relationships><Relationship Id="r1" Type="x" Target="file:///etc/passwd" TargetMode="External"/></Relationships>';

describe("office scanner, round 5: field codes", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const scan = (buf: Buffer) => () => {
    if (!dir) dir = mkdtempSync(join(tmpdir(), "r5-office-"));
    const p = join(dir, "in.docx");
    writeFileSync(p, buf);
    scanZipDocument(p);
  };

  it("refuses an INCLUDEPICTURE instruction split across several runs", () => {
    const doc = body(complexField(" INCLU", "DEPIC", 'TURE "file:///etc/passwd" \\d '));
    expect(scan(docx(doc))).toThrow(/INCLUDEPICTURE field/);
  });

  it("refuses fldSimple fields whatever the case, spacing or encoding", () => {
    for (const instr of [
      ' INCLUDETEXT "C:\\\\secret.docx" ',
      "\tincludeText  x",
      "&#x49;NCLUDEPICTURE x",
      "\u00a0Link Excel.Sheet.8 x",
      "IN\u200bCLUDE x",
      "DDEAUTO cmd x",
      'DATABASE \\d "C:\\\\x.mdb"',
    ]) {
      const doc = body(`<w:fldSimple w:instr="${instr}"><w:r><w:t>x</w:t></w:r></w:fldSimple>`);
      expect(scan(docx(doc)), instr).toThrow(/Word (INCLUDE\w*|LINK|DDEAUTO|DATABASE) field/);
    }
  });

  it("checks headers, footers, footnotes, comments and the glossary too", () => {
    for (const part of [
      "word/header1.xml",
      "word/footer2.xml",
      "word/footnotes.xml",
      "word/comments.xml",
      "word/glossary/document.xml",
    ]) {
      const hostile = `<w:hdr ${W}><w:p>${complexField("LINK Word.Document.12 x")}</w:p></w:hdr>`;
      expect(scan(docx(body(""), [{ name: part, data: hostile }])), part).toThrow(/LINK field/);
    }
  });

  it("refuses a fetching field hidden in an unclosed field, a CDATA section or a nested field", () => {
    const unclosed = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>IMPORT x</w:instrText></w:r>`;
    expect(scan(docx(body(unclosed)))).toThrow(/IMPORT field/);
    const cdata = body(complexField("<![CDATA[INCLUDE]]>PICTURE x"));
    expect(scan(docx(cdata))).toThrow(/INCLUDEPICTURE field/);
    // { INCLUDE{ MERGEFIELD a }PICTURE x }: the outer instruction is joined around the inner field.
    const nested = body(
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>INCLUDE</w:instrText></w:r>${complexField(
        "MERGEFIELD a",
      )}<w:r><w:instrText>PICTURE x</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`,
    );
    expect(scan(docx(nested))).toThrow(/INCLUDEPICTURE field/);
    const deleted = body(
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:delInstrText>DDE a b</w:delInstrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`,
    );
    expect(scan(docx(deleted))).toThrow(/DDE field/);
  });

  it("refuses a HYPERLINK field to a local file or UNC path", () => {
    expect(scan(docx(body(complexField('HYPERLINK "file:///etc/passwd"'))))).toThrow(
      /HYPERLINK field to a local file/,
    );
    expect(scan(docx(body(complexField('HYPERLINK \\o "tip" "\\\\server\\share"'))))).toThrow(
      /HYPERLINK field/,
    );
  });

  it("refuses ODF DDE links", () => {
    const odt = zip([
      { name: "mimetype", data: "application/vnd.oasis.opendocument.text", method: 0 },
      {
        name: "content.xml",
        data: '<office:document-content><text:dde-connection-decls><text:dde-connection-decl office:name="a" office:dde-application="soffice" office:dde-topic="/etc/passwd" office:dde-item="x"/></text:dde-connection-decls></office:document-content>',
      },
    ]);
    expect(scan(odt)).toThrow(/ODF DDE link/);
  });

  it("keeps ordinary fields: PAGE, TOC, MERGEFIELD, HYPERLINK to the web or a bookmark", () => {
    const doc = body(
      [
        complexField("PAGE \\* MERGEFORMAT"),
        complexField(' TOC \\o "1-3" \\h '),
        complexField(' HYPERLINK "https://example.com/a" '),
        complexField(' HYPERLINK \\l "_Toc1" '),
        complexField(' MERGEFIELD "Includes" '),
        '<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>3</w:t></w:r></w:fldSimple>',
        '<w:fldSimple w:instr="LISTNUM LegalDefault"/>',
      ].join(""),
    );
    const header = `<w:hdr ${W}><w:p>${complexField("PAGE")}</w:p></w:hdr>`;
    expect(scan(docx(doc, [{ name: "word/header1.xml", data: header }]))).not.toThrow();
  });
});

describe("office scanner, round 5: nested packages", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const scan = (buf: Buffer) => () => {
    if (!dir) dir = mkdtempSync(join(tmpdir(), "r5-office-"));
    const p = join(dir, "in.docx");
    writeFileSync(p, buf);
    scanZipDocument(p);
  };
  const embed = (name: string, data: Buffer, method: 0 | 8 = 8) =>
    docx(body(""), [{ name, data, method }]);

  it("refuses a nested docx with an external file reference, naming where it is", () => {
    const inner = docx(body(""), [{ name: "word/_rels/document.xml.rels", data: FILE_REL }]);
    for (const method of [0, 8] as const) {
      expect(scan(embed("word/embeddings/Microsoft_Word_Document.docx", inner, method))).toThrow(
        /embedded package "word\/embeddings\/Microsoft_Word_Document\.docx"\).*file:\/\/ or UNC reference/,
      );
    }
    // Field codes inside an embedded document are refused too, whatever its name.
    const fielded = docx(body(complexField("INCLUDETEXT x")));
    expect(scan(embed("word/media/image1.png", fielded))).toThrow(/INCLUDETEXT field/);
  });

  it("scans a clean nested package and passes", () => {
    const xlsx = zip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "xl/workbook.xml", data: "<workbook/>" },
      { name: "xl/media/a.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
    ]);
    expect(scan(embed("word/embeddings/Microsoft_Excel_Worksheet.xlsx", xlsx))).not.toThrow();
  });

  it("allows two levels of nesting and refuses a third", () => {
    const leaf = zip([{ name: "a.xml", data: "<a/>" }]);
    const two = zip([{ name: "inner.zip", data: zip([{ name: "leaf.zip", data: leaf }]) }]);
    // docx > two (depth 1) > inner.zip (depth 2) > leaf.zip (depth 3)
    expect(scan(embed("word/embeddings/two.zip", two))).toThrow(
      /"leaf\.zip" is a package nested more than 2 deep/,
    );
    const ok = zip([{ name: "inner.zip", data: leaf }]);
    expect(scan(embed("word/embeddings/ok.zip", ok))).not.toThrow();
    // The rules apply at depth 2 as well.
    const deepBad = zip([
      {
        name: "inner.zip",
        data: zip([{ name: "x.xml", data: '<!DOCTYPE x [<!ENTITY e "a">]><x/>' }]),
      },
    ]);
    expect(scan(embed("word/embeddings/d.zip", deepBad))).toThrow(
      /"word\/embeddings\/d\.zip" \/ "inner\.zip"\).*entity/,
    );
  });

  it("refuses an unreadable nested package: data in front, corrupt, or inside an OLE object", () => {
    const inner = zip([{ name: "a.xml", data: "<a/>" }]);
    expect(
      scan(embed("word/embeddings/p.bin", Buffer.concat([Buffer.from("junk"), inner]))),
    ).toThrow(/embedded package "word\/embeddings\/p\.bin"/);
    expect(scan(embed("word/embeddings/c.zip", inner.subarray(0, inner.length - 30)))).toThrow(
      /embedded package/,
    );
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(504),
      inner,
      Buffer.alloc(512),
    ]);
    expect(scan(embed("word/embeddings/oleObject1.bin", ole))).toThrow(
      /OLE object with a ZIP package inside/,
    );
    // An OLE object without a package in it is left to the locked-down profile.
    const plainOle = Buffer.concat([ole.subarray(0, 8), Buffer.alloc(1024, 7)]);
    expect(scan(embed("word/embeddings/oleObject2.bin", plainOle))).not.toThrow();
  });

  it("shares the entry limit with the outer document", () => {
    const half = Math.ceil(MAX_ZIP_ENTRIES / 2) + 10;
    const many = (prefix: string) =>
      Array.from({ length: half }, (_, i) => ({
        name: `${prefix}${i}`,
        data: "x",
        method: 0 as const,
      }));
    const inner = zip(many("i/"));
    // Each package alone is under the limit.
    expect(scan(zip(many("o/")))).not.toThrow();
    expect(scan(inner)).not.toThrow();
    expect(scan(zip([...many("o/"), { name: "word/embeddings/x.zip", data: inner }]))).toThrow(
      /over 20000 ZIP entries \(counting embedded packages\)/,
    );
  });
});
