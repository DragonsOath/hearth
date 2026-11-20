/** Errors the API turns into actionable 4xx responses. */
export class NotFoundError extends Error {
  readonly statusCode = 404;
}

export class InvalidRequestError extends Error {
  readonly statusCode = 400;
}

export class ConflictError extends Error {
  readonly statusCode = 409;
}

export class ForbiddenError extends Error {
  readonly statusCode = 403;
}
