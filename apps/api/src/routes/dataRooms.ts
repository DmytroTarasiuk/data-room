import { Router } from "express";
import { z } from "zod";
import { assertFound, asyncHandler, HttpError, parseBody, routeParam } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { getRootFolder } from "../services/authz.js";
import { resolveUniqueName } from "../services/naming.js";

const router = Router();

const createRoomSchema = z.object({
  name: z.string().trim().min(1).max(120)
});

async function summarizeShare(share: {
  id: string;
  resourceType: string;
  resourceId: string;
  token: string;
  role: string;
  createdAt: Date;
}) {
  if (share.resourceType === "DATA_ROOM") {
    const room = await prisma.dataRoom.findUnique({
      where: { id: share.resourceId },
      include: { owner: { select: { name: true, email: true } } }
    });
    if (!room) return null;
    const root = await getRootFolder(room.id);
    return {
      id: share.id,
      token: share.token,
      role: share.role,
      resourceType: share.resourceType,
      resourceId: room.id,
      label: room.name,
      roomId: room.id,
      folderId: root.id,
      owner: room.owner,
      createdAt: share.createdAt
    };
  }

  if (share.resourceType === "FOLDER") {
    const folder = await prisma.folder.findUnique({
      where: { id: share.resourceId },
      include: { dataRoom: { include: { owner: { select: { name: true, email: true } } } } }
    });
    if (!folder) return null;
    return {
      id: share.id,
      token: share.token,
      role: share.role,
      resourceType: share.resourceType,
      resourceId: folder.id,
      label: folder.parentId ? folder.name : folder.dataRoom.name,
      roomId: folder.dataRoomId,
      folderId: folder.id,
      owner: folder.dataRoom.owner,
      createdAt: share.createdAt
    };
  }

  const file = await prisma.file.findUnique({
    where: { id: share.resourceId },
    include: { dataRoom: { include: { owner: { select: { name: true, email: true } } } } }
  });
  if (!file) return null;
  return {
    id: share.id,
    token: share.token,
    role: share.role,
    resourceType: share.resourceType,
    resourceId: file.id,
    label: file.name,
    roomId: file.dataRoomId,
    fileId: file.id,
    owner: file.dataRoom.owner,
    createdAt: share.createdAt
  };
}

router.use(requireAuth);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const owned = await prisma.dataRoom.findMany({
      where: { ownerId: req.user!.id },
      orderBy: { updatedAt: "desc" }
    });

    const ownedWithRoots = await Promise.all(
      owned.map(async (room) => ({
        ...room,
        rootFolderId: (await getRootFolder(room.id)).id
      }))
    );

    const shares = await prisma.share.findMany({
      where: {
        recipientEmail: req.user!.email.toLowerCase(),
        mode: "PERMISSIONED",
        revokedAt: null
      },
      orderBy: { createdAt: "desc" }
    });

    const shared = (await Promise.all(shares.map(summarizeShare))).filter(Boolean);

    res.json({ owned: ownedWithRoots, shared });
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = parseBody(createRoomSchema, req.body);
    const resolved = await resolveUniqueName(input.name, "folder", async (candidate) => {
      const existing = await prisma.dataRoom.findFirst({
        where: { ownerId: req.user!.id, name: candidate }
      });
      return Boolean(existing);
    });

    const room = await prisma.$transaction(async (tx) => {
      const dataRoom = await tx.dataRoom.create({
        data: {
          ownerId: req.user!.id,
          name: resolved.name
        }
      });

      const root = await tx.folder.create({
        data: {
          dataRoomId: dataRoom.id,
          parentId: null,
          name: "__root__"
        }
      });

      return { ...dataRoom, rootFolderId: root.id };
    });

    res.status(201).json({ room, conflictResolved: resolved.conflictResolved });
  })
);

router.patch(
  "/:roomId",
  asyncHandler(async (req, res) => {
    const input = parseBody(createRoomSchema, req.body);
    const roomId = routeParam(req, "roomId");
    const room = assertFound(
      await prisma.dataRoom.findUnique({ where: { id: roomId } }),
      "Data room not found"
    );
    if (room.ownerId !== req.user!.id) {
      throw new HttpError(403, "Only the owner can rename this data room");
    }

    const resolved = await resolveUniqueName(input.name, "folder", async (candidate) => {
      const existing = await prisma.dataRoom.findFirst({
        where: {
          ownerId: req.user!.id,
          name: candidate,
          id: { not: room.id }
        }
      });
      return Boolean(existing);
    });

    const updated = await prisma.dataRoom.update({
      where: { id: room.id },
      data: { name: resolved.name }
    });

    res.json({ room: updated, conflictResolved: resolved.conflictResolved });
  })
);

router.delete(
  "/:roomId",
  asyncHandler(async (req, res) => {
    const roomId = routeParam(req, "roomId");
    const room = assertFound(
      await prisma.dataRoom.findUnique({ where: { id: roomId } }),
      "Data room not found"
    );
    if (room.ownerId !== req.user!.id) {
      throw new HttpError(403, "Only the owner can delete this data room");
    }

    const files = await prisma.file.findMany({
      where: { dataRoomId: room.id },
      select: { id: true, storageKey: true }
    });
    const folders = await prisma.folder.findMany({
      where: { dataRoomId: room.id },
      select: { id: true }
    });
    const fileIds = files.map((file) => file.id);
    const folderIds = folders.map((folder) => folder.id);

    await prisma.$transaction(async (tx) => {
      await tx.share.updateMany({
        where: {
          revokedAt: null,
          OR: [
            { resourceType: "DATA_ROOM", resourceId: room.id },
            ...(folderIds.length ? [{ resourceType: "FOLDER", resourceId: { in: folderIds } }] : []),
            ...(fileIds.length ? [{ resourceType: "FILE", resourceId: { in: fileIds } }] : [])
          ]
        },
        data: { revokedAt: new Date() }
      });
      await tx.dataRoom.delete({ where: { id: room.id } });
    });

    const { storage } = await import("../services/storage.js");
    await Promise.allSettled(files.map((file) => storage.deleteObject(file.storageKey)));
    res.status(204).send();
  })
);

export { router as dataRoomsRouter };
