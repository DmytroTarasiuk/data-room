import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { env } from "../lib/env.js";

export type PutObjectInput = {
  key: string;
  buffer: Buffer;
  contentType: string;
};

export type StoredObject = {
  stream: Readable;
  contentType?: string;
};

export interface BlobStorage {
  putObject(input: PutObjectInput): Promise<void>;
  getObject(key: string): Promise<StoredObject>;
  deleteObject(key: string): Promise<void>;
}

class LocalBlobStorage implements BlobStorage {
  private root = path.resolve(process.cwd(), env.LOCAL_STORAGE_DIR);

  async putObject(input: PutObjectInput) {
    const filePath = path.join(this.root, input.key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, input.buffer);
  }

  async getObject(key: string) {
    const filePath = path.join(this.root, key);
    return {
      stream: fs.createReadStream(filePath)
    };
  }

  async deleteObject(key: string) {
    const filePath = path.join(this.root, key);
    await fs.promises.rm(filePath, { force: true });
  }
}

class S3BlobStorage implements BlobStorage {
  private client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials:
      env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY
          }
        : undefined
  });

  async putObject(input: PutObjectInput) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: input.key,
        Body: input.buffer,
        ContentType: input.contentType
      })
    );
  }

  async getObject(key: string) {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key
      })
    );

    if (!(response.Body instanceof Readable)) {
      throw new Error("S3 returned an unreadable object body");
    }

    return {
      stream: response.Body,
      contentType: response.ContentType
    };
  }

  async deleteObject(key: string) {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key
      })
    );
  }
}

export const storage: BlobStorage =
  env.STORAGE_DRIVER === "s3" ? new S3BlobStorage() : new LocalBlobStorage();
