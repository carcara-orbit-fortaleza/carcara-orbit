export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message, details) {
  return new AppError(400, 'BAD_REQUEST', message, details);
}

export function notFound(message, details) {
  return new AppError(404, 'NOT_FOUND', message, details);
}

export function conflict(message, details) {
  return new AppError(409, 'CONFLICT', message, details);
}

export function unavailable(message, details) {
  return new AppError(503, 'UNAVAILABLE', message, details);
}
