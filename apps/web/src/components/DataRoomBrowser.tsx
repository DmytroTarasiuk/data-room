import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Download,
  Eye,
  FileText,
  Folder,
  FolderPlus,
  Link2,
  MoreHorizontal,
  Pencil,
  Search,
  Send,
  Trash2,
  Upload,
  X
} from "lucide-react";
import {
  ApiError,
  ContentsResponse,
  FileItem,
  Folder as FolderItem,
  ResourceType,
  FILE_UPLOAD_ACCEPT,
  FILE_UPLOAD_TYPES_LABEL,
  fileContentUrl,
  request,
  uploadFile
} from "../lib/api";
import { formatBytes, formatDate, pluralize } from "../lib/format";
import { Button, EmptyState, IconButton, Modal, Notice, Spinner, TextInput } from "./ui";
import { ShareDialog } from "./ShareDialog";
import { FilePreview } from "./FilePreview";

type Props = {
  roomId: string;
  folderId: string;
  token?: string;
  onOpenFolder: (folderId: string) => void;
  onRoomMutated?: () => void;
};

type RenameTarget =
  | { type: "FOLDER"; item: FolderItem }
  | { type: "FILE"; item: FileItem };

type ShareTarget = {
  resourceType: ResourceType;
  resourceId: string;
  label: string;
};

type DeleteTarget =
  | { type: "FOLDER"; item: FolderItem; preview?: { folders: number; files: number; sizeBytes: number } }
  | { type: "FILE"; item: FileItem };

type UploadRow = {
  id: string;
  name: string;
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
};

export function DataRoomBrowser({ roomId, folderId, token, onOpenFolder, onRoomMutated }: Props) {
  const [data, setData] = useState<ContentsResponse | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [moveTarget, setMoveTarget] = useState<FileItem | null>(null);
  const [moveFolders, setMoveFolders] = useState<FolderItem[]>([]);
  const [targetFolderId, setTargetFolderId] = useState("");
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const canWrite = Boolean(data?.access.canWrite);
  const currentFolder = data?.folder;
  const isRoot = !currentFolder?.parentId;

  async function loadContents(search = query) {
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    if (token) params.set("token", token);
    if (search.trim()) params.set("q", search.trim());
    try {
      const payload = await request<ContentsResponse>(
        `/api/data-rooms/${roomId}/folders/${folderId}/contents${params.toString() ? `?${params}` : ""}`
      );
      setData(payload);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this folder");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadContents("");
  }, [roomId, folderId, token]);

  const sortedItems = useMemo(() => {
    return {
      folders: data?.folders ?? [],
      files: data?.files ?? []
    };
  }, [data]);

  async function createFolder(event: FormEvent) {
    event.preventDefault();
    if (!folderName.trim()) return;
    setBusy(true);
    setNotice("");
    try {
      const payload = await request<{ conflictResolved: boolean }>("/api/data-rooms/" + roomId + "/folders", {
        method: "POST",
        body: {
          parentId: folderId,
          name: folderName
        }
      });
      setCreateFolderOpen(false);
      setFolderName("");
      setNotice(payload.conflictResolved ? "Folder name was adjusted to avoid a conflict" : "Folder created");
      await loadContents();
      onRoomMutated?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create folder");
    } finally {
      setBusy(false);
    }
  }

  function openRename(target: RenameTarget) {
    setRenameTarget(target);
    setRenameValue(target.item.name);
  }

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!renameTarget || !renameValue.trim()) return;
    setBusy(true);
    setNotice("");
    try {
      const endpoint =
        renameTarget.type === "FOLDER" ? `/api/folders/${renameTarget.item.id}` : `/api/files/${renameTarget.item.id}`;
      const payload = await request<{ conflictResolved: boolean }>(endpoint, {
        method: "PATCH",
        body: { name: renameValue }
      });
      setRenameTarget(null);
      setNotice(payload.conflictResolved ? "Name was adjusted to avoid a conflict" : "Renamed");
      await loadContents();
      onRoomMutated?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not rename item");
    } finally {
      setBusy(false);
    }
  }

  async function openDelete(target: DeleteTarget) {
    setDeleteTarget(target);
    if (target.type === "FOLDER") {
      try {
        const payload = await request<{ deletes: { folders: number; files: number; sizeBytes: number } }>(
          `/api/folders/${target.item.id}/delete-preview`
        );
        setDeleteTarget({ ...target, preview: payload.deletes });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not inspect folder");
        setDeleteTarget(null);
      }
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    setNotice("");
    try {
      await request(deleteTarget.type === "FOLDER" ? `/api/folders/${deleteTarget.item.id}` : `/api/files/${deleteTarget.item.id}`, {
        method: "DELETE"
      });
      setDeleteTarget(null);
      setNotice("Deleted");
      await loadContents();
      onRoomMutated?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete item");
    } finally {
      setBusy(false);
    }
  }

  async function openMove(file: FileItem) {
    setMoveTarget(file);
    setTargetFolderId(file.folderId);
    try {
      const payload = await request<{ folders: FolderItem[] }>(`/api/data-rooms/${roomId}/folders`);
      setMoveFolders(payload.folders);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load folders");
      setMoveTarget(null);
    }
  }

  async function moveFile(event: FormEvent) {
    event.preventDefault();
    if (!moveTarget || !targetFolderId) return;
    setBusy(true);
    setNotice("");
    try {
      const payload = await request<{ conflictResolved: boolean }>(`/api/files/${moveTarget.id}/move`, {
        method: "PATCH",
        body: { targetFolderId }
      });
      setMoveTarget(null);
      setNotice(payload.conflictResolved ? "Moved and renamed to avoid a conflict" : "Moved");
      await loadContents();
      onRoomMutated?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not move file");
    } finally {
      setBusy(false);
    }
  }

  function updateUpload(id: string, patch: Partial<UploadRow>) {
    setUploads((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  async function uploadFiles(fileList: FileList | File[]) {
    if (!canWrite) return;
    const files = Array.from(fileList);
    if (files.length === 0) return;

    const rows = files.map((file) => ({
      id: `${file.name}-${file.size}-${crypto.randomUUID()}`,
      name: file.name,
      progress: 0,
      status: "uploading" as const
    }));
    setUploads((current) => [...rows, ...current].slice(0, 12));
    setNotice("");

    const queue = files.map((file, index) => ({ file, row: rows[index]! }));
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < queue.length) {
        const item = queue[nextIndex++];
        if (!item) return;
        try {
          await uploadFile(roomId, folderId, item.file, (progress) => updateUpload(item.row.id, { progress }));
          updateUpload(item.row.id, { progress: 100, status: "done" });
        } catch (err) {
          updateUpload(item.row.id, {
            status: "error",
            error: err instanceof ApiError ? err.message : "Upload failed"
          });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));

    await loadContents();
    onRoomMutated?.();
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void uploadFiles(event.dataTransfer.files);
  }

  function clearNotice() {
    setNotice("");
    setError("");
  }

  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[#667478]">
        <Spinner />
        <span className="ml-2">Loading folder</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <EmptyState
        title={error}
        detail="The item may have been deleted, revoked, or moved."
        action={<Button onClick={() => loadContents()}>Retry</Button>}
      />
    );
  }

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragEnter={(event) => {
        if (!canWrite) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!canWrite) return;
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {dragging ? (
        <div className="absolute inset-3 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-[#0f8b8d] bg-[#eefafa]/90 text-sm font-semibold text-[#166265]">
          Drop PDF, Word, Excel, or text files to upload
        </div>
      ) : null}

      <div className="border-b border-[#dfe5e2] bg-white px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <nav className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-[#667478]">
              {data?.breadcrumbs.map((crumb, index) => (
                <span key={crumb.id} className="flex min-w-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onOpenFolder(crumb.id)}
                    className="max-w-[180px] truncate rounded px-1.5 py-1 hover:bg-[#edf1ef] hover:text-[#253033]"
                  >
                    {crumb.name}
                  </button>
                  {index < data.breadcrumbs.length - 1 ? <ArrowRight size={14} /> : null}
                </span>
              ))}
            </nav>
            <div className="mt-2 flex items-center gap-3">
              <h1 className="truncate text-2xl font-semibold text-[#1f2a2d]">{currentFolder?.name}</h1>
              {!canWrite ? (
                <span className="rounded-full bg-[#edf2f1] px-2 py-1 text-xs font-medium text-[#667478]">
                  Read-only
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canWrite ? (
              <>
                <Button variant="secondary" onClick={() => setCreateFolderOpen(true)}>
                  <FolderPlus size={16} />
                  New folder
                </Button>
                <Button variant="secondary" onClick={() => inputRef.current?.click()} title={FILE_UPLOAD_TYPES_LABEL}>
                  <Upload size={16} />
                  Upload
                </Button>
                <input
                  ref={inputRef}
                  type="file"
                  accept={FILE_UPLOAD_ACCEPT}
                  multiple
                  className="hidden"
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    if (event.target.files) void uploadFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
                <Button
                  onClick={() =>
                    setShareTarget({
                      resourceType: isRoot ? "DATA_ROOM" : "FOLDER",
                      resourceId: isRoot ? roomId : currentFolder!.id,
                      label: isRoot ? data!.room.name : currentFolder!.name
                    })
                  }
                >
                  <Link2 size={16} />
                  Share
                </Button>
              </>
            ) : null}
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-center">
          <form
            className="relative"
            onSubmit={(event) => {
              event.preventDefault();
              void loadContents(query);
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-2.5 text-[#7b888b]" size={17} />
            <TextInput
              className="pl-9 pr-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search this folder"
            />
            {query ? (
              <button
                type="button"
                className="absolute right-2 top-2.5 text-[#7b888b]"
                onClick={() => {
                  setQuery("");
                  void loadContents("");
                }}
                title="Clear search"
              >
                <X size={17} />
              </button>
            ) : null}
          </form>

          <div className="flex flex-wrap gap-2 text-xs text-[#667478]">
            <span className="rounded-full bg-[#edf2f1] px-2.5 py-1">
              {pluralize(currentFolder?.folderCount ?? 0, "folder")}
            </span>
            <span className="rounded-full bg-[#edf2f1] px-2.5 py-1">
              {pluralize(currentFolder?.fileCount ?? 0, "file")}
            </span>
            <span className="rounded-full bg-[#edf2f1] px-2.5 py-1">{formatBytes(currentFolder?.sizeBytes ?? 0)}</span>
          </div>
        </div>

        {(notice || error) && data ? (
          <div className="mt-3" onClick={clearNotice}>
            {notice ? <Notice tone="success">{notice}</Notice> : null}
            {error ? <Notice tone="danger">{error}</Notice> : null}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-5 thin-scrollbar">
        {uploads.length ? (
          <div className="mb-4 rounded-lg border border-[#dbe2df] bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold text-[#2c383b]">Uploads</p>
              <IconButton title="Clear finished uploads" onClick={() => setUploads((rows) => rows.filter((row) => row.status === "uploading"))}>
                <X size={16} />
              </IconButton>
            </div>
            <div className="space-y-2">
              {uploads.map((row) => (
                <div key={row.id} className="grid gap-1 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-[#334044]">{row.name}</span>
                    <span className="shrink-0 text-xs text-[#667478]">
                      {row.status === "error" ? row.error : `${row.progress}%`}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[#edf1ef]">
                    <div
                      className={`h-full rounded-full ${row.status === "error" ? "bg-[#c84630]" : "bg-[#0f8b8d]"}`}
                      style={{ width: `${row.status === "error" ? 100 : row.progress}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {sortedItems.folders.length === 0 && sortedItems.files.length === 0 ? (
          <EmptyState
            title={query ? "No matches in this folder" : "This folder is empty"}
            detail={canWrite ? "Add folders or upload documents to continue organizing diligence material." : undefined}
            action={
              canWrite && !query ? (
                <Button onClick={() => inputRef.current?.click()}>
                  <Upload size={16} />
                  Upload files
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-[#dbe2df] bg-white">
            <div className="grid grid-cols-[1fr_130px_128px_132px] gap-3 border-b border-[#e5e9e7] bg-[#f7f9f8] px-4 py-2 text-xs font-semibold uppercase text-[#667478] max-lg:hidden">
              <span>Name</span>
              <span>Size</span>
              <span>Modified</span>
              <span className="text-right">Actions</span>
            </div>

            {sortedItems.folders.map((folder) => (
              <div
                key={folder.id}
                className="grid grid-cols-[1fr_auto] gap-3 border-b border-[#eef2f0] px-4 py-3 last:border-b-0 lg:grid-cols-[1fr_130px_128px_132px] lg:items-center"
              >
                <button
                  type="button"
                  onClick={() => onOpenFolder(folder.id)}
                  className="flex min-w-0 items-center gap-3 text-left"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[#ecf4f1] text-[#0f7779]">
                    <Folder size={20} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-[#273236]">{folder.name}</span>
                    <span className="mt-0.5 block text-xs text-[#738083] lg:hidden">
                      {pluralize(folder.fileCount, "file")} · {formatBytes(folder.sizeBytes)}
                    </span>
                  </span>
                </button>
                <span className="hidden text-sm text-[#667478] lg:block">{formatBytes(folder.sizeBytes)}</span>
                <span className="hidden text-sm text-[#667478] lg:block">{formatDate(folder.updatedAt)}</span>
                <div className="flex justify-end gap-1">
                  {canWrite ? (
                    <>
                      <IconButton title="Rename folder" onClick={() => openRename({ type: "FOLDER", item: folder })}>
                        <Pencil size={16} />
                      </IconButton>
                      <IconButton
                        title="Share folder"
                        onClick={() =>
                          setShareTarget({ resourceType: "FOLDER", resourceId: folder.id, label: folder.name })
                        }
                      >
                        <Link2 size={16} />
                      </IconButton>
                      <IconButton title="Delete folder" onClick={() => openDelete({ type: "FOLDER", item: folder })}>
                        <Trash2 size={16} />
                      </IconButton>
                    </>
                  ) : (
                    <MoreHorizontal size={18} className="text-[#9aa5a8]" />
                  )}
                </div>
              </div>
            ))}

            {sortedItems.files.map((file) => (
              <div
                key={file.id}
                className="grid grid-cols-[1fr_auto] gap-3 border-b border-[#eef2f0] px-4 py-3 last:border-b-0 lg:grid-cols-[1fr_130px_128px_132px] lg:items-center"
              >
                <button
                  type="button"
                  onClick={() => setPreviewFile(file)}
                  className="flex min-w-0 items-center gap-3 text-left"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[#fff1ed] text-[#c84630]">
                    <FileText size={20} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-[#273236]">{file.name}</span>
                    <span className="mt-0.5 block text-xs text-[#738083] lg:hidden">
                      {formatBytes(file.sizeBytes)} · {formatDate(file.updatedAt)}
                    </span>
                  </span>
                </button>
                <span className="hidden text-sm text-[#667478] lg:block">{formatBytes(file.sizeBytes)}</span>
                <span className="hidden text-sm text-[#667478] lg:block">{formatDate(file.updatedAt)}</span>
                <div className="flex justify-end gap-1">
                  <IconButton title="Preview file" onClick={() => setPreviewFile(file)}>
                    <Eye size={16} />
                  </IconButton>
                  <IconButton
                    title="Download file"
                    onClick={() => window.open(fileContentUrl(file.id, token, true), "_blank", "noopener,noreferrer")}
                  >
                    <Download size={16} />
                  </IconButton>
                  {canWrite ? (
                    <>
                      <IconButton title="Rename file" onClick={() => openRename({ type: "FILE", item: file })}>
                        <Pencil size={16} />
                      </IconButton>
                      <IconButton title="Move file" onClick={() => openMove(file)}>
                        <Send size={16} />
                      </IconButton>
                      <IconButton
                        title="Share file"
                        onClick={() => setShareTarget({ resourceType: "FILE", resourceId: file.id, label: file.name })}
                      >
                        <Link2 size={16} />
                      </IconButton>
                      <IconButton title="Delete file" onClick={() => openDelete({ type: "FILE", item: file })}>
                        <Trash2 size={16} />
                      </IconButton>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {createFolderOpen ? (
        <Modal title="New folder" onClose={() => setCreateFolderOpen(false)}>
          <form onSubmit={createFolder} className="space-y-4">
            <TextInput value={folderName} onChange={(event) => setFolderName(event.target.value)} autoFocus />
            <Button disabled={busy} className="w-full">
              {busy ? <Spinner /> : null}
              Create
            </Button>
          </form>
        </Modal>
      ) : null}

      {renameTarget ? (
        <Modal title={`Rename ${renameTarget.type === "FOLDER" ? "folder" : "file"}`} onClose={() => setRenameTarget(null)}>
          <form onSubmit={rename} className="space-y-4">
            <TextInput value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus />
            <Button disabled={busy} className="w-full">
              {busy ? <Spinner /> : null}
              Rename
            </Button>
          </form>
        </Modal>
      ) : null}

      {deleteTarget ? (
        <Modal title={`Delete ${deleteTarget.item.name}`} onClose={() => setDeleteTarget(null)}>
          <div className="space-y-4">
            <Notice tone="danger">
              {deleteTarget.type === "FOLDER" && deleteTarget.preview
                ? `This deletes ${pluralize(deleteTarget.preview.folders, "folder")}, ${pluralize(deleteTarget.preview.files, "file")}, and ${formatBytes(deleteTarget.preview.sizeBytes)}.`
                : "This deletes the file for everyone with access."}
            </Notice>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
              <Button type="button" variant="danger" disabled={busy} onClick={confirmDelete}>
                {busy ? <Spinner /> : null}
                Delete
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {moveTarget ? (
        <Modal title={`Move ${moveTarget.name}`} onClose={() => setMoveTarget(null)}>
          <form onSubmit={moveFile} className="space-y-4">
            <select
              value={targetFolderId}
              onChange={(event) => setTargetFolderId(event.target.value)}
              className="h-10 w-full rounded-md border border-[#d4dad7] bg-white px-3 text-sm"
            >
              {moveFolders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.path ?? folder.name}
                </option>
              ))}
            </select>
            <Button disabled={busy} className="w-full">
              {busy ? <Spinner /> : null}
              Move
            </Button>
          </form>
        </Modal>
      ) : null}

      {shareTarget ? (
        <ShareDialog
          resourceType={shareTarget.resourceType}
          resourceId={shareTarget.resourceId}
          label={shareTarget.label}
          onClose={() => setShareTarget(null)}
        />
      ) : null}

      {previewFile ? <FilePreview file={previewFile} token={token} onClose={() => setPreviewFile(null)} /> : null}
    </div>
  );
}
