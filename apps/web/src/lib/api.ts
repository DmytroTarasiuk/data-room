export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

export type User = {
  id: string;
  email: string;
  name: string;
};

export type DataRoom = {
  id: string;
  ownerId: string;
  name: string;
  sizeBytes: number;
  fileCount: number;
  folderCount: number;
  rootFolderId: string;
  createdAt: string;
  updatedAt: string;
};

export type Folder = {
  id: string;
  dataRoomId: string;
  parentId: string | null;
  name: string;
  sizeBytes: number;
  fileCount: number;
  folderCount: number;
  createdAt: string;
  updatedAt: string;
  path?: string;
};

export type FileItem = {
  id: string;
  dataRoomId: string;
  folderId: string;
  ownerId: string;
  name: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  createdAt: string;
  updatedAt: string;
};

export type Share = {
  id: string;
  resourceType: ResourceType;
  resourceId: string;
  mode: "PUBLIC" | "PERMISSIONED";
  role: "VIEWER" | "EDITOR";
  recipientEmail: string | null;
  token: string;
  createdAt: string;
  revokedAt: string | null;
};

export type ResourceType = "DATA_ROOM" | "FOLDER" | "FILE";

export type SharedItem = {
  id: string;
  token: string;
  role: string;
  resourceType: ResourceType;
  resourceId: string;
  label: string;
  roomId: string;
  folderId?: string;
  fileId?: string;
  owner: { name: string; email: string };
  createdAt: string;
};

export type ContentsResponse = {
  folder: Folder;
  room: { id: string; ownerId: string; name: string };
  breadcrumbs: Array<{ id: string; name: string }>;
  folders: Folder[];
  files: FileItem[];
  access: { canWrite: boolean; role: string };
};

export type ShareResolveResponse = {
  share: Share;
  resource: {
    type: ResourceType;
    id: string;
    label: string;
    roomId: string;
    folderId?: string;
    fileId?: string;
    mimeType?: string;
    sizeBytes?: number;
    owner: { name: string; email: string };
  };
  access: { canWrite: boolean; role: string };
};

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
};

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  let body = options.body as BodyInit | undefined;

  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    body,
    credentials: "include"
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, payload?.error?.message ?? "Request failed", payload?.error?.details);
  }

  return payload as T;
}

export function fileContentUrl(fileId: string, token?: string, download = false) {
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (download) params.set("download", "1");
  const query = params.toString();
  return `${API_URL}/api/files/${fileId}/content${query ? `?${query}` : ""}`;
}

export function uploadPdf(
  roomId: string,
  folderId: string,
  file: File,
  onProgress: (percent: number) => void
) {
  return new Promise<FileItem[]>((resolve, reject) => {
    const formData = new FormData();
    formData.append("files", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/api/data-rooms/${roomId}/folders/${folderId}/files`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      try {
        const payload = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload.files ?? []);
        } else {
          reject(new ApiError(xhr.status, payload?.error?.message ?? "Upload failed", payload?.error?.details));
        }
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "Upload failed"));
    xhr.send(formData);
  });
}
