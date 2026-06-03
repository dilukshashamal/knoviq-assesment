import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export interface AppErrorInput {
  code: string;
  details?: unknown;
  message: string;
  statusCode: number;
}

export class AppError extends Error {
  code: string;
  details?: unknown;
  statusCode: number;

  constructor(input: AppErrorInput) {
    super(input.message);
    this.name = "AppError";
    this.code = input.code;
    this.statusCode = input.statusCode;

    if (input.details !== undefined) {
      this.details = input.details;
    }
  }
}

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError({ code: "bad_request", details, message, statusCode: 400 });
}

export function conflict(message: string): AppError {
  return new AppError({ code: "conflict", message, statusCode: 409 });
}

export function forbidden(message = "Forbidden"): AppError {
  return new AppError({ code: "forbidden", message, statusCode: 403 });
}

export function notFound(message = "Not found"): AppError {
  return new AppError({ code: "not_found", message, statusCode: 404 });
}

export function unauthorized(message = "Unauthorized"): AppError {
  return new AppError({ code: "unauthorized", message, statusCode: 401 });
}

function sendStructuredError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
) {
  const payload: {
    code: string;
    details?: unknown;
    message: string;
    requestId: string;
  } = {
    code,
    message,
    requestId,
  };

  if (details !== undefined) {
    payload.details = details;
  }

  return reply.status(statusCode).send(payload);
}

export function handleApiError(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const requestId = request.id;

  if (error instanceof AppError) {
    return sendStructuredError(
      reply,
      error.statusCode,
      error.code,
      error.message,
      requestId,
      error.details,
    );
  }

  if (error instanceof ZodError) {
    return sendStructuredError(
      reply,
      400,
      "validation_failed",
      "Request validation failed",
      requestId,
      error.issues,
    );
  }

  if (error.validation) {
    return sendStructuredError(
      reply,
      400,
      "validation_failed",
      "Request validation failed",
      requestId,
      error.validation,
    );
  }

  if (error.code === "FST_REQ_FILE_TOO_LARGE") {
    return sendStructuredError(
      reply,
      413,
      "file_too_large",
      "Uploaded file is too large",
      requestId,
    );
  }

  request.log.error({ err: error }, "unhandled request error");

  return sendStructuredError(
    reply,
    500,
    "internal_server_error",
    "Internal server error",
    requestId,
  );
}
