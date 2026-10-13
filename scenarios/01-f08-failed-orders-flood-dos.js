/**
 * Scenario 01: F-08 — Unbounded `FAILED` Order Flooding & Pagination DoS
 *
 * Reference: NFT.MD (Finding F-08)
 *
 * Test Case:
 *   • Stage 1 (`write_flood`): 20 VUs rapidly submit invalid orders (`422 INSUFFICIENT_FUNDS` /
 *     `INSUFFICIENT_STOCK`) for 30 seconds (configurable via `FLOOD_DURATION`), generating thousands
 *     of `FAILED` rows in `orders` at zero balance cost.
 *   • Stage 2 (`read_degradation`): Concurrently poll unpaginated `GET /api/admin/orders` and
 *     `GET /api/user/orders` and assert `p(95) < 500ms` and memory/response stability (exposes OOM /
 *     latency explosion caused by missing pagination).
 *
 * Usage (k6 v2.3.0):
 *   ./k6 run scenarios/01-f08-failed-orders-flood-dos.js
 *   FLOOD_DURATION=10s ./k6 run scenarios/01-f08-failed-orders-flood-dos.js
 *   ./k6 run --scenario write_flood,read_degradation --once scenarios/01-f08-failed-orders-flood-dos.js
 */

import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import { toCents } from '../lib/config.js';
import {
  requireAdminToken,
  provisionTestUser,
  provisionTestProduct,
  createOrder,
  listAdminOrders,
  listUserOrders,
  fetchUserById,
  fetchProductById,
  deleteAdminUser,
  EXPECTED_NON_5XX,
  EXPECTED_2XX,
} from '../lib/api.js';
import { safeJson, checkErrorEnvelope, checkSuccessEnvelope } from '../lib/assertions.js';
import { createSummaryHandler } from '../lib/html-report.js';

const FLOOD_DURATION = __ENV.FLOOD_DURATION || '30s';
const FLOOD_VUS = Number(__ENV.FLOOD_VUS || 20);
const READ_POLL_VUS = Number(__ENV.READ_POLL_VUS || 4);

export const failedOrdersInserted = new Counter('f08_failed_orders_recorded_422');
export const adminOrdersPollDuration = new Trend('f08_admin_orders_poll_duration', true);
export const userOrdersPollDuration = new Trend('f08_user_orders_poll_duration', true);
export const ordersPayloadBytes = new Trend('f08_orders_payload_bytes');
export const server5xxErrors = new Counter('f08_server_5xx_errors');
export const zeroCostFloodInvariantOk = new Rate('f08_zero_cost_invariant_ok');

export const options = {
  scenarios: {
    write_flood: {
      executor: 'constant-vus',
      exec: 'floodFailedOrders',
      vus: FLOOD_VUS,
      duration: FLOOD_DURATION,
      startTime: '0s',
    },
    read_degradation: {
      executor: 'constant-vus',
      exec: 'pollUnpaginatedOrders',
      vus: READ_POLL_VUS,
      duration: FLOOD_DURATION,
      startTime: '0s',
    },
  },
  thresholds: {
    f08_server_5xx_errors: ['count == 0'],
    f08_admin_orders_poll_duration: ['p(95) < 500'],
    f08_user_orders_poll_duration: ['p(95) < 500'],
    f08_zero_cost_invariant_ok: ['rate == 1.0'],
  },
};

export function setup() {
  const adminToken = requireAdminToken();

  const product = provisionTestProduct(adminToken, {
    prefix: 'k6_f08_prod',
    category: 'laptop',
    manufacturer: 'Dell',
    price: 500.0,
    stockQuantity: 2,
  });

  // User has $10.00 balance -> ordering 1 unit ($500) triggers 422 INSUFFICIENT_FUNDS,
  // ordering 10 units triggers 422 INSUFFICIENT_STOCK. Both insert a FAILED row at zero balance cost.
  const user = provisionTestUser(adminToken, {
    prefix: 'k6_f08_flooder',
    balance: 10.0,
  });

  return {
    adminToken,
    user,
    product,
    initialBalance: 10.0,
    initialStock: 2,
  };
}

export function floodFailedOrders(data) {
  const isStockBreach = exec.scenario.iterationInTest % 2 === 0;
  const qty = isStockBreach ? 10 : 1;
  const expectedCode = isStockBreach ? 'INSUFFICIENT_STOCK' : 'INSUFFICIENT_FUNDS';

  const res = createOrder(data.user.token, data.product.id, qty, {
    responseCallback: EXPECTED_NON_5XX,
  });

  if (res.status >= 500) {
    server5xxErrors.add(1);
  } else if (res.status === 422) {
    failedOrdersInserted.add(1);
  }

  checkErrorEnvelope(res, 422, expectedCode, 'F-08 flood POST /api/user/orders');
}

export function pollUnpaginatedOrders(data) {
  const userRes = listUserOrders(data.user.token, { responseCallback: EXPECTED_2XX });
  userOrdersPollDuration.add(userRes.timings.duration);
  if (userRes.body) {
    ordersPayloadBytes.add(userRes.body.length);
  }
  if (userRes.status >= 500) {
    server5xxErrors.add(1);
  }
  checkSuccessEnvelope(userRes, 200, 'F-08 poll GET /api/user/orders');

  const adminRes = listAdminOrders(data.adminToken, { responseCallback: EXPECTED_2XX });
  adminOrdersPollDuration.add(adminRes.timings.duration);
  if (adminRes.body) {
    ordersPayloadBytes.add(adminRes.body.length);
  }
  if (adminRes.status >= 500) {
    server5xxErrors.add(1);
  }
  checkSuccessEnvelope(adminRes, 200, 'F-08 poll GET /api/admin/orders');

  sleep(0.2);
}

export default function (data) {
  floodFailedOrders(data);
  pollUnpaginatedOrders(data);
}

export function teardown(data) {
  const { adminToken, user, product, initialBalance, initialStock } = data;

  const finalUser = fetchUserById(adminToken, user.id);
  const finalProduct = fetchProductById(adminToken, product.id);
  const userOrdersRes = listUserOrders(user.token);
  const userOrdersBody = safeJson(userOrdersRes);
  const recordedFailedCount =
    userOrdersBody && Array.isArray(userOrdersBody.data)
      ? userOrdersBody.data.filter((o) => o.status === 'FAILED').length
      : 0;

  const balanceUntouched =
    finalUser !== null && toCents(finalUser.balance) === toCents(initialBalance);
  const stockUntouched =
    finalProduct !== null && finalProduct.stock_quantity === initialStock;

  const invariantOk = balanceUntouched && stockUntouched;
  zeroCostFloodInvariantOk.add(invariantOk);

  check(
    { finalUser, finalProduct, recordedFailedCount },
    {
      'F-08 Invariant: FAILED order flood cost $0.00 user balance': () => balanceUntouched,
      'F-08 Invariant: FAILED order flood consumed 0 product stock': () => stockUntouched,
      'F-08 Audit: FAILED orders persisted in unpaginated order history': (s) =>
        s.recordedFailedCount > 0,
    }
  );

  console.log(
    `[F-08 Summary] Recorded ${recordedFailedCount} FAILED orders in DB at $0 balance cost (balance=${
      finalUser ? finalUser.balance : 'N/A'
    }, stock=${finalProduct ? finalProduct.stock_quantity : 'N/A'}).`
  );

  deleteAdminUser(adminToken, user.id);
}

export const handleSummary = createSummaryHandler({
  id: '01-f08-failed-orders-flood-dos',
  title: '01 — F-08: Unbounded FAILED Order Flooding & Pagination DoS',
  finding: 'NFT.MD • Finding F-08: Write Flood of FAILED Orders + Unpaginated GET /orders Polling',
  description:
    '20 VUs rapidly submit invalid orders (422 INSUFFICIENT_FUNDS / INSUFFICIENT_STOCK) generating thousands of FAILED rows at zero balance cost, while 4 VUs concurrently poll unpaginated GET /api/admin/orders and GET /api/user/orders (asserting p95 < 500ms).',
  vus: FLOOD_VUS + READ_POLL_VUS,
});
