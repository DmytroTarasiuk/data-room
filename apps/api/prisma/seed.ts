import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";

const prisma = new PrismaClient();

const storageRoot = path.resolve(process.cwd(), process.env.LOCAL_STORAGE_DIR ?? "./storage");

function escapePdfText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function tinyPdf(title: string, lines: string[]) {
  const escaped = [title, ...lines].map(escapePdfText);
  const content = [
    "BT",
    "/F1 18 Tf",
    "72 730 Td",
    `(${escaped[0]}) Tj`,
    "/F1 11 Tf",
    ...escaped.slice(1).flatMap((line) => ["0 -22 Td", `(${line}) Tj`]),
    "ET"
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function applyDelta(dataRoomId: string, folderId: string | null, delta: { sizeBytes?: number; fileCount?: number; folderCount?: number }) {
  const sizeBytes = delta.sizeBytes ?? 0;
  const fileCount = delta.fileCount ?? 0;
  const folderCount = delta.folderCount ?? 0;

  let cursor = folderId;
  while (cursor) {
    const folder = await prisma.folder.update({
      where: { id: cursor },
      data: {
        sizeBytes: { increment: sizeBytes },
        fileCount: { increment: fileCount },
        folderCount: { increment: folderCount }
      },
      select: { parentId: true }
    });
    cursor = folder.parentId;
  }

  await prisma.dataRoom.update({
    where: { id: dataRoomId },
    data: {
      sizeBytes: { increment: sizeBytes },
      fileCount: { increment: fileCount },
      folderCount: { increment: folderCount }
    }
  });
}

async function createFolder(dataRoomId: string, parentId: string, name: string) {
  const folder = await prisma.folder.create({
    data: {
      dataRoomId,
      parentId,
      name
    }
  });
  await applyDelta(dataRoomId, parentId, { folderCount: 1 });
  return folder;
}

async function createPdf(dataRoomId: string, folderId: string, ownerId: string, name: string, lines: string[]) {
  const buffer = tinyPdf(name, lines);
  const key = `${dataRoomId}/${folderId}/${nanoid(20)}.pdf`;
  const filePath = path.join(storageRoot, key);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);

  const file = await prisma.file.create({
    data: {
      dataRoomId,
      folderId,
      ownerId,
      name,
      originalName: name,
      mimeType: "application/pdf",
      sizeBytes: buffer.byteLength,
      storageKey: key
    }
  });
  await applyDelta(dataRoomId, folderId, { fileCount: 1, sizeBytes: buffer.byteLength });
  return file;
}

async function main() {
  const passwordHash = await bcrypt.hash("password123", 12);

  const owner = await prisma.user.upsert({
    where: { email: "founder@acme.test" },
    update: { name: "Dana Founder", passwordHash },
    create: {
      email: "founder@acme.test",
      name: "Dana Founder",
      passwordHash
    }
  });

  await prisma.user.upsert({
    where: { email: "reviewer@acme.test" },
    update: { name: "Riley Reviewer", passwordHash },
    create: {
      email: "reviewer@acme.test",
      name: "Riley Reviewer",
      passwordHash
    }
  });

  const existingRooms = await prisma.dataRoom.findMany({
    where: { ownerId: owner.id },
    select: { id: true }
  });
  const roomIds = existingRooms.map((room) => room.id);
  await prisma.share.deleteMany({ where: { ownerId: owner.id } });
  await prisma.dataRoom.deleteMany({ where: { id: { in: roomIds } } });
  await fs.rm(storageRoot, { recursive: true, force: true });

  const room = await prisma.dataRoom.create({
    data: {
      ownerId: owner.id,
      name: "Project Horizon Data Room"
    }
  });
  const root = await prisma.folder.create({
    data: {
      dataRoomId: room.id,
      parentId: null,
      name: "__root__"
    }
  });

  const legal = await createFolder(room.id, root.id, "Legal");
  const financials = await createFolder(room.id, root.id, "Financials");
  const hr = await createFolder(room.id, root.id, "People");
  const contracts = await createFolder(room.id, legal.id, "Material Contracts");

  const consent = await createPdf(room.id, legal.id, owner.id, "Board Consent.pdf", [
    "Sample diligence document for the acquisition review.",
    "This file is generated by the seed script."
  ]);
  await createPdf(room.id, contracts.id, owner.id, "Supplier Agreement.pdf", [
    "Key commercial terms and renewal provisions.",
    "Confidential sample content."
  ]);
  await createPdf(room.id, financials.id, owner.id, "FY2025 Revenue Summary.pdf", [
    "Revenue bridge, adjustments, and working capital notes.",
    "Prepared for reviewer walkthrough."
  ]);
  await createPdf(room.id, hr.id, owner.id, "Executive Compensation.pdf", [
    "Compensation overview for leadership team.",
    "Restricted viewer sample."
  ]);

  await prisma.share.create({
    data: {
      ownerId: owner.id,
      resourceType: "FOLDER",
      resourceId: legal.id,
      mode: "PERMISSIONED",
      role: "VIEWER",
      recipientEmail: "reviewer@acme.test",
      token: nanoid(32)
    }
  });

  await prisma.share.create({
    data: {
      ownerId: owner.id,
      resourceType: "FILE",
      resourceId: consent.id,
      mode: "PUBLIC",
      role: "VIEWER",
      token: nanoid(32)
    }
  });

  console.log("Seeded demo accounts:");
  console.log("  founder@acme.test / password123");
  console.log("  reviewer@acme.test / password123");
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
