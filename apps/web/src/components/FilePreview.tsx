import { Download } from "lucide-react";
import { FileItem, fileContentUrl } from "../lib/api";
import { formatBytes } from "../lib/format";
import { Button, Modal } from "./ui";

export function FilePreview({
  file,
  token,
  onClose
}: {
  file: FileItem | { id: string; name: string; mimeType?: string; sizeBytes?: number };
  token?: string;
  onClose: () => void;
}) {
  const isPdf = (file.mimeType ?? "application/pdf").includes("pdf") || file.name.toLowerCase().endsWith(".pdf");

  return (
    <Modal title={file.name} onClose={onClose}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-[#667478]">
          {file.sizeBytes ? formatBytes(file.sizeBytes) : "PDF document"}
        </p>
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
      {isPdf ? (
        <iframe
          title={file.name}
          src={fileContentUrl(file.id, token)}
          className="h-[68vh] w-full rounded-md border border-[#d7ddda] bg-[#f7f9f8]"
        />
      ) : (
        <div className="rounded-md border border-[#d7ddda] bg-[#f7f9f8] p-8 text-center text-sm text-[#667478]">
          Preview is available for PDF files.
        </div>
      )}
    </Modal>
  );
}
