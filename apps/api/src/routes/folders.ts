import { Router } from "express";
import type { Folder as PrismaFolder } from "@prisma/client";
import { z } from "zod";
import { assertFound, asyncHandler, HttpError, parseBody, routeParam } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { assertWriteAccess, getFolderAccess, getRootFolder } from "../services/authz.js";
import { resolveUniqueName } from "../services/naming.js";
import { applySubtreeDelta } from "../services/stats.js";
import { storage } from "../services/storage.js";

const router = Router();

const nameSchema = z.object({
  name: z.string().trim().min(1).max(160)
});

const createFolderSchema = nameSchema.extend({
  parentId: z.string().min(1)
});

function parseLimit(value: unknown) {
  const numeric = Number(value ?? 100);
  if (!Number.isFinite(numeric)) return 100;
  return Math.min(Math.max(Math.trunc(numeric), 1), 200);
}

async function resolveFolderParam(roomId: string, folderParam: string) {
  if (folderParam === "root") {
    return getRootFolder(roomId);
  }
  return assertFound(await prisma.folder.findUnique({ where: { id: folderParam } }), "Folder not found");
}

async function getBreadcrumbs(folderId: string, roomName: string) {
  const crumbs: Array<{ id: string; name: string }> = [];
  let cursor: string | null = folderId;

  while (cursor) {
    const folder: Pick<PrismaFolder, "id" | "name" | "parentId"> | null = await prisma.folder.findUnique({
      where: { id: cursor },
      select: { id: true, name: true, parentId: true }
    });
    if (!folder) break;
    crumbs.push({
      id: folder.id,
      name: folder.parentId ? folder.name : roomName
    });
    cursor = folder.parentId;
  }

  return crumbs.reverse();
}

async function getDescendantFolderIds(dataRoomId: string, folderId: string) {
  const folders = await prisma.folder.findMany({
    where: { dataRoomId },
    select: { id: true, parentId: true }
  });
  const byParent = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    const list = byParent.get(folder.parentId) ?? [];
    list.push(folder.id);
    byParent.set(folder.parentId, list);
  }

  const ids: string[] = [];
  const queue = [folderId];
  while (queue.length) {
    const current = queue.shift()!;
    ids.push(current);
    queue.push(...(byParent.get(current) ?? []));
  }
  return ids;
}

router.get(
  "/data-rooms/:roomId/folders/:folderId/contents",
  asyncHandler(async (req, res) => {
    const roomId = routeParam(req, "roomId");
    const folderParam = routeParam(req, "folderId");
    const folder = await resolveFolderParam(roomId, folderParam);
    const access = await getFolderAccess({
      user: req.user,
      roomId,
      folderId: folder.id,
      token: typeof req.query.token === "string" ? req.query.token : undefined
    });

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const limit = parseLimit(req.query.limit);
    const whereName = q ? { contains: q } : undefined;

    const [folders, files, breadcrumbs] = await Promise.all([
      prisma.folder.findMany({
        where: {
          dataRoomId: access.room.id,
          parentId: access.folder.id,
          ...(whereName ? { name: whereName } : {})
        },
        orderBy: [{ name: "asc" }],
        take: limit
      }),
      prisma.file.findMany({
        where: {
          dataRoomId: access.room.id,
          folderId: access.folder.id,
          ...(whereName ? { name: whereName } : {})
        },
        orderBy: [{ name: "asc" }],
        take: limit
      }),
      getBreadcrumbs(access.folder.id, access.room.name)
    ]);

    res.json({
      folder: access.folder.parentId
        ? access.folder
        : {
            ...access.folder,
            name: access.room.name
          },
      room: access.room,
      breadcrumbs,
      folders,
      files,
      access: {
        canWrite: access.canWrite,
        role: access.canWrite ? "OWNER" : access.share?.role ?? "VIEWER"
      }
    });
  })
);

router.get(
  "/data-rooms/:roomId/folders",
  requireAuth,
  asyncHandler(async (req, res) => {
    const roomId = routeParam(req, "roomId");
    const root = await getRootFolder(roomId);
    const access = await getFolderAccess({
      user: req.user,
      roomId,
      folderId: root.id
    });
    await assertWriteAccess(access);

    const folders = await prisma.folder.findMany({
      where: { dataRoomId: access.room.id },
      orderBy: [{ parentId: "asc" }, { name: "asc" }]
    });
    const byId = new Map(folders.map((folder) => [folder.id, folder]));

    function folderPath(folderId: string): string {
      const parts: string[] = [];
      let cursor = byId.get(folderId);
      while (cursor) {
        parts.push(cursor.parentId ? cursor.name : access.room.name);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }
      return parts.reverse().join(" / ");
    }

    res.json({
      folders: folders.map((folder) => ({
        ...folder,
        name: folder.parentId ? folder.name : access.room.name,
        path: folderPath(folder.id)
      }))
    });
  })
);

router.post(
  "/data-rooms/:roomId/folders",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = parseBody(createFolderSchema, req.body);
    const roomId = routeParam(req, "roomId");
    const parent = await resolveFolderParam(roomId, input.parentId);
    const access = await getFolderAccess({
      user: req.user,
      roomId,
      folderId: parent.id
    });
    await assertWriteAccess(access);

    const resolved = await resolveUniqueName(input.name, "folder", async (candidate) => {
      const existing = await prisma.folder.findFirst({
        where: {
          dataRoomId: access.room.id,
          parentId: parent.id,
          name: candidate
        }
      });
      return Boolean(existing);
    });

    const folder = await prisma.$transaction(async (tx) => {
      const created = await tx.folder.create({
        data: {
          dataRoomId: access.room.id,
          parentId: parent.id,
          name: resolved.name
        }
      });
      await applySubtreeDelta(tx, access.room.id, parent.id, { folderCount: 1 });
      return created;
    });

    res.status(201).json({ folder, conflictResolved: resolved.conflictResolved });
  })
);

router.get(
  "/folders/:folderId/delete-preview",
  requireAuth,
  asyncHandler(async (req, res) => {
    const folderId = routeParam(req, "folderId");
    const folder = assertFound(
      await prisma.folder.findUnique({ where: { id: folderId } }),
      "Folder not found"
    );
    if (!folder.parentId) {
      throw new HttpError(400, "The data room root folder cannot be deleted");
    }
    const access = await getFolderAccess({
      user: req.user,
      roomId: folder.dataRoomId,
      folderId: folder.id
    });
    await assertWriteAccess(access);

    res.json({
      folder,
      deletes: {
        folders: folder.folderCount + 1,
        files: folder.fileCount,
        sizeBytes: folder.sizeBytes
      }
    });
  })
);

router.patch(
  "/folders/:folderId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = parseBody(nameSchema, req.body);
    const folderId = routeParam(req, "folderId");
    const folder = assertFound(
      await prisma.folder.findUnique({ where: { id: folderId } }),
      "Folder not found"
    );
    if (!folder.parentId) {
      throw new HttpError(400, "Rename the data room instead of its root folder");
    }
    const access = await getFolderAccess({
      user: req.user,
      roomId: folder.dataRoomId,
      folderId: folder.id
    });
    await assertWriteAccess(access);

    const resolved = await resolveUniqueName(input.name, "folder", async (candidate) => {
      const existing = await prisma.folder.findFirst({
        where: {
          dataRoomId: folder.dataRoomId,
          parentId: folder.parentId,
          name: candidate,
          id: { not: folder.id }
        }
      });
      return Boolean(existing);
    });

    const updated = await prisma.folder.update({
      where: { id: folder.id },
      data: { name: resolved.name }
    });

    res.json({ folder: updated, conflictResolved: resolved.conflictResolved });
  })
);

router.delete(
  "/folders/:folderId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const folderId = routeParam(req, "folderId");
    const folder = assertFound(
      await prisma.folder.findUnique({ where: { id: folderId } }),
      "Folder not found"
    );
    if (!folder.parentId) {
      throw new HttpError(400, "The data room root folder cannot be deleted");
    }

    const access = await getFolderAccess({
      user: req.user,
      roomId: folder.dataRoomId,
      folderId: folder.id
    });
    await assertWriteAccess(access);

    const folderIds = await getDescendantFolderIds(folder.dataRoomId, folder.id);
    const files = await prisma.file.findMany({
      where: { folderId: { in: folderIds } },
      select: { id: true, storageKey: true }
    });
    const fileIds = files.map((file) => file.id);

    await prisma.$transaction(async (tx) => {
      await applySubtreeDelta(tx, folder.dataRoomId, folder.parentId, {
        sizeBytes: -folder.sizeBytes,
        fileCount: -folder.fileCount,
        folderCount: -(folder.folderCount + 1)
      });
      await tx.share.updateMany({
        where: {
          revokedAt: null,
          OR: [
            { resourceType: "FOLDER", resourceId: { in: folderIds } },
            ...(fileIds.length ? [{ resourceType: "FILE", resourceId: { in: fileIds } }] : [])
          ]
        },
        data: { revokedAt: new Date() }
      });
      await tx.folder.delete({ where: { id: folder.id } });
    });

    await Promise.allSettled(files.map((file) => storage.deleteObject(file.storageKey)));
    res.status(204).send();
  })
);

export { router as foldersRouter };
