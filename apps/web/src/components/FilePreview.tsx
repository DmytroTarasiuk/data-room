import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import {
  ApiError,
  FileItem,
  FilePreviewPayload,
  fetchFilePreview,
  fileContentUrl
} from "../lib/api";
import { formatBytes } from "../lib/format";
import { Button, Modal, Notice, Spinner } from "./ui";

type PreviewFile = FileItem | { id: string; name: string; mimeType?: string; sizeBytes?: number };

function isPdfFile(file: PreviewFile) {
  return file.mimeType?.split(";", 1)[0]?.toLowerCase() === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export function FilePreviewContent({
  file,
  token,
  className = "h-[68vh]"
}: {
  file: PreviewFile;
  token?: string;
  className?: string;
}) {
  const isPdf = isPdfFile(file);
  const [preview, setPreview] = useState<FilePreviewPayload | null>(null);
  const [loading, setLoading] = useState(!isPdf);
  const [error, setError] = useState("");

  useEffect(() => {
    setPreview(null);
    setError("");
    if (isPdf) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    fetchFilePreview(file.id, token, controller.signal)
      .then(setPreview)
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : "Could not generate a preview for this file");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [file.id, isPdf, token]);

  if (isPdf) {
    return (
      <iframe
        title={file.name}
        src={fileContentUrl(file.id, token)}
        className={`${className} w-full rounded-md border border-[#d7ddda] bg-[#f7f9f8]`}
      />
    );
  }

  if (loading) {
    return (
      <div className={`${className} flex items-center justify-center rounded-md border border-[#d7ddda] bg-[#f7f9f8] text-sm text-[#667478]`}>
        <Spinner />
        <span className="ml-2">Generating preview</span>
      </div>
    );
  }

  if (error || !preview) {
    return (
      <div className={`${className} flex items-center justify-center rounded-md border border-[#d7ddda] bg-[#f7f9f8] p-6`}>
        <Notice tone="danger">{error || "Preview is unavailable for this file"}</Notice>
      </div>
    );
  }

  if (preview.kind === "spreadsheet") {
    return <SpreadsheetPreview preview={preview} className={className} />;
  }

  return (
    <div className={`${className} overflow-auto rounded-md border border-[#d7ddda] bg-white thin-scrollbar`}>
      {preview.truncated ? (
        <div className="sticky top-0 border-b border-[#e2e7e5] bg-[#fff8e8] px-4 py-2 text-xs text-[#7a5b13]">
          This is a shortened preview. Download the file to view all content.
        </div>
      ) : null}
      <pre className="whitespace-pre-wrap break-words p-5 font-sans text-sm leading-6 text-[#263235]">
        {preview.text || "This file is empty."}
      </pre>
    </div>
  );
}

function SpreadsheetPreview({
  preview,
  className
}: {
  preview: Extract<FilePreviewPayload, { kind: "spreadsheet" }>;
  className: string;
}) {
  const [activeSheet, setActiveSheet] = useState(0);

  useEffect(() => {
    setActiveSheet(0);
  }, [preview]);

  const sheet = preview.sheets[activeSheet] ?? preview.sheets[0];
  const columnCount = useMemo(
    () => Math.max(1, ...(sheet?.rows.map((row) => row.length) ?? [1])),
    [sheet]
  );

  if (!sheet) {
    return (
      <div className={`${className} flex items-center justify-center rounded-md border border-[#d7ddda] bg-[#f7f9f8] text-sm text-[#667478]`}>
        This spreadsheet does not contain previewable cells.
      </div>
    );
  }

  return (
    <div className={`${className} flex min-h-0 flex-col overflow-hidden rounded-md border border-[#d7ddda] bg-white`}>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[#e2e7e5] bg-[#f7f9f8] px-2 py-2 thin-scrollbar">
        {preview.sheets.map((candidate, index) => (
          <button
            key={`${candidate.name}-${index}`}
            type="button"
            onClick={() => setActiveSheet(index)}
            className={`shrink-0 rounded px-3 py-1.5 text-xs font-medium ${
              index === activeSheet ? "bg-white text-[#173f3f] shadow-sm" : "text-[#667478] hover:bg-white/70"
            }`}
          >
            {candidate.name}
          </button>
        ))}
      </div>
      {preview.truncated || sheet.truncated ? (
        <div className="shrink-0 border-b border-[#eadfbf] bg-[#fff8e8] px-4 py-2 text-xs text-[#7a5b13]">
          Preview is limited to the first sheets, rows, and columns. Download the file to view everything.
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto thin-scrollbar">
        <table className="min-w-full border-collapse text-xs text-[#263235]">
          <thead className="sticky top-0 z-10 bg-[#f2f5f4] text-[#667478]">
            <tr>
              <th className="sticky left-0 z-20 w-12 border-b border-r border-[#dde4e1] bg-[#f2f5f4] px-2 py-2 text-right font-medium">#</th>
              {Array.from({ length: columnCount }, (_, index) => (
                <th key={index} className="min-w-28 border-b border-r border-[#dde4e1] px-3 py-2 text-left font-medium">
                  {columnLabel(index)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.length === 0 ? (
              <tr>
                <td colSpan={columnCount + 1} className="p-6 text-center text-[#667478]">
                  This sheet is empty.
                </td>
              </tr>
            ) : (
              sheet.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <th className="sticky left-0 border-b border-r border-[#e7ecea] bg-[#f7f9f8] px-2 py-2 text-right font-medium text-[#7b888b]">
                    {rowIndex + 1}
                  </th>
                  {Array.from({ length: columnCount }, (_, columnIndex) => (
                    <td key={columnIndex} className="max-w-80 border-b border-r border-[#e7ecea] px-3 py-2 align-top">
                      <div className="max-h-24 overflow-hidden whitespace-pre-wrap break-words">{row[columnIndex] ?? ""}</div>
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function columnLabel(index: number) {
  let current = index + 1;
  let label = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }
  return label;
}

export function FilePreview({
  file,
  token,
  onClose
}: {
  file: PreviewFile;
  token?: string;
  onClose: () => void;
}) {
  return (
    <Modal title={file.name} onClose={onClose}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-[#667478]">{file.sizeBytes !== undefined ? formatBytes(file.sizeBytes) : "Document"}</p>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            window.open(fileContentUrl(file.id, token, true), "_blank", "noopener,noreferrer");
          }}
        >
          <Download size={16} />
          Download
        </Button>
      </div>
      <FilePreviewContent file={file} token={token} />
    </Modal>
  );
}
