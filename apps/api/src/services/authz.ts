import type { File, Folder, Share } from "@prisma/client";
import { HttpError, assertFound } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middleware/auth.js";

export const RESOURCE_TYPES = ["DATA_ROOM", "FOLDER", "FILE"] as const;
export const SHARE_MODES = ["PUBLIC", "PERMISSIONED"] as const;
export const ROLES = ["VIEWER", "EDITOR"] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];
export type ShareMode = (typeof SHARE_MODES)[number];
export type Role = (typeof ROLES)[number];

export type FolderAccess = {
  canWrite: boolean;
  folder: Folder;
  room: { id: string; ownerId: string; name: string };
  scope: "OWNER" | "SHARE";
  share?: Share;
};

export type FileAccess = {
  canWrite: boolean;
  file: File;
  room: { id: string; ownerId: string; name: string };
  scope: "OWNER" | "SHARE";
  share?: Share;
};

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function getRootFolder(dataRoomId: string) {
  return assertFound(
    await prisma.folder.findFirst({
      where: { dataRoomId, parentId: null }
    }),
    "Root folder not found"
  );
}

export async function isFolderWithin(folderId: string, ancestorId: string) {
  let cursor: string | null = folderId;

  while (cursor) {
    if (cursor === ancestorId) return true;
    const folder: Pick<Folder, "parentId"> | null = await prisma.folder.findUnique({
      where: { id: cursor },
      select: { parentId: true }
    });
    cursor = folder?.parentId ?? null;
  }

  return false;
}

async function validateShareIdentity(share: Share, user?: AuthUser) {
  if (share.revokedAt) {
    throw new HttpError(404, "This share link is no longer active");
  }

  if (share.mode !== "PERMISSIONED") {
    return;
  }

  if (!user) {
    throw new HttpError(401, "Sign in with the invited email address to view this share");
  }

  if (share.ownerId === user.id) {
    return;
  }

  if (!share.recipientEmail || normalizeEmail(user.email) !== normalizeEmail(share.recipientEmail)) {
    throw new HttpError(403, "This share was not granted to your account");
  }
}

export async function readShareToken(token: string, user?: AuthUser) {
  const share = assertFound(
    await prisma.share.findUnique({ where: { token } }),
    "This share link was not found"
  );
  await validateShareIdentity(share, user);
  return share;
}

async function shareMatchesFolder(share: Share, folder: Folder, roomId: string) {
  if (share.resourceType === "DATA_ROOM") {
    return share.resourceId === roomId;
  }
  if (share.resourceType === "FOLDER") {
    return isFolderWithin(folder.id, share.resourceId);
  }
  return false;
}

async function shareMatchesFile(share: Share, file: File, roomId: string) {
  if (share.resourceType === "DATA_ROOM") {
    return share.resourceId === roomId;
  }
  if (share.resourceType === "FOLDER") {
    return isFolderWithin(file.folderId, share.resourceId);
  }
  if (share.resourceType === "FILE") {
    return share.resourceId === file.id;
  }
  return false;
}

async function findPermissionedFolderShare(user: AuthUser, folder: Folder, roomId: string) {
  const shares = await prisma.share.findMany({
    where: {
      recipientEmail: normalizeEmail(user.email),
      mode: "PERMISSIONED",
      revokedAt: null,
      resourceType: { in: ["DATA_ROOM", "FOLDER"] }
    }
  });

  for (const share of shares) {
    if (await shareMatchesFolder(share, folder, roomId)) {
      return share;
    }
  }

  return undefined;
}

async function findPermissionedFileShare(user: AuthUser, file: File, roomId: string) {
  const shares = await prisma.share.findMany({
    where: {
      recipientEmail: normalizeEmail(user.email),
      mode: "PERMISSIONED",
      revokedAt: null,
      resourceType: { in: ["DATA_ROOM", "FOLDER", "FILE"] }
    }
  });

  for (const share of shares) {
    if (await shareMatchesFile(share, file, roomId)) {
      return share;
    }
  }

  return undefined;
}

export async function getFolderAccess(input: {
  user?: AuthUser;
  roomId: string;
  folderId: string;
  token?: string;
}): Promise<FolderAccess> {
  const folder = assertFound(
    await prisma.folder.findUnique({
      where: { id: input.folderId }
    }),
    "Folder not found"
  );

  if (folder.dataRoomId !== input.roomId) {
    throw new HttpError(404, "Folder not found in this data room");
  }

  const room = assertFound(
    await prisma.dataRoom.findUnique({
      where: { id: input.roomId },
      select: { id: true, ownerId: true, name: true }
    }),
    "Data room not found"
  );

  if (input.user?.id === room.ownerId) {
    return { canWrite: true, folder, room, scope: "OWNER" };
  }

  if (input.token) {
    const share = await readShareToken(input.token, input.user);
    if (await shareMatchesFolder(share, folder, room.id)) {
      return { canWrite: false, folder, room, scope: "SHARE", share };
    }
  }

  if (input.user) {
    const share = await findPermissionedFolderShare(input.user, folder, room.id);
    if (share) {
      return { canWrite: false, folder, room, scope: "SHARE", share };
    }
  }

  throw new HttpError(403, "You do not have access to this folder");
}

export async function getFileAccess(input: {
  user?: AuthUser;
  fileId: string;
  token?: string;
}): Promise<FileAccess> {
  const file = assertFound(
    await prisma.file.findUnique({
      where: { id: input.fileId }
    }),
    "File not found"
  );

  const room = assertFound(
    await prisma.dataRoom.findUnique({
      where: { id: file.dataRoomId },
      select: { id: true, ownerId: true, name: true }
    }),
    "Data room not found"
  );

  if (input.user?.id === room.ownerId) {
    return { canWrite: true, file, room, scope: "OWNER" };
  }

  if (input.token) {
    const share = await readShareToken(input.token, input.user);
    if (await shareMatchesFile(share, file, room.id)) {
      return { canWrite: false, file, room, scope: "SHARE", share };
    }
  }

  if (input.user) {
    const share = await findPermissionedFileShare(input.user, file, room.id);
    if (share) {
      return { canWrite: false, file, room, scope: "SHARE", share };
    }
  }

  throw new HttpError(403, "You do not have access to this file");
}

export async function assertWriteAccess(access: { canWrite: boolean }) {
  if (!access.canWrite) {
    throw new HttpError(403, "This item is shared with read-only access");
  }
}

export async function assertOwnsResource(
  user: AuthUser,
  resourceType: ResourceType,
  resourceId: string
) {
  if (resourceType === "DATA_ROOM") {
    const room = assertFound(
      await prisma.dataRoom.findUnique({ where: { id: resourceId } }),
      "Data room not found"
    );
    if (room.ownerId !== user.id) throw new HttpError(403, "Only the owner can share this data room");
    return {
      resourceType,
      resourceId,
      dataRoomId: room.id,
      label: room.name
    };
  }

  if (resourceType === "FOLDER") {
    const folder = assertFound(
      await prisma.folder.findUnique({
        where: { id: resourceId },
        include: { dataRoom: true }
      }),
      "Folder not found"
    );
    if (folder.dataRoom.ownerId !== user.id) throw new HttpError(403, "Only the owner can share this folder");
    return {
      resourceType,
      resourceId,
      dataRoomId: folder.dataRoomId,
      label: folder.parentId ? folder.name : folder.dataRoom.name
    };
  }

  const file = assertFound(
    await prisma.file.findUnique({
      where: { id: resourceId },
      include: { dataRoom: true }
    }),
    "File not found"
  );
  if (file.dataRoom.ownerId !== user.id) throw new HttpError(403, "Only the owner can share this file");
  return {
    resourceType,
    resourceId,
    dataRoomId: file.dataRoomId,
    label: file.name
  };
}
