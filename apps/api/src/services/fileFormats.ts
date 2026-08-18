import { inflateRawSync } from "node:zlib";
import path from "node:path";

export type FileKind = "pdf" | "docx" | "xlsx" | "text" | "csv";

export type ValidatedFile = {
  kind: FileKind;
  mimeType: string;
};

export type TextPreview = {
  kind: "text";
  format: "word" | "text";
  text: string;
  truncated: boolean;
};

export type SpreadsheetPreviewSheet = {
  name: string;
  rows: string[][];
  truncated: boolean;
};

export type SpreadsheetPreview = {
  kind: "spreadsheet";
  sheets: SpreadsheetPreviewSheet[];
  truncated: boolean;
};

export type GeneratedFilePreview = TextPreview | SpreadsheetPreview;

export class FileFormatError extends Error {}

const MIME_TYPES: Record<FileKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  text: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8"
};

const EXTENSION_KIND: Record<string, FileKind> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".txt": "text",
  ".md": "text",
  ".log": "text",
  ".csv": "csv",
  ".tsv": "csv"
};

export const SUPPORTED_UPLOAD_EXTENSIONS = Object.freeze(Object.keys(EXTENSION_KIND));
export const SUPPORTED_UPLOAD_LABEL = "PDF, DOCX, XLSX, TXT, CSV, TSV, MD, and LOG";

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const MAX_ZIP_ENTRIES = 5_000;
const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_PREVIEW_TEXT_CHARS = 200_000;
const MAX_PREVIEW_SHEETS = 5;
const MAX_PREVIEW_ROWS = 100;
const MAX_PREVIEW_COLUMNS = 30;
const MAX_PREVIEW_CELL_CHARS = 200;

function extensionOf(fileName: string) {
  return path.extname(fileName).toLowerCase();
}

export function fileKindFromMetadata(fileName: string, mimeType?: string | null): FileKind | null {
  const normalizedMimeType = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalizedMimeType === "application/pdf") return "pdf";
  if (normalizedMimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (normalizedMimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (normalizedMimeType === "text/csv" || normalizedMimeType === "text/tab-separated-values") return "csv";
  if (normalizedMimeType === "text/plain" || normalizedMimeType === "text/markdown") return "text";
  return EXTENSION_KIND[extensionOf(fileName)] ?? null;
}

export function validateUploadedFile(fileName: string, buffer: Buffer): ValidatedFile {
  const kind = EXTENSION_KIND[extensionOf(fileName)];
  if (!kind) {
    throw new FileFormatError(`Unsupported file type. Supported types: ${SUPPORTED_UPLOAD_LABEL}.`);
  }

  if (kind === "pdf") {
    if (buffer.length < 5 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new FileFormatError("The file extension is PDF, but the file content is not a valid PDF signature.");
    }
  } else if (kind === "docx") {
    assertOfficeArchive(buffer, "docx");
    createDocxPreview(buffer);
  } else if (kind === "xlsx") {
    assertOfficeArchive(buffer, "xlsx");
    createXlsxPreview(buffer);
  } else {
    const text = decodeText(buffer);
    if (kind === "csv") {
      createDelimitedPreview(text, extensionOf(fileName) === ".tsv" ? "\t" : ",", path.basename(fileName));
    }
  }

  const mimeType = kind === "csv" && extensionOf(fileName) === ".tsv"
    ? "text/tab-separated-values; charset=utf-8"
    : MIME_TYPES[kind];
  return { kind, mimeType };
}

export function createFilePreview(input: {
  fileName: string;
  mimeType?: string | null;
  buffer: Buffer;
}): GeneratedFilePreview {
  const kind = fileKindFromMetadata(input.fileName, input.mimeType);
  if (!kind || kind === "pdf") {
    throw new FileFormatError(kind === "pdf" ? "PDF files use the inline PDF preview." : "This file type cannot be previewed.");
  }

  if (kind === "docx") return createDocxPreview(input.buffer);
  if (kind === "xlsx") return createXlsxPreview(input.buffer);

  const text = decodeText(input.buffer);
  if (kind === "csv") {
    const delimiter = extensionOf(input.fileName) === ".tsv" ? "\t" : ",";
    return createDelimitedPreview(text, delimiter, path.basename(input.fileName));
  }

  return boundedTextPreview(text, "text");
}

function boundedTextPreview(text: string, format: "word" | "text"): TextPreview {
  const truncated = text.length > MAX_PREVIEW_TEXT_CHARS;
  return {
    kind: "text",
    format,
    text: truncated ? `${text.slice(0, MAX_PREVIEW_TEXT_CHARS)}\n\n[Preview truncated]` : text,
    truncated
  };
}

function decodeText(buffer: Buffer) {
  if (buffer.length === 0) return "";

  let encoding: "utf-8" | "utf-16le" | "utf-16be" = "utf-8";
  let bytes = buffer;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    bytes = buffer.subarray(3);
  } else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = "utf-16le";
    bytes = buffer.subarray(2);
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = "utf-16be";
    bytes = buffer.subarray(2);
  } else if (buffer.includes(0)) {
    throw new FileFormatError("Text files must use UTF-8 or UTF-16 text encoding.");
  }

  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new FileFormatError("Text files must use valid UTF-8 or UTF-16 text encoding.");
  }
}

type ZipEntry = {
  name: string;
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function assertOfficeArchive(buffer: Buffer, kind: "docx" | "xlsx") {
  const entries = readZipDirectory(buffer);
  if (!entries.has("[Content_Types].xml")) {
    throw new FileFormatError("The Office file is missing its content type manifest.");
  }

  if (kind === "docx" && !entries.has("word/document.xml")) {
    throw new FileFormatError("The DOCX file is missing its main Word document content.");
  }

  if (kind === "xlsx") {
    if (!entries.has("xl/workbook.xml")) {
      throw new FileFormatError("The XLSX file is missing its workbook metadata.");
    }
    const hasWorksheet = [...entries.keys()].some((name) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name));
    if (!hasWorksheet) {
      throw new FileFormatError("The XLSX file does not contain a worksheet.");
    }
  }
}

function readZipDirectory(buffer: Buffer) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== ZIP_LOCAL_FILE_HEADER) {
    throw new FileFormatError("The Office file is not a valid ZIP-based Office document.");
  }

  const minimumOffset = Math.max(0, buffer.length - 65_557);
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      eocdOffset = offset;
      break;
    }
  }

  if (eocdOffset < 0) {
    throw new FileFormatError("The Office file has an invalid ZIP directory.");
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new FileFormatError("ZIP64 Office files are not supported for preview.");
  }
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new FileFormatError("The Office file contains too many archive entries to preview safely.");
  }
  if (centralDirectoryOffset + centralDirectorySize > eocdOffset) {
    throw new FileFormatError("The Office file has a malformed ZIP directory.");
  }

  const entries = new Map<string, ZipEntry>();
  let offset = centralDirectoryOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_FILE_HEADER) {
      throw new FileFormatError("The Office file contains a malformed ZIP entry.");
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + fileNameLength + extraLength + commentLength;

    if (entryEnd > buffer.length) {
      throw new FileFormatError("The Office file contains a truncated ZIP entry.");
    }
    if ((flags & 0x1) !== 0) {
      throw new FileFormatError("Password-protected Office files cannot be previewed.");
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new FileFormatError("The Office file uses an unsupported ZIP compression method.");
    }
    if (uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
      throw new FileFormatError("The Office file contains an archive entry that is too large to preview safely.");
    }

    const rawName = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    const name = rawName.replace(/\\/g, "/");
    const normalizedName = path.posix.normalize(name);
    if (!name || name.startsWith("/") || normalizedName.startsWith("../") || normalizedName === "..") {
      throw new FileFormatError("The Office file contains an unsafe archive path.");
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      throw new FileFormatError("The Office file expands beyond the safe preview size limit.");
    }

    entries.set(normalizedName, {
      name: normalizedName,
      flags,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    });
    offset = entryEnd;
  }

  return entries;
}

function extractZipEntry(buffer: Buffer, entry: ZipEntry) {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_LOCAL_FILE_HEADER) {
    throw new FileFormatError(`The Office file contains an invalid local ZIP header for ${entry.name}.`);
  }

  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + fileNameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throw new FileFormatError(`The Office file contains truncated data for ${entry.name}.`);
  }

  const compressed = buffer.subarray(dataOffset, dataEnd);
  let output: Buffer;
  try {
    output =
      entry.compressionMethod === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES });
  } catch {
    throw new FileFormatError(`The Office file contains invalid compressed data in ${entry.name}.`);
  }

  if (output.length !== entry.uncompressedSize) {
    throw new FileFormatError(`The Office file reports an invalid uncompressed size for ${entry.name}.`);
  }
  return output;
}

function getZipEntry(buffer: Buffer, entries: Map<string, ZipEntry>, name: string, required = true) {
  const entry = entries.get(name);
  if (!entry) {
    if (required) throw new FileFormatError(`The Office file is missing ${name}.`);
    return null;
  }
  return extractZipEntry(buffer, entry);
}

function decodeXmlCodePoint(value: string, radix: number) {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return "�";
  }
  return String.fromCodePoint(codePoint);
}

function xmlDecode(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => decodeXmlCodePoint(hex, 16))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => decodeXmlCodePoint(decimal, 10))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractXmlText(xml: string, tagName: string) {
  const values: string[] = [];
  const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  for (const match of xml.matchAll(regex)) {
    values.push(xmlDecode(match[1] ?? ""));
  }
  return values.join("");
}

function createDocxPreview(buffer: Buffer): TextPreview {
  const entries = readZipDirectory(buffer);
  const documentBuffer = getZipEntry(buffer, entries, "word/document.xml");
  const xml = documentBuffer!.toString("utf8");
  const paragraphs: string[] = [];

  for (const match of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi)) {
    const paragraphXml = match[1] ?? "";
    const withWhitespace = paragraphXml
      .replace(/<w:tab\b[^>]*\/?\s*>/gi, "\t")
      .replace(/<w:(?:br|cr)\b[^>]*\/?\s*>/gi, "\n");
    const text = extractXmlText(withWhitespace, "w:t");
    paragraphs.push(text);
  }

  return boundedTextPreview(paragraphs.join("\n").replace(/\n{4,}/g, "\n\n\n"), "word");
}

function attributeValue(attributes: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attributes.match(new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`, "i"));
  return match?.[1] ? xmlDecode(match[1]) : undefined;
}

function resolveRelationshipTarget(baseFile: string, target: string) {
  const withoutLeadingSlash = target.replace(/^\//, "");
  const resolved = target.startsWith("/")
    ? path.posix.normalize(withoutLeadingSlash)
    : path.posix.normalize(path.posix.join(path.posix.dirname(baseFile), target));
  if (resolved.startsWith("../") || resolved === "..") {
    throw new FileFormatError("The Office file contains an unsafe relationship target.");
  }
  return resolved;
}

function createXlsxPreview(buffer: Buffer): SpreadsheetPreview {
  const entries = readZipDirectory(buffer);
  const workbookXml = getZipEntry(buffer, entries, "xl/workbook.xml")!.toString("utf8");
  const relationshipsBuffer = getZipEntry(buffer, entries, "xl/_rels/workbook.xml.rels", false);
  const relationships = new Map<string, string>();

  if (relationshipsBuffer) {
    const relationshipsXml = relationshipsBuffer.toString("utf8");
    for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
      const attributes = match[1] ?? "";
      const id = attributeValue(attributes, "Id");
      const target = attributeValue(attributes, "Target");
      if (id && target) relationships.set(id, resolveRelationshipTarget("xl/workbook.xml", target));
    }
  }

  const sharedStringsBuffer = getZipEntry(buffer, entries, "xl/sharedStrings.xml", false);
  const sharedStrings: string[] = [];
  if (sharedStringsBuffer) {
    const sharedStringsXml = sharedStringsBuffer.toString("utf8");
    for (const match of sharedStringsXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
      sharedStrings.push(extractXmlText(match[1] ?? "", "t"));
    }
  }

  const workbookSheets: Array<{ name: string; target?: string }> = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)) {
    const attributes = match[1] ?? "";
    const name = attributeValue(attributes, "name") ?? `Sheet ${workbookSheets.length + 1}`;
    const relationshipId = attributeValue(attributes, "r:id");
    workbookSheets.push({ name, target: relationshipId ? relationships.get(relationshipId) : undefined });
  }

  const worksheetEntryNames = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  const sheetDefinitions = workbookSheets.length > 0
    ? workbookSheets.map((sheet, index) => ({
        name: sheet.name,
        target: sheet.target && entries.has(sheet.target) ? sheet.target : worksheetEntryNames[index]
      }))
    : worksheetEntryNames.map((target, index) => ({ name: `Sheet ${index + 1}`, target }));

  const sheets: SpreadsheetPreviewSheet[] = [];
  let truncated = sheetDefinitions.length > MAX_PREVIEW_SHEETS;
  for (const definition of sheetDefinitions.slice(0, MAX_PREVIEW_SHEETS)) {
    if (!definition.target) continue;
    const worksheetBuffer = getZipEntry(buffer, entries, definition.target, false);
    if (!worksheetBuffer) continue;
    const parsed = parseWorksheet(worksheetBuffer.toString("utf8"), sharedStrings);
    sheets.push({ name: definition.name, rows: parsed.rows, truncated: parsed.truncated });
    truncated ||= parsed.truncated;
  }

  if (sheets.length === 0) {
    throw new FileFormatError("The XLSX file does not contain a readable worksheet.");
  }

  return { kind: "spreadsheet", sheets, truncated };
}

function columnIndexFromReference(reference: string) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase();
  if (!letters) return null;
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function cellValue(cellXml: string, type: string | undefined, sharedStrings: string[]) {
  if (type === "inlineStr") return extractXmlText(cellXml, "t");
  const valueMatch = cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i);
  const rawValue = valueMatch?.[1] ? xmlDecode(valueMatch[1]) : "";
  if (type === "s") {
    const sharedIndex = Number.parseInt(rawValue, 10);
    return Number.isFinite(sharedIndex) ? sharedStrings[sharedIndex] ?? "" : "";
  }
  if (type === "b") return rawValue === "1" ? "TRUE" : rawValue === "0" ? "FALSE" : rawValue;
  if (rawValue) return rawValue;
  const formulaMatch = cellXml.match(/<f\b[^>]*>([\s\S]*?)<\/f>/i);
  return formulaMatch?.[1] ? `=${xmlDecode(formulaMatch[1])}` : "";
}

function boundCell(value: string) {
  return value.length > MAX_PREVIEW_CELL_CHARS ? `${value.slice(0, MAX_PREVIEW_CELL_CHARS)}…` : value;
}

function parseWorksheet(xml: string, sharedStrings: string[]) {
  const rows: string[][] = [];
  let truncated = false;

  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    if (rows.length >= MAX_PREVIEW_ROWS) {
      truncated = true;
      break;
    }

    const rowXml = rowMatch[1] ?? "";
    const row: string[] = [];
    for (const cellMatch of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attributes = cellMatch[1] ?? "";
      const reference = attributeValue(attributes, "r");
      const type = attributeValue(attributes, "t");
      const cellXml = cellMatch[2] ?? "";
      const targetColumn = reference ? columnIndexFromReference(reference) : row.length;
      if (targetColumn === null) continue;
      if (targetColumn >= MAX_PREVIEW_COLUMNS) {
        truncated = true;
        continue;
      }
      while (row.length < targetColumn) row.push("");
      row[targetColumn] = boundCell(cellValue(cellXml, type, sharedStrings));
    }
    rows.push(row.slice(0, MAX_PREVIEW_COLUMNS));
  }

  return { rows, truncated };
}

function createDelimitedPreview(text: string, delimiter: string, name: string): SpreadsheetPreview {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let inQuotes = false;
  let truncated = false;

  const pushValue = () => {
    if (row.length < MAX_PREVIEW_COLUMNS) row.push(boundCell(value));
    else truncated = true;
    value = "";
  };
  const pushRow = () => {
    pushValue();
    if (rows.length < MAX_PREVIEW_ROWS) rows.push(row);
    else truncated = true;
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"' && text[index + 1] === '"') {
        if (value.length <= MAX_PREVIEW_CELL_CHARS) value += '"';
        else truncated = true;
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else if (value.length <= MAX_PREVIEW_CELL_CHARS) {
        value += char;
      } else {
        truncated = true;
      }
      continue;
    }

    if (char === '"' && value.length === 0) {
      inQuotes = true;
    } else if (char === delimiter) {
      pushValue();
    } else if (char === "\n") {
      pushRow();
      if (rows.length >= MAX_PREVIEW_ROWS) {
        if (index < text.length - 1) truncated = true;
        break;
      }
    } else if (char !== "\r") {
      if (value.length <= MAX_PREVIEW_CELL_CHARS) value += char;
      else truncated = true;
    }
  }

  if (rows.length < MAX_PREVIEW_ROWS && (value.length > 0 || row.length > 0)) pushRow();
  if (inQuotes) throw new FileFormatError("The delimited text file contains an unterminated quoted value.");

  return {
    kind: "spreadsheet",
    sheets: [{ name, rows, truncated }],
    truncated
  };
}
