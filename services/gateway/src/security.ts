/**
 * Security utilities for Fastify gateway hardening:
 * - JSON recursion / depth limits
 * - Attribution header validation and control-character sanitization
 * - Token count and parameter validation
 */

export const DEFAULT_MAX_JSON_DEPTH = 32;

/**
 * Checks whether an object or array exceeds the maximum allowed nesting depth.
 * Acyclic traversal terminating at maxDepth + 1.
 */
export function isExcessiveNesting(
  value: unknown,
  maxDepth = DEFAULT_MAX_JSON_DEPTH,
  currentDepth = 0
): boolean {
  if (currentDepth > maxDepth) {
    return true;
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (isExcessiveNesting(value[i], maxDepth, currentDepth + 1)) {
        return true;
      }
    }
  } else {
    for (const key of Object.keys(value)) {
      if (isExcessiveNesting((value as Record<string, unknown>)[key], maxDepth, currentDepth + 1)) {
        return true;
      }
    }
  }

  return false;
}

export interface HeaderValidationResult {
  valid: boolean;
  value?: string;
  error?: string;
}

/**
 * Validates attribution headers (e.g. x-request-id, x-team-id, x-workload-id).
 * Must be non-empty string, length 1..256, containing printable ASCII characters
 * without control characters or CRLF injection.
 */
export function validateInboundHeader(
  headerName: string,
  rawValue: unknown
): HeaderValidationResult {
  if (rawValue === undefined) {
    return { valid: true };
  }

  if (typeof rawValue !== 'string') {
    return {
      valid: false,
      error: `Invalid ${headerName} header: must be a non-empty string with maximum length of 256 characters`,
    };
  }

  const trimmed = rawValue.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    return {
      valid: false,
      error: `Invalid ${headerName} header: must be a non-empty string with maximum length of 256 characters`,
    };
  }

  // Reject ASCII control characters (0x00-0x1F, 0x7F) including \r, \n, \0
  if (/[\x00-\x1F\x7F]/.test(rawValue)) {
    return {
      valid: false,
      error: `Invalid ${headerName} header: must be a non-empty string with maximum length of 256 characters`,
    };
  }

  return {
    valid: true,
    value: trimmed,
  };
}

export interface ParameterValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates requested max_tokens parameter.
 * Must be undefined (omitted) or a safe positive integer >= 1.
 */
export function validateTokenCount(maxTokens: unknown): ParameterValidationResult {
  if (maxTokens === undefined) {
    return { valid: true };
  }

  if (
    typeof maxTokens !== 'number' ||
    !Number.isInteger(maxTokens) ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1
  ) {
    return {
      valid: false,
      error: 'max_tokens must be a positive integer greater than or equal to 1',
    };
  }

  return { valid: true };
}

/**
 * Validates requested temperature parameter.
 * Must be undefined (omitted) or a finite number between 0 and 2.
 */
export function validateTemperature(temperature: unknown): ParameterValidationResult {
  if (temperature === undefined) {
    return { valid: true };
  }

  if (
    typeof temperature !== 'number' ||
    isNaN(temperature) ||
    !isFinite(temperature) ||
    temperature < 0 ||
    temperature > 2
  ) {
    return {
      valid: false,
      error: 'temperature must be a number between 0 and 2',
    };
  }

  return { valid: true };
}
