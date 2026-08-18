import { describe, expect, it } from "vitest";
import {
  createFilePreview,
  FileFormatError,
  validateUploadedFile
} from "./fileFormats.js";

type ZipInput = { name: string; contents: string | Buffer };

function makeStoredZip(inputs: ZipInput[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const input of inputs) {
    const name = Buffer.from(input.name, "utf8");
    const contents = Buffer.isBuffer(input.contents) ? input.contents : Buffer.from(input.contents, "utf8");

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(contents.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, contents);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(contents.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.length + name.length + contents.length;
  }

  const localData = Buffer.concat(localParts);
  const centralData = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(inputs.length, 8);
  eocd.writeUInt16LE(inputs.length, 10);
  eocd.writeUInt32LE(centralData.length, 12);
  eocd.writeUInt32LE(localData.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localData, centralData, eocd]);
}

function minimalDocx() {
  return makeStoredZip([
    { name: "[Content_Types].xml", contents: "<Types />" },
    {
      name: "word/document.xml",
      contents:
        '<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p></w:body></w:document>'
    }
  ]);
}

function minimalXlsx() {
  return makeStoredZip([
    { name: "[Content_Types].xml", contents: "<Types />" },
    {
      name: "xl/workbook.xml",
      contents:
        '<workbook xmlns:r="urn:test"><sheets><sheet name="Revenue" sheetId="1" r:id="rId1"/></sheets></workbook>'
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      contents: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
    },
    {
      name: "xl/sharedStrings.xml",
      contents: '<sst><si><t>Quarter</t></si><si><t>Revenue</t></si><si><t>Q1</t></si></sst>'
    },
    {
      name: "xl/worksheets/sheet1.xml",
      contents:
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c></row></sheetData></worksheet>'
    }
  ]);
}

describe("file format validation and previews", () => {
  it("accepts a real PDF signature and rejects a spoofed PDF", () => {
    expect(validateUploadedFile("report.pdf", Buffer.from("%PDF-1.7\n"))).toEqual({
      kind: "pdf",
      mimeType: "application/pdf"
    });
    expect(() => validateUploadedFile("malware.pdf", Buffer.from("not a pdf"))).toThrow(FileFormatError);
  });

  it("validates DOCX structure and creates a safe text preview", () => {
    const buffer = minimalDocx();
    expect(validateUploadedFile("memo.docx", buffer).kind).toBe("docx");
    const preview = createFilePreview({
      fileName: "memo.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer
    });
    expect(preview).toMatchObject({ kind: "text", format: "word", truncated: false });
    if (preview.kind === "text") expect(preview.text).toBe("Hello & welcome\nSecond line");
  });

  it("validates XLSX structure and previews worksheet values", () => {
    const buffer = minimalXlsx();
    expect(validateUploadedFile("forecast.xlsx", buffer).kind).toBe("xlsx");
    const preview = createFilePreview({
      fileName: "forecast.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer
    });
    expect(preview.kind).toBe("spreadsheet");
    if (preview.kind === "spreadsheet") {
      expect(preview.sheets[0]?.name).toBe("Revenue");
      expect(preview.sheets[0]?.rows).toEqual([
        ["Quarter", "Revenue"],
        ["Q1", "1200"]
      ]);
    }
  });

  it("previews CSV and UTF-8 text without executing file content", () => {
    const csv = Buffer.from('name,comment\nAlice,"hello, world"\n');
    expect(validateUploadedFile("people.csv", csv).kind).toBe("csv");
    const csvPreview = createFilePreview({ fileName: "people.csv", mimeType: "text/csv", buffer: csv });
    if (csvPreview.kind === "spreadsheet") {
      expect(csvPreview.sheets[0]?.rows[1]).toEqual(["Alice", "hello, world"]);
    }

    const text = Buffer.from("<script>alert('xss')</script>");
    const textPreview = createFilePreview({ fileName: "notes.txt", mimeType: "text/plain", buffer: text });
    expect(textPreview).toMatchObject({ kind: "text", format: "text" });
    if (textPreview.kind === "text") expect(textPreview.text).toContain("<script>");
  });

  it("rejects unsupported extensions", () => {
    expect(() => validateUploadedFile("payload.exe", Buffer.from("MZ"))).toThrow(/Unsupported file type/);
  });
});
