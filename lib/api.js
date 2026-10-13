import http from 'k6/http';
import { fail } from 'k6';
import { BASE_URL, ADMIN_CREDENTIALS, DEFAULT_PASSWORD, uniqueName } from './config.js';
import { safeJson } from './assertions.js';
import { purgeTestDataFromDb } from './db.js';

/**
 * Pre-initialized expected status callbacks (per k6 v2.3.0 Params.responseCallback best practices).
 * Using EXPECTED_NON_5XX makes built-in `http_req_failed` specifically track status >= 500 or network errors.
 */
export const EXPECTED_2XX = http.expectedStatuses({ min: 200, max: 299 });
export const EXPECTED_NON_5XX = http.expectedStatuses({ min: 200, max: 499 });
export const EXPECTED_ORDER_RACE = http.expectedStatuses(200, 201, 409, 422);
export const EXPECTED_CANCEL_RACE = http.expectedStatuses(200, 422);
export const EXPECTED_LOGIN_401 = http.expectedStatuses(401);

/**
 * Builds request params with Bearer auth, optional Idempotency-Key, X-Request-ID, and URL grouping tags.
 * Per TECH_SPEC.md §2.6, GET and DELETE requests omit Content-Type.
 * @param {object} opts
 * @param {string} [opts.token]
 * @param {boolean} [opts.hasBody]
 * @param {string} [opts.idempotencyKey]
 * @param {string} [opts.requestId]
 * @param {object} [opts.tags]
 * @param {any} [opts.responseCallback]
 * @returns {import('k6/http').Params}
 */
export function buildParams({
  token,
  hasBody = false,
  idempotencyKey,
  requestId,
  tags = {},
  responseCallback,
} = {}) {
  const headers = {
    Accept: 'application/json',
  };

  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  if (requestId) {
    headers['X-Request-ID'] = requestId;
  }

  const params = { headers, tags };
  if (responseCallback) {
    params.responseCallback = responseCallback;
  }
  return params;
}

// ============================================================================
// Auth Endpoints (TECH_SPEC.md §5.2)
// ============================================================================

export function adminLogin(
  username = ADMIN_CREDENTIALS.username,
  password = ADMIN_CREDENTIALS.password,
  extraParams = {}
) {
  return http.post(
    `${BASE_URL}/api/admin/login`,
    JSON.stringify({ username, password }),
    buildParams({
      hasBody: true,
      tags: { name: 'POST /api/admin/login', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

export function userLogin(username, password = DEFAULT_PASSWORD, extraParams = {}) {
  return http.post(
    `${BASE_URL}/api/user/login`,
    JSON.stringify({ username, password }),
    buildParams({
      hasBody: true,
      tags: { name: 'POST /api/user/login', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

// ============================================================================
// Admin Endpoints (TECH_SPEC.md §5.3)
// ============================================================================

export function createAdminUser(adminToken, userPayload, extraParams = {}) {
  return http.post(
    `${BASE_URL}/api/admin/users`,
    JSON.stringify(userPayload),
    buildParams({
      token: adminToken,
      hasBody: true,
      tags: { name: 'POST /api/admin/users', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

export function topUpUserBalance(adminToken, userId, incrementAmount, extraParams = {}) {
  return http.post(
    `${BASE_URL}/api/admin/users/${userId}/balance/top-up`,
    JSON.stringify({ increment_amount: incrementAmount }),
    buildParams({
      token: adminToken,
      hasBody: true,
      tags: { name: 'POST /api/admin/users/{id}/balance/top-up', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

export function updateUserFilters(
  adminToken,
  userId,
  allowedCategories = [],
  allowedManufacturers = [],
  extraParams = {}
) {
  return http.put(
    `${BASE_URL}/api/admin/users/${userId}/filters`,
    JSON.stringify({
      allowed_categories: allowedCategories,
      allowed_manufacturers: allowedManufacturers,
    }),
    buildParams({
      token: adminToken,
      hasBody: true,
      tags: { name: 'PUT /api/admin/users/{id}/filters', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

export function createProduct(adminToken, productPayload, extraParams = {}) {
  return http.post(
    `${BASE_URL}/api/admin/products`,
    JSON.stringify(productPayload),
    buildParams({
      token: adminToken,
      hasBody: true,
      tags: { name: 'POST /api/admin/products', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

export function updateProductStock(adminToken, productId, stockQuantity, extraParams = {}) {
  return http.patch(
    `${BASE_URL}/api/admin/products/${productId}/stock`,
    JSON.stringify({ stock_quantity: stockQuantity }),
    buildParams({
      token: adminToken,
      hasBody: true,
      tags: { name: 'PATCH /api/admin/products/{id}/stock', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

export function listAdminUsers(adminToken, query = '', extraParams = {}) {
  const qs = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  return http.get(
    `${BASE_URL}/api/admin/users${qs}`,
    buildParams({
      token: adminToken,
      hasBody: false,
      tags: { name: 'GET /api/admin/users', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

export function getAdminUserById(adminToken, userId, extraParams = {}) {
  return http.get(
    `${BASE_URL}/api/admin/users/${userId}`,
    buildParams({
      token: adminToken,
      hasBody: false,
      tags: { name: 'GET /api/admin/users/{id}', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

export function deleteAdminUser(adminToken, userId, extraParams = {}) {
  const res = http.del(
    `${BASE_URL}/api/admin/users/${userId}`,
    null,
    buildParams({
      token: adminToken,
      hasBody: false,
      tags: { name: 'DELETE /api/admin/users/{id}', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
  if (__ENV.SKIP_DB_PURGE !== '1') {
    purgeTestDataFromDb({ userIds: [userId], purgeByK6Prefix: true });
  }
  return res;
}

export function listAdminProducts(adminToken, extraParams = {}) {
  return http.get(
    `${BASE_URL}/api/admin/products`,
    buildParams({
      token: adminToken,
      hasBody: false,
      tags: { name: 'GET /api/admin/products', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

export function listAdminOrders(adminToken, extraParams = {}) {
  return http.get(
    `${BASE_URL}/api/admin/orders`,
    buildParams({
      token: adminToken,
      hasBody: false,
      tags: { name: 'GET /api/admin/orders', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

export function updateOrderStatus(adminToken, orderId, status = 'CANCELLED', extraParams = {}) {
  return http.patch(
    `${BASE_URL}/api/admin/orders/${orderId}/status`,
    JSON.stringify({ status }),
    buildParams({
      token: adminToken,
      hasBody: true,
      tags: { name: 'PATCH /api/admin/orders/{id}/status', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

// ============================================================================
// User Endpoints (TECH_SPEC.md §5.4)
// ============================================================================

export function getUserProfile(userToken, extraParams = {}) {
  return http.get(
    `${BASE_URL}/api/user/profile`,
    buildParams({
      token: userToken,
      hasBody: false,
      tags: { name: 'GET /api/user/profile', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

export function listUserProducts(userToken, query = '', extraParams = {}) {
  const qs = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  return http.get(
    `${BASE_URL}/api/user/products${qs}`,
    buildParams({
      token: userToken,
      hasBody: false,
      tags: { name: 'GET /api/user/products', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

export function createOrder(userToken, productId, quantity = 1, extraParams = {}) {
  return http.post(
    `${BASE_URL}/api/user/orders`,
    JSON.stringify({ product_id: productId, quantity }),
    buildParams({
      token: userToken,
      hasBody: true,
      tags: { name: 'POST /api/user/orders', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

export function listUserOrders(userToken, extraParams = {}) {
  return http.get(
    `${BASE_URL}/api/user/orders`,
    buildParams({
      token: userToken,
      hasBody: false,
      tags: { name: 'GET /api/user/orders', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

export function getUserOrderById(userToken, orderId, extraParams = {}) {
  return http.get(
    `${BASE_URL}/api/user/orders/${orderId}`,
    buildParams({
      token: userToken,
      hasBody: false,
      tags: { name: 'GET /api/user/orders/{id}', ...(extraParams.tags || {}) },
      ...extraParams,
    })
  );
}

// ============================================================================
// High-Level Setup / Fixture Provisioning Helpers
// ============================================================================

/**
 * Logs in as admin and returns the admin Bearer JWT token. Fails setup if login fails.
 * @returns {string}
 */
export function requireAdminToken() {
  const res = adminLogin();
  const body = safeJson(res);
  if (res.status !== 200 || !body || !body.data || !body.data.token) {
    fail(`Setup failed: unable to login as admin (status=${res.status}, body=${res.body})`);
  }
  return body.data.token;
}

/**
 * Creates an isolated test user and returns { id, username, password, balance, token }.
 */
export function provisionTestUser(
  adminToken,
  {
    prefix = 'k6_user',
    password = DEFAULT_PASSWORD,
    role = 'user',
    balance = 1000.0,
    allowedCategories = [],
    allowedManufacturers = [],
  } = {}
) {
  const username = uniqueName(prefix);
  const createRes = createAdminUser(adminToken, {
    username,
    password,
    role,
    balance,
    allowed_categories: allowedCategories,
    allowed_manufacturers: allowedManufacturers,
  });

  const createBody = safeJson(createRes);
  if (createRes.status !== 201 || !createBody || !createBody.data || !createBody.data.id) {
    fail(
      `Setup failed: unable to create test user '${username}' (status=${createRes.status}, body=${createRes.body})`
    );
  }

  const loginRes = role === 'admin' ? adminLogin(username, password) : userLogin(username, password);
  const loginBody = safeJson(loginRes);
  if (loginRes.status !== 200 || !loginBody || !loginBody.data || !loginBody.data.token) {
    fail(
      `Setup failed: unable to login as test user '${username}' (status=${loginRes.status}, body=${loginRes.body})`
    );
  }

  return {
    id: createBody.data.id,
    username,
    password,
    role,
    balance: createBody.data.balance,
    token: loginBody.data.token,
  };
}

/**
 * Creates an isolated test product and returns { id, category, manufacturer, model, price, stock_quantity }.
 */
export function provisionTestProduct(
  adminToken,
  {
    prefix = 'k6_model',
    category = 'laptop',
    manufacturer = 'Apple',
    price = 100.0,
    stockQuantity = 50,
  } = {}
) {
  const model = uniqueName(prefix);
  const res = createProduct(adminToken, {
    category,
    manufacturer,
    model,
    price,
    stock_quantity: stockQuantity,
  });

  const body = safeJson(res);
  if (res.status !== 201 || !body || !body.data || !body.data.id) {
    fail(`Setup failed: unable to create product '${model}' (status=${res.status}, body=${res.body})`);
  }

  return body.data;
}

/**
 * Fetches current product state from GET /api/admin/products by product UUID.
 */
export function fetchProductById(adminToken, productId) {
  const res = listAdminProducts(adminToken);
  const body = safeJson(res);
  if (res.status !== 200 || !body || !Array.isArray(body.data)) {
    return null;
  }
  return body.data.find((p) => p.id === productId) || null;
}

/**
 * Fetches current user state from GET /api/admin/users/{id}.
 */
export function fetchUserById(adminToken, userId) {
  const res = getAdminUserById(adminToken, userId);
  const body = safeJson(res);
  if (res.status !== 200 || !body || !body.data) {
    return null;
  }
  return body.data;
}
