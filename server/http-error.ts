import type { ErrorRequestHandler, Response } from "express";

/** 09 共通エラーの 12 種 */
export const ERROR_STATUS = {
  UNAUTHORIZED: 401,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  BUSY: 409,
  INSUFFICIENT_STORAGE: 507,
  PATH_NOT_ALLOWED: 400,
  INVALID_GGUF: 400,
  ENGINE_FAILED: 503,
  UPSTREAM_ERROR: 502,
  AUTH_REQUIRED_UPSTREAM: 401,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown[],
  ) {
    super(message);
  }
}

export function sendError(res: Response, error: ApiError): void {
  res.status(ERROR_STATUS[error.code]).json({
    error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
  });
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof ApiError) return sendError(res, error);
  console.error("[worker]", error);
  sendError(res, new ApiError("INTERNAL", "内部エラーが発生しました"));
};
