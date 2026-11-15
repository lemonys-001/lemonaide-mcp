/** Consistent API response envelope for /api/* routes. */

export type ApiSuccess<T> = {
  ok: true;
  data: T;
  correlationId: string;
};

export type ApiFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryable?: boolean;
  };
  correlationId: string;
};

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function apiOk<T>(data: T, correlationId: string): ApiSuccess<T> {
  return { ok: true, data, correlationId };
}

export function apiErr(
  code: string,
  message: string,
  correlationId: string,
  opts?: { details?: Record<string, unknown>; retryable?: boolean },
): ApiFailure {
  return {
    ok: false,
    error: { code, message, ...(opts?.details ? { details: opts.details } : {}), ...(opts?.retryable !== undefined ? { retryable: opts.retryable } : {}) },
    correlationId,
  };
}

/** Map a LemonAIde error code to an HTTP status. Unknown codes are 500s. */
export function httpStatusForErrorCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
    case "TOKEN_EXPIRED":
    case "TOKEN_REVOKED":
      return 401;
    case "FORBIDDEN":
    case "INSUFFICIENT_SCOPE":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "ALREADY_EXISTS":
    case "CONFLICT":
      return 409;
    case "INVALID_INPUT":
    case "INVALID_PATH":
    case "INVALID_SLUG":
    case "INVALID_USERNAME":
    case "RESERVED_NAME":
    case "CONFIRMATION_REQUIRED":
      return 400;
    case "QUOTA_EXCEEDED":
      return 429;
    case "RATE_LIMITED":
      return 429;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "BUILD_INVALID_STATE":
    case "BUILD_FAILED":
    case "BUILD_TIMEOUT":
    case "BUILD_CANCELED":
    case "DEPLOY_INVALID_STATE":
    case "DEPLOY_FAILED":
    case "OUTPUT_VALIDATION_FAILED":
    case "UNSUPPORTED_FRAMEWORK":
      return 422;
    case "GITHUB_NOT_CONNECTED":
      return 424;
    case "GITHUB_ERROR":
      return 502;
    case "NOT_CONFIGURED":
      return 424;
    case "GITHUB_SECRET_DETECTED":
      return 403;
    case "SERVICE_UNAVAILABLE":
    case "INTERNAL":
    default:
      return 500;
  }
}
