/**
 * Scenario 04: F-10 — Concurrent Order Cancellation Race (Double-Refund Check)
 *
 * Reference: NFT.MD (Finding F-10: Concurrent Order Cancellation Race)
 *
 * Test Case:
 *   • 20 Admin VUs Cancelling the Same Order:
 *     20 Admin VUs simultaneously send `PATCH /api/admin/orders/{id}/status`
 *     (`{"status": "CANCELLED"}`) for the same `PROCESSED` order.
 *   • Assertions:
 *     - `200 OK == 1`
 *     - `422 INVALID_STATUS == 19`
 *     - `0` `500` errors
 *     - Customer balance is refunded ONCE
 *     - Product stock is restored ONCE
 *
 * Usage (k6 v2.3.0):
 *   ./k6 run scenarios/04-f10-order-cancellation-race.js
 */

import { check, fail } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate } from 'k6/metrics';
import { toCents } from '../lib/config.js';
import {
  requireAdminToken,
  provisionTestUser,
  provisionTestProduct,
  createOrder,
  updateOrderStatus,
  fetchUserById,
  fetchProductById,
  deleteAdminUser,
  EXPECTED_CANCEL_RACE,
} from '../lib/api.js';
import { safeJson } from '../lib/assertions.js';
import { createSummaryHandler } from '../lib/html-report.js';

const CANCEL_VUS = Number(__ENV.CANCEL_VUS || 20);
const UNIT_PRICE = 100.0;
const INITIAL_STOCK = 10;
const INITIAL_BALANCE = 100.0;

export const cancel200Ok = new Counter('f10_cancel_200_ok');
export const cancel422InvalidStatus = new Counter('f10_cancel_422_invalid_status');
export const cancel5xxErrors = new Counter('f10_cancel_5xx_errors');
export const cancelUnexpectedStatus = new Counter('f10_cancel_unexpected_status');
export const cancelInvariantsOk = new Rate('f10_cancel_invariants_ok');

export const options = {
  scenarios: {
    cancel_race: {
      executor: 'per-vu-iterations',
      exec: 'attemptCancelOrder',
      vus: CANCEL_VUS,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    f10_cancel_200_ok: ['count == 1'],
    f10_cancel_422_invalid_status: [`count == ${CANCEL_VUS - 1}`],
    f10_cancel_5xx_errors: ['count == 0'],
    f10_cancel_unexpected_status: ['count == 0'],
    f10_cancel_invariants_ok: ['rate == 1.0'],
  },
};

export function setup() {
  const adminToken = requireAdminToken();

  const product = provisionTestProduct(adminToken, {
    prefix: 'k6_f10_cancel_prod',
    category: 'monitor',
    manufacturer: 'Dell',
    price: UNIT_PRICE,
    stockQuantity: INITIAL_STOCK,
  });

  const user = provisionTestUser(adminToken, {
    prefix: 'k6_f10_cancel_user',
    balance: INITIAL_BALANCE,
  });

  const orderRes = createOrder(user.token, product.id, 1);
  const orderBody = safeJson(orderRes);
  if (orderRes.status !== 201 || !orderBody || !orderBody.data || !orderBody.data.order_id) {
    fail(`Setup failed: unable to place initial PROCESSED order (status=${orderRes.status})`);
  }

  return {
    adminToken,
    user,
    product,
    orderId: orderBody.data.order_id,
  };
}

export function attemptCancelOrder(data) {
  const res = updateOrderStatus(data.adminToken, data.orderId, 'CANCELLED', {
    responseCallback: EXPECTED_CANCEL_RACE,
  });
  const body = safeJson(res);

  if (res.status === 200) {
    cancel200Ok.add(1);
    check(body, {
      'F-10 cancel 200: status transitioned to CANCELLED': (b) =>
        b && b.data && b.data.status === 'CANCELLED',
    });
  } else if (
    res.status === 422 &&
    body &&
    body.error &&
    body.error.code === 'INVALID_STATUS'
  ) {
    cancel422InvalidStatus.add(1);
  } else if (res.status >= 500) {
    cancel5xxErrors.add(1);
  } else {
    cancelUnexpectedStatus.add(1);
  }

  check(res, {
    'F-10 cancel: no 500 error': (r) => r.status < 500,
    'F-10 cancel: status is 200 OK or 422 INVALID_STATUS': (r) =>
      r.status === 200 || r.status === 422,
  });
}

export default function (data) {
  attemptCancelOrder(data);
}

export function teardown(data) {
  const { adminToken, user, product } = data;

  const finalUser = fetchUserById(adminToken, user.id);
  const finalProduct = fetchProductById(adminToken, product.id);

  const actualBalanceCents = finalUser ? toCents(finalUser.balance) : -1;
  const expectedBalanceCents = toCents(INITIAL_BALANCE);
  const actualStock = finalProduct ? finalProduct.stock_quantity : -1;

  const singleRefundOk = actualBalanceCents === expectedBalanceCents;
  const singleRestockOk = actualStock === INITIAL_STOCK;
  cancelInvariantsOk.add(singleRefundOk && singleRestockOk);

  const passed = check(
    { actualBalanceCents, expectedBalanceCents, actualStock },
    {
      'F-10 Cancel Invariant: customer balance refunded exactly ONCE ($100.00)': (s) =>
        s.actualBalanceCents === s.expectedBalanceCents,
      'F-10 Cancel Invariant: product stock restored exactly ONCE (10 units)': (s) =>
        s.actualStock === INITIAL_STOCK,
    }
  );

  if (!passed) {
    exec.test.fail(
      `F-10 Double-refund/restock invariant violated: finalBalanceCents=${actualBalanceCents} (expected ${expectedBalanceCents}), finalStock=${actualStock} (expected ${INITIAL_STOCK})`
    );
  }

  deleteAdminUser(adminToken, user.id);
}

export const handleSummary = createSummaryHandler({
  id: '04-f10-order-cancellation-race',
  title: '04 — F-10: Concurrent Order Cancellation Race (Double-Refund Check)',
  finding: 'NFT.MD • Finding F-10: 20 Admin VUs Cancelling the Same PROCESSED Order',
  description:
    '20 Admin VUs simultaneously send PATCH /api/admin/orders/{id}/status ({"status": "CANCELLED"}) for the same PROCESSED order. Asserts 200 OK == 1, 422 INVALID_STATUS == 19, customer balance refunded once, and product stock restored once.',
  vus: CANCEL_VUS,
});
