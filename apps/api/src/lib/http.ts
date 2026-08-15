import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodSchema } from "zod";

export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function assertFound<T>(value: T | null | undefined, message = "Not found"): T {
  if (!value) {
    throw new HttpError(404, message);
  }
  return value;
}

export function parseBody<T>(schema: ZodSchema<T>, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpError(400, "Invalid request body", error.flatten());
    }
    throw error;
  }
}

export function routeParam(req: Request, name: string) {
  const value = req.params[name];
  if (!value) {
    throw new HttpError(400, `Missing route parameter: ${name}`);
  }
  return value;
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res, next).catch(next);
  };
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (typeof error === "object" && error && "name" in error && error.name === "MulterError") {
    return res.status(400).json({
      error: {
        message: "Upload failed",
        details: "The file is too large or the upload request is malformed"
      }
    });
  }

  if (error instanceof HttpError) {
    return res.status(error.status).json({
      error: {
        message: error.message,
        details: error.details
      }
    });
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      error: {
        message: "Invalid request body",
        details: error.flatten()
      }
    });
  }

  console.error(error);
  return res.status(500).json({
    error: {
      message: "Something went wrong"
    }
  });
}
