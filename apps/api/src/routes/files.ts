import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import path from "node:path";
import { z } from "zod";
import { asyncHandler, HttpError, parseBody, routeParam } from "../lib/http.js";
import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { assertWriteAccess, getFileAccess, getFolderAccess, getRootFolder } from "../services/authz.js";
import { resolveUniqueName } from "../services/naming.js";
import { applySubtreeDelta } from "../services/stats.js";
import { storage } from "../services/storage.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MAX_UPLOAD_MB * 1024 * 1024,
    files: 20
  }
});

const renameSchema = z.object({
  name: z.string().trim().min(1).max(180)
});

const moveSchema = z.object({
  targetFolderId: z.string().min(1)
});

function isPdf(file: Express.Multer.File) {
  return file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
}

function storageKey(roomId: string, folderId: string, originalName: string) {
  const ext = path.extname(originalName) || ".pdf";
  return `${roomId}/${folderId}/${nanoid(20)}${ext}`;
}

function contentDisposition(fileName: string, download: boolean) {
  const fallback = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  const type = download ? "attachment" : "inline";
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

async function resolveTargetFolder(roomId: string, folderId: string) {
  if (folderId === "root") {
    return getRootFolder(roomId);
  }
  return prisma.folder.findUnique({ where: { id: folderId } });
}

router.post(
  "/data-rooms/:roomId/folders/:folderId/files",
  requireAuth,
  upload.array("files", 20),
  asyncHandler(async (req, res) => {
    const roomId = routeParam(req, "roomId");
    const folderParam = routeParam(req, "folderId");
    const folder = await resolveTargetFolder(roomId, folderParam);
    if (!folder || folder.dataRoomId !== roomId) {
      throw new HttpError(404, "Upload folder not found");
    }

    const access = await getFolderAccess({
      user: req.user,
      roomId,
      folderId: folder.id
    });
    await assertWriteAccess(access);

    const files = (req.files ?? []) as Express.Multer.File[];
    if (files.length === 0) {
      throw new HttpError(400, "Choose at least one PDF to upload");
    }

    const rejected = files.filter((file) => !isPdf(file));
    if (rejected.length > 0) {
      throw new HttpError(400, "Only PDF uploads are supported in this MVP", {
        rejected: rejected.map((file) => file.originalname)
      });
    }

    const created = [];
    for (const file of files) {
      const resolved = await resolveUniqueName(file.originalname, "file", async (candidate) => {
        const existing = await prisma.file.findFirst({
          where: {
            folderId: folder.id,
            name: candidate
          }
        });
        return Boolean(existing);
      });

      const key = storageKey(access.room.id, folder.id, resolved.name);
      await storage.putObject({
        key,
        buffer: file.buffer,
        contentType: file.mimetype || "application/pdf"
      });

      const record = await prisma.$transaction(async (tx) => {
        const createdFile = await tx.file.create({
          data: {
            dataRoomId: access.room.id,
            folderId: folder.id,
            ownerId: req.user!.id,
            name: resolved.name,
            originalName: file.originalname,
            mimeType: file.mimetype || "application/pdf",
            sizeBytes: file.size,
            storageKey: key
          }
        });
        await applySubtreeDelta(tx, access.room.id, folder.id, {
          sizeBytes: file.size,
          fileCount: 1
        });
        return createdFile;
      });

      created.push({ ...record, conflictResolved: resolved.conflictResolved });
    }

    res.status(201).json({ files: created });
  })
);

router.get(
  "/files/:fileId/content",
  asyncHandler(async (req, res) => {
    const fileId = routeParam(req, "fileId");
    const access = await getFileAccess({
      user: req.user,
      fileId,
      token: typeof req.query.token === "string" ? req.query.token : undefined
    });

    const object = await storage.getObject(access.file.storageKey);
    res.setHeader("Content-Type", access.file.mimeType || object.contentType || "application/pdf");
    res.setHeader("Content-Length", String(access.file.sizeBytes));
    res.setHeader("Content-Disposition", contentDisposition(access.file.name, req.query.download === "1"));
    object.stream.on("error", () => res.destroy());
    object.stream.pipe(res);
  })
);

router.patch(
  "/files/:fileId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = parseBody(renameSchema, req.body);
    const fileId = routeParam(req, "fileId");
    const access = await getFileAccess({
      user: req.user,
      fileId
    });
    await assertWriteAccess(access);

    const resolved = await resolveUniqueName(input.name, "file", async (candidate) => {
      const existing = await prisma.file.findFirst({
        where: {
          folderId: access.file.folderId,
          name: candidate,
          id: { not: access.file.id }
        }
      });
      return Boolean(existing);
    });

    const file = await prisma.file.update({
      where: { id: access.file.id },
      data: { name: resolved.name }
    });

    res.json({ file, conflictResolved: resolved.conflictResolved });
  })
);

router.patch(
  "/files/:fileId/move",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = parseBody(moveSchema, req.body);
    const fileId = routeParam(req, "fileId");
    const access = await getFileAccess({
      user: req.user,
      fileId
    });
    await assertWriteAccess(access);

    const target = await resolveTargetFolder(access.room.id, input.targetFolderId);
    if (!target || target.dataRoomId !== access.room.id) {
      throw new HttpError(404, "Destination folder not found");
    }

    const targetAccess = await getFolderAccess({
      user: req.user,
      roomId: access.room.id,
      folderId: target.id
    });
    await assertWriteAccess(targetAccess);

    const resolved = await resolveUniqueName(access.file.name, "file", async (candidate) => {
      const existing = await prisma.file.findFirst({
        where: {
          folderId: target.id,
          name: candidate,
          id: { not: access.file.id }
        }
      });
      return Boolean(existing);
    });

    const moved = await prisma.$transaction(async (tx) => {
      const file = await tx.file.update({
        where: { id: access.file.id },
        data: {
          folderId: target.id,
          name: resolved.name
        }
      });

      if (access.file.folderId !== target.id) {
        await applySubtreeDelta(tx, access.room.id, access.file.folderId, {
          sizeBytes: -access.file.sizeBytes,
          fileCount: -1
        });
        await applySubtreeDelta(tx, access.room.id, target.id, {
          sizeBytes: access.file.sizeBytes,
          fileCount: 1
        });
      }

      return file;
    });

    res.json({ file: moved, conflictResolved: resolved.conflictResolved });
  })
);

router.delete(
  "/files/:fileId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const fileId = routeParam(req, "fileId");
    const access = await getFileAccess({
      user: req.user,
      fileId
    });
    await assertWriteAccess(access);

    await prisma.$transaction(async (tx) => {
      await tx.file.delete({ where: { id: access.file.id } });
      await tx.share.updateMany({
        where: {
          resourceType: "FILE",
          resourceId: access.file.id,
          revokedAt: null
        },
        data: { revokedAt: new Date() }
      });
      await applySubtreeDelta(tx, access.room.id, access.file.folderId, {
        sizeBytes: -access.file.sizeBytes,
        fileCount: -1
      });
    });

    await storage.deleteObject(access.file.storageKey);
    res.status(204).send();
  })
);

export { router as filesRouter };
