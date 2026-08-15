import { Router } from "express";
import { nanoid } from "nanoid";
import { z } from "zod";
import { assertFound, asyncHandler, HttpError, parseBody, routeParam } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import {
  RESOURCE_TYPES,
  ROLES,
  SHARE_MODES,
  assertOwnsResource,
  getRootFolder,
  readShareToken
} from "../services/authz.js";

const router = Router();

const createShareSchema = z.object({
  resourceType: z.enum(RESOURCE_TYPES),
  resourceId: z.string().min(1),
  mode: z.enum(SHARE_MODES),
  role: z.enum(ROLES).default("VIEWER"),
  recipientEmail: z
    .string()
    .email()
    .optional()
    .transform((email) => email?.toLowerCase())
});

function serializeShare(share: {
  id: string;
  resourceType: string;
  resourceId: string;
  mode: string;
  role: string;
  recipientEmail: string | null;
  token: string;
  createdAt: Date;
  revokedAt: Date | null;
}) {
  return {
    id: share.id,
    resourceType: share.resourceType,
    resourceId: share.resourceId,
    mode: share.mode,
    role: share.role,
    recipientEmail: share.recipientEmail,
    token: share.token,
    createdAt: share.createdAt,
    revokedAt: share.revokedAt
  };
}

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = parseBody(createShareSchema, req.body);
    const resource = await assertOwnsResource(req.user!, input.resourceType, input.resourceId);

    if (input.mode === "PERMISSIONED" && !input.recipientEmail) {
      throw new HttpError(400, "Choose a recipient email for permissioned sharing");
    }
    if (input.recipientEmail === req.user!.email.toLowerCase()) {
      throw new HttpError(400, "You already own this item");
    }

    const existing = await prisma.share.findFirst({
      where: {
        ownerId: req.user!.id,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        mode: input.mode,
        recipientEmail: input.mode === "PERMISSIONED" ? input.recipientEmail : null,
        revokedAt: null
      }
    });

    if (existing) {
      return res.json({ share: serializeShare(existing), resource, reused: true });
    }

    const share = await prisma.share.create({
      data: {
        ownerId: req.user!.id,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        mode: input.mode,
        role: input.role,
        recipientEmail: input.mode === "PERMISSIONED" ? input.recipientEmail! : null,
        token: nanoid(32)
      }
    });

    res.status(201).json({ share: serializeShare(share), resource, reused: false });
  })
);

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const resourceType = req.query.resourceType;
    const resourceId = req.query.resourceId;
    if (
      typeof resourceType !== "string" ||
      typeof resourceId !== "string" ||
      !RESOURCE_TYPES.includes(resourceType as (typeof RESOURCE_TYPES)[number])
    ) {
      throw new HttpError(400, "Choose a valid resource to inspect shares");
    }

    await assertOwnsResource(req.user!, resourceType as (typeof RESOURCE_TYPES)[number], resourceId);
    const shares = await prisma.share.findMany({
      where: {
        ownerId: req.user!.id,
        resourceType,
        resourceId
      },
      orderBy: { createdAt: "desc" }
    });

    res.json({ shares: shares.map(serializeShare) });
  })
);

router.get(
  "/:token/resolve",
  asyncHandler(async (req, res) => {
    const share = await readShareToken(routeParam(req, "token"), req.user);

    if (share.resourceType === "DATA_ROOM") {
      const room = assertFound(
        await prisma.dataRoom.findUnique({
          where: { id: share.resourceId },
          include: { owner: { select: { name: true, email: true } } }
        }),
        "The shared data room was removed"
      );
      const root = await getRootFolder(room.id);
      return res.json({
        share: serializeShare(share),
        resource: {
          type: "DATA_ROOM",
          id: room.id,
          label: room.name,
          roomId: room.id,
          folderId: root.id,
          owner: room.owner
        },
        access: { canWrite: false, role: share.role }
      });
    }

    if (share.resourceType === "FOLDER") {
      const folder = assertFound(
        await prisma.folder.findUnique({
          where: { id: share.resourceId },
          include: { dataRoom: { include: { owner: { select: { name: true, email: true } } } } }
        }),
        "The shared folder was removed"
      );
      return res.json({
        share: serializeShare(share),
        resource: {
          type: "FOLDER",
          id: folder.id,
          label: folder.parentId ? folder.name : folder.dataRoom.name,
          roomId: folder.dataRoomId,
          folderId: folder.id,
          owner: folder.dataRoom.owner
        },
        access: { canWrite: false, role: share.role }
      });
    }

    const file = assertFound(
      await prisma.file.findUnique({
        where: { id: share.resourceId },
        include: { dataRoom: { include: { owner: { select: { name: true, email: true } } } } }
      }),
      "The shared file was removed"
    );

    return res.json({
      share: serializeShare(share),
      resource: {
        type: "FILE",
        id: file.id,
        label: file.name,
        roomId: file.dataRoomId,
        fileId: file.id,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        owner: file.dataRoom.owner
      },
      access: { canWrite: false, role: share.role }
    });
  })
);

router.delete(
  "/:shareId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const shareId = routeParam(req, "shareId");
    const share = assertFound(
      await prisma.share.findUnique({ where: { id: shareId } }),
      "Share not found"
    );
    if (share.ownerId !== req.user!.id) {
      throw new HttpError(403, "Only the owner can revoke this share");
    }

    const updated = await prisma.share.update({
      where: { id: share.id },
      data: { revokedAt: new Date() }
    });
    res.json({ share: serializeShare(updated) });
  })
);

export { router as sharesRouter };
