import { check } from 'k6';

/**
 * Safely parses JSON from a k6 HTTP Response.
 * @param {import('k6/http').RefinedResponse<any>} res
 * @returns {any | null}
 */
export function safeJson(res) {
  if (!res || !res.body) {
    return null;
  }
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

/**
 * Validates the standard Warehouse API SuccessEnvelope contract (TECH_SPEC.md §2.3 & §2.4.1).
 * @param {import('k6/http').RefinedResponse<any>} res
 * @param {number} expectedStatus
 * @param {string} [label]
 * @returns {boolean}
 */
export function checkSuccessEnvelope(res, expectedStatus = 200, label = 'API') {
  const body = safeJson(res);
  const reqIdHeader = res.headers['X-Request-Id'] || res.headers['x-request-id'];

  return check(res, {
    [`${label}: status is ${expectedStatus}`]: (r) => r.status === expectedStatus,
    [`${label}: success is true`]: () => body !== null && body.success === true,
    [`${label}: data payload present`]: () => body !== null && body.data !== undefined,
    [`${label}: requestId in envelope`]: () =>
      body !== null && typeof body.requestId === 'string' && body.requestId.length > 0,
    [`${label}: X-Request-ID header present`]: () =>
      typeof reqIdHeader === 'string' && reqIdHeader.length > 0,
  });
}

/**
 * Validates the standard Warehouse API Paginated SuccessEnvelope contract (TECH_SPEC.md §2.3).
 * @param {import('k6/http').RefinedResponse<any>} res
 * @param {string} [label]
 * @returns {boolean}
 */
export function checkPaginatedEnvelope(res, label = 'Paginated API') {
  const body = safeJson(res);

  return check(res, {
    [`${label}: status is 200`]: (r) => r.status === 200,
    [`${label}: success is true`]: () => body !== null && body.success === true,
    [`${label}: data is array`]: () => body !== null && Array.isArray(body.data),
    [`${label}: pagination metadata valid`]: () =>
      body !== null &&
      body.pagination !== undefined &&
      typeof body.pagination.page === 'number' &&
      typeof body.pagination.page_size === 'number' &&
      typeof body.pagination.total_count === 'number' &&
      typeof body.pagination.total_pages === 'number',
  });
}

/**
 * Validates the standard Warehouse API ErrorEnvelope contract (TECH_SPEC.md §2.3 & §2.5).
 * @param {import('k6/http').RefinedResponse<any>} res
 * @param {number} expectedStatus
 * @param {string} [expectedErrorCode]
 * @param {string} [label]
 * @returns {boolean}
 */
export function checkErrorEnvelope(res, expectedStatus, expectedErrorCode, label = 'Error API') {
  const body = safeJson(res);
  const checks = {
    [`${label}: status is ${expectedStatus}`]: (r) => r.status === expectedStatus,
    [`${label}: success is false`]: () => body !== null && body.success === false,
    [`${label}: error object present`]: () =>
      body !== null &&
      body.error !== undefined &&
      typeof body.error.code === 'string' &&
      typeof body.error.message === 'string',
    [`${label}: requestId in error envelope`]: () =>
      body !== null && typeof body.requestId === 'string' && body.requestId.length > 0,
  };

  if (expectedErrorCode) {
    checks[`${label}: error.code is ${expectedErrorCode}`] = () =>
      body !== null && body.error && body.error.code === expectedErrorCode;
  }

  return check(res, checks);
}
