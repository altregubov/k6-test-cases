/**
 * Scenario 05: F-10 — Cross-Transaction Deadlock Detection (`40P01` / `40001`)
 *
 * Reference: NFT.MD (Finding F-10: Cross-Transaction Deadlock Detection)
 *
 * Test Case:
 *   • Multi-Actor Lock Contention targeting the SAME `user_id` and `product_id` simultaneously:
 *     - Scenario A (`scenario_a_create_orders`, 20 VUs): `POST /api/user/orders` (locks `users` + `products`)
 *     - Scenario B (`scenario_b_cancel_orders`, 10 VUs): `PATCH /api/admin/orders/{id}/status` (locks `orders` + `users` + `products`)
 *     - Scenario C (`scenario_c_topup_balance`, 10 VUs): `POST /api/admin/users/{id}/balance/top-up` (locks `users`)
 *   • Assertions:
 *     - `deadlock_5xx_errors == 0` (verifies deterministic lock ordering and absence of PostgreSQL `40P01` deadlocks or unhandled `40001` serialization failures)
 *     - Ledger conservation: final stock reconciles with initial stock minus active `PROCESSED` order units.
 *
 * Usage (k6 v2.3.0):
 *   ./k6 run scenarios/05-f10-cross-tx-deadlock.js
 *   ./k6 run --scenario scenario_a_create_orders,scenario_b_cancel_orders,scenario_c_topup_balance scenarios/05-f10-cross-tx-deadlock.js
 */

import { check } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate } from 'k6/metrics';
import {
  requireAdminToken,
  provisionTestUser,
  provisionTestProduct,
  createOrder,
  updateOrderStatus,
  topUpUserBalance,
  listUserOrders,
  fetchUserById,
  fetchProductById,
  deleteAdminUser,
  EXPECTED_NON_5XX,
} from '../lib/api.js';
import { safeJson } from '../lib/assertions.js';
import { createSummaryHandler } from '../lib/html-report.js';

const ORDER_VUS = Number(__ENV.ORDER_VUS || 20);
const CANCEL_VUS = Number(__ENV.CANCEL_VUS || 10);
const TOPUP_VUS = Number(__ENV.TOPUP_VUS || 10);
const ITERS_PER_VU = Number(__ENV.ITERS_PER_VU || 3);

const UNIT_PRICE = 10.0;
const TOPUP_AMOUNT = 10.0;
const INITIAL_STOCK = 5000;
const INITIAL_BALANCE = 50000.0;

export const deadlock5xxErrors = new Counter('f10_deadlock_5xx_errors');
export const ordersCreatedCount = new Counter('f10_deadlock_orders_created_201');
export const ordersCancelledCount = new Counter('f10_deadlock_orders_cancelled_200');
export const topupsCompletedCount = new Counter('f10_deadlock_topups_completed_200');
export const ledgerReconciledOk = new Rate('f10_deadlock_ledger_reconciled_ok');

export const options = {
  scenarios: {
    scenario_a_create_orders: {
      executor: 'per-vu-iterations',
      exec: 'actorCreateOrders',
      vus: ORDER_VUS,
      iterations: ITERS_PER_VU,
      startTime: '0s',
      maxDuration: '60s',
    },
    scenario_b_cancel_orders: {
      executor: 'per-vu-iterations',
      exec: 'actorCancelOrders',
      vus: CANCEL_VUS,
      iterations: ITERS_PER_VU,
      startTime: '0s',
      maxDuration: '60s',
    },
    scenario_c_topup_balance: {
      executor: 'per-vu-iterations',
      exec: 'actorTopUpBalance',
      vus: TOPUP_VUS,
      iterations: ITERS_PER_VU,
      startTime: '0s',
      maxDuration: '60s',
    },
  },
  thresholds: {
    f10_deadlock_5xx_errors: ['count == 0'],
    'http_req_failed{scenario:scenario_a_create_orders}': ['rate == 0'],
    'http_req_failed{scenario:scenario_b_cancel_orders}': ['rate == 0'],
    'http_req_failed{scenario:scenario_c_topup_balance}': ['rate == 0'],
    f10_deadlock_ledger_reconciled_ok: ['rate == 1.0'],
  },
};

export function setup() {
  const adminToken = requireAdminToken();

  const product = provisionTestProduct(adminToken, {
    prefix: 'k6_f10_deadlock_prod',
    category: 'laptop',
    manufacturer: 'Apple',
    price: UNIT_PRICE,
    stockQuantity: INITIAL_STOCK,
  });

  const user = provisionTestUser(adminToken, {
    prefix: 'k6_f10_deadlock_user',
    balance: INITIAL_BALANCE,
  });

  const totalCancellableOrders = CANCEL_VUS * ITERS_PER_VU;
  const seededOrderIds = [];
  for (let i = 0; i < totalCancellableOrders; i++) {
    const res = createOrder(user.token, product.id, 1);
    const body = safeJson(res);
    if (res.status === 201 && body && body.data && body.data.order_id) {
      seededOrderIds.push(body.data.order_id);
    }
  }

  return {
    adminToken,
    user,
    product,
    seededOrderIds,
  };
}

export function actorCreateOrders(data) {
  const res = createOrder(data.user.token, data.product.id, 1, {
    responseCallback: EXPECTED_NON_5XX,
  });

  if (res.status >= 500) {
    deadlock5xxErrors.add(1);
  } else if (res.status === 201) {
    ordersCreatedCount.add(1);
  }

  check(res, {
    'F-10 Scenario A (create order): no 500 deadlock/serialization error': (r) => r.status < 500,
    'F-10 Scenario A (create order): status is 201': (r) => r.status === 201,
  });
}

export function actorCancelOrders(data) {
  const idx = exec.scenario.iterationInTest % data.seededOrderIds.length;
  const targetOrderId = data.seededOrderIds[idx];

  const res = updateOrderStatus(data.adminToken, targetOrderId, 'CANCELLED', {
    responseCallback: EXPECTED_NON_5XX,
  });

  if (res.status >= 500) {
    deadlock5xxErrors.add(1);
  } else if (res.status === 200) {
    ordersCancelledCount.add(1);
  }

  check(res, {
    'F-10 Scenario B (cancel order): no 500 deadlock/serialization error': (r) => r.status < 500,
    'F-10 Scenario B (cancel order): status is 200 or 422': (r) =>
      r.status === 200 || r.status === 422,
  });
}

export function actorTopUpBalance(data) {
  const res = topUpUserBalance(data.adminToken, data.user.id, TOPUP_AMOUNT, {
    responseCallback: EXPECTED_NON_5XX,
  });

  if (res.status >= 500) {
    deadlock5xxErrors.add(1);
  } else if (res.status === 200) {
    topupsCompletedCount.add(1);
  }

  check(res, {
    'F-10 Scenario C (top-up balance): no 500 deadlock/serialization error': (r) => r.status < 500,
    'F-10 Scenario C (top-up balance): status is 200': (r) => r.status === 200,
  });
}

export default function (data) {
  actorCreateOrders(data);
}

export function teardown(data) {
  const { adminToken, user, product } = data;

  const finalUser = fetchUserById(adminToken, user.id);
  const finalProduct = fetchProductById(adminToken, product.id);
  const ordersRes = listUserOrders(user.token);
  const ordersBody = safeJson(ordersRes);

  if (finalUser && finalProduct && ordersBody && Array.isArray(ordersBody.data)) {
    const activeProcessedUnits = ordersBody.data
      .filter((o) => o.product_id === product.id && o.status === 'PROCESSED')
      .reduce((sum, o) => sum + o.quantity, 0);

    const expectedStock = INITIAL_STOCK - activeProcessedUnits;
    const stockReconciled = finalProduct.stock_quantity === expectedStock;

    ledgerReconciledOk.add(stockReconciled);

    const passed = check(
      { actualStock: finalProduct.stock_quantity, expectedStock },
      {
        'F-10 Deadlock Invariant: final stock reconciles with active PROCESSED orders': (s) =>
          s.actualStock === s.expectedStock,
      }
    );

    if (!passed) {
      exec.test.fail(
        `F-10 Deadlock stock reconciliation failed: actualStock=${finalProduct.stock_quantity}, expectedStock=${expectedStock}`
      );
    }
  }

  deleteAdminUser(adminToken, user.id);
}

export const handleSummary = createSummaryHandler({
  id: '05-f10-cross-tx-deadlock',
  title: '05 — F-10: Cross-Transaction Deadlock Detection (40P01 / 40001)',
  finding: 'NFT.MD • Finding F-10: Multi-Actor Lock Contention (Orders + Cancels + Top-Ups)',
  description:
    'Runs 3 concurrent k6 scenarios targeting the same user_id and product_id simultaneously: Scenario A (20 VUs: POST /api/user/orders), Scenario B (10 VUs: PATCH /api/admin/orders/{id}/status), and Scenario C (10 VUs: POST /api/admin/users/{id}/balance/top-up). Asserts 0 5xx errors and absence of PostgreSQL deadlocks.',
  vus: ORDER_VUS + CANCEL_VUS + TOPUP_VUS,
});
