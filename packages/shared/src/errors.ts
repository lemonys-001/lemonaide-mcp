/** Stable, descriptive error codes surfaced to MCP clients and API responses. */
export const ErrorCode = {
  // auth
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  TOKEN_REVOKED: "TOKEN_REVOKED",
  INSUFFICIENT_SCOPE: "INSUFFICIENT_SCOPE",

  // validation
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_PATH: "INVALID_PATH",
  INVALID_SLUG: "INVALID_SLUG",
  INVALID_USERNAME: "INVALID_USERNAME",
  RESERVED_NAME: "RESERVED_NAME",

  // resources
  NOT_FOUND: "NOT_FOUND",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  CONFLICT: "CONFLICT",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",

  // quotas / limits
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  RATE_LIMITED: "RATE_LIMITED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",

  // build/deploy pipeline
  BUILD_INVALID_STATE: "BUILD_INVALID_STATE",
  BUILD_FAILED: "BUILD_FAILED",
  BUILD_TIMEOUT: "BUILD_TIMEOUT",
  BUILD_CANCELED: "BUILD_CANCELED",
  UNSUPPORTED_FRAMEWORK: "UNSUPPORTED_FRAMEWORK",
  DEPLOY_INVALID_STATE: "DEPLOY_INVALID_STATE",
  DEPLOY_FAILED: "DEPLOY_FAILED",
  OUTPUT_VALIDATION_FAILED: "OUTPUT_VALIDATION_FAILED",

  // integrations
  NOT_CONFIGURED: "NOT_CONFIGURED",
  GITHUB_NOT_CONNECTED: "GITHUB_NOT_CONNECTED",
  GITHUB_ERROR: "GITHUB_ERROR",
  GITHUB_SECRET_DETECTED: "GITHUB_SECRET_DETECTED",

  // infra
  INTERNAL: "INTERNAL",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class LemonAIdeError extends Error {
  readonly code: ErrorCodeValue;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    code: ErrorCodeValue,
    message: string,
    options?: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LemonAIdeError";
    this.code = code;
    this.details = options?.details;
    this.retryable = options?.retryable ?? false;
  }

  toJSON(): { code: string; message: string; details?: Record<string, unknown>; retryable: boolean } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      retryable: this.retryable,
    };
  }
}

export function isLemonAIdeError(err: unknown): err is LemonAIdeError {
  return err instanceof LemonAIdeError;
}
