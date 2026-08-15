import type { Folder, Prisma, PrismaClient } from "@prisma/client";

type Tx = Prisma.TransactionClient | PrismaClient;

export type CounterDelta = {
  sizeBytes?: number;
  fileCount?: number;
  folderCount?: number;
};

function cleanDelta(delta: CounterDelta) {
  return {
    sizeBytes: delta.sizeBytes ?? 0,
    fileCount: delta.fileCount ?? 0,
    folderCount: delta.folderCount ?? 0
  };
}

export async function getFolderAncestorIds(db: Tx, folderId: string) {
  const ids: string[] = [];
  let cursor: string | null = folderId;

  while (cursor) {
    const folder: Pick<Folder, "id" | "parentId"> | null = await db.folder.findUnique({
      where: { id: cursor },
      select: { id: true, parentId: true }
    });

    if (!folder) break;
    ids.push(folder.id);
    cursor = folder.parentId;
  }

  return ids;
}

export async function applySubtreeDelta(
  db: Tx,
  dataRoomId: string,
  folderId: string | null,
  delta: CounterDelta
) {
  const counters = cleanDelta(delta);
  if (!counters.sizeBytes && !counters.fileCount && !counters.folderCount) {
    return;
  }

  if (folderId) {
    const ancestorIds = await getFolderAncestorIds(db, folderId);
    if (ancestorIds.length > 0) {
      await db.folder.updateMany({
        where: { id: { in: ancestorIds } },
        data: {
          sizeBytes: { increment: counters.sizeBytes },
          fileCount: { increment: counters.fileCount },
          folderCount: { increment: counters.folderCount }
        }
      });
    }
  }

  await db.dataRoom.update({
    where: { id: dataRoomId },
    data: {
      sizeBytes: { increment: counters.sizeBytes },
      fileCount: { increment: counters.fileCount },
      folderCount: { increment: counters.folderCount }
    }
  });
}
