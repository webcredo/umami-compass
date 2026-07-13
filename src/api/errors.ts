export type UmamiErrorCode =
  | "ABORTED"
  | "AUTHENTICATION_FAILED"
  | "CONFIGURATION_ERROR"
  | "FORBIDDEN"
  | "INVALID_RESPONSE"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "VALIDATION_ERROR";

export class UmamiError extends Error {
  readonly code: UmamiErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: UmamiErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean; status?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "UmamiError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export function toSafeError(error: unknown): {
  code: UmamiErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
} {
  if (error instanceof UmamiError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }

  return {
    code: "UPSTREAM_ERROR",
    message: "The Umami request failed unexpectedly.",
    retryable: false,
  };
}
