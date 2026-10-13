/**
 * Scenario 06: F-10 — Lost-Update Race on `PATCH /api/admin/products/{id}/stock`
 *
 * Reference: NFT.MD (Finding F-10: Lost-Update Race on PATCH /api/admin/products/{id}/stock)
 *
 * Test Case:
 *   • Admin VU updates stock via `PATCH /api/admin/products/{id}/stock` (`stock_quantity: 50`)
 *     while User VUs concurrently purchase units via `POST /api/user/orders`.
 *   • Purpose:
 *     Demonstrates and measures the lost-update anomaly where absolute stock assignment
 *     (`SET stock_quantity = 50`) overwrites concurrent order decrements (`stock_quantity = stock_quantity - 1`).
 *
 * Usage (k6 v2.3.0):
 *   ./k6 run scenarios/06-f10-stock-lost-update-race.js
 */

import { check, sleep } from 'k6';
import { Counter, Gauge } from 'k6/metrics';
import {
  requireAdminToken,
  provisionTestUser,
  provisionTestProduct,
  createOrder,
  updateProductStock,
  listUserOrders,
  fetchProductById,
  deleteAdminUser,
  EXPECTED_NON_5XX,
} from '../lib/api.js';
import { safeJson } from '../lib/assertions.js';
import { createSummaryHandler } from '../lib/html-report.js';

const USER_PURCHASE_VUS = Number(__ENV.PURCHASE_VUS || 20);
const ADMIN_PATCH_VUS = Number(__ENV.ADMIN_PATCH_VUS || 2);
const INITIAL_STOCK = 50;
const PATCH_STOCK_VALUE = 50;
const UNIT_PRICE = 10.0;

export const purchases201Count = new Counter('f10_lost_update_purchases_201');
export const adminPatches200Count = new Counter('f10_lost_update_admin_patches_200');
export const lostUpdate5xxErrors = new Counter('f10_lost_update_5xx_errors');
export const overwrittenUnitsGauge = new Gauge('f10_lost_update_overwritten_units');

export const options = {
  scenarios: {
    concurrent_user_purchases: {
      executor: 'per-vu-iterations',
      exec: 'userPurchaseUnit',
      vus: USER_PURCHASE_VUS,
      iterations: 2,
      startTime: '0s',
      maxDuration: '30s',
    },
    concurrent_admin_stock_patch: {
      executor: 'per-vu-iterations',
      exec: 'adminOverwriteStock',
      vus: ADMIN_PATCH_VUS,
      iterations: 3,
      startTime: '0s',
      maxDuration: '30s',
    },
  },
  thresholds: {
    f10_lost_update_5xx_errors: ['count == 0'],
    f10_lost_update_purchases_201: ['count > 0'],
    f10_lost_update_admin_patches_200: ['count > 0'],
    f10_lost_update_overwritten_units: ['value == 0'],
  },
};

export function setup() {
  const adminToken = requireAdminToken();

  const product = provisionTestProduct(adminToken, {
    prefix: 'k6_f10_lostupd_prod',
    category: 'laptop',
    manufacturer: 'Dell',
    price: UNIT_PRICE,
    stockQuantity: INITIAL_STOCK,
  });

  const user = provisionTestUser(adminToken, {
    prefix: 'k6_f10_lostupd_user',
    balance: 100000.0,
  });

  return {
    adminToken,
    user,
    product,
  };
}

export function userPurchaseUnit(data) {
  const res = createOrder(data.user.token, data.product.id, 1, {
    responseCallback: EXPECTED_NON_5XX,
  });

  if (res.status >= 500) {
    lostUpdate5xxErrors.add(1);
  } else if (res.status === 201) {
    purchases201Count.add(1);
  }

  check(res, {
    'F-10 lost-update user order: status is 201 or 422': (r) =>
      r.status === 201 || r.status === 422,
  });
}

export function adminOverwriteStock(data) {
  sleep(0.01);
  const res = updateProductStock(data.adminToken, data.product.id, PATCH_STOCK_VALUE, {
    responseCallback: EXPECTED_NON_5XX,
  });

  if (res.status >= 500) {
    lostUpdate5xxErrors.add(1);
  } else if (res.status === 200) {
    adminPatches200Count.add(1);
  }

  check(res, {
    'F-10 lost-update admin PATCH stock: status is 200': (r) => r.status === 200,
  });
}

export default function (data) {
  userPurchaseUnit(data);
}

export function teardown(data) {
  const { adminToken, user, product } = data;

  const finalProduct = fetchProductById(adminToken, product.id);
  const ordersRes = listUserOrders(user.token);
  const ordersBody = safeJson(ordersRes);

  if (finalProduct && ordersBody && Array.isArray(ordersBody.data)) {
    const processedUnits = ordersBody.data
      .filter((o) => o.product_id === product.id && o.status === 'PROCESSED')
      .reduce((sum, o) => sum + o.quantity, 0);

    const expectedWithoutOverwrite = INITIAL_STOCK - processedUnits;
    const overwrittenUnits = finalProduct.stock_quantity - expectedWithoutOverwrite;

    overwrittenUnitsGauge.add(overwrittenUnits);

    check(
      { overwrittenUnits },
      {
        'F-10 Lost-Update Invariant: 0 order decrements overwritten by concurrent PATCH /stock': (
          s
        ) => s.overwrittenUnits === 0,
      }
    );

    console.log(
      `[F-10 Lost-Update Report] InitialStock=${INITIAL_STOCK}, ProcessedOrderUnits=${processedUnits}, FinalStock=${finalProduct.stock_quantity}, OverwrittenDecrementUnits=${overwrittenUnits}`
    );
  }

  deleteAdminUser(adminToken, user.id);
}

export const handleSummary = createSummaryHandler({
  id: '06-f10-stock-lost-update-race',
  title: '06 — F-10: Lost-Update Race on PATCH /api/admin/products/{id}/stock',
  finding: 'NFT.MD • Finding F-10: Absolute Stock Assignment vs. Concurrent Order Decrements',
  description:
    'Admin VUs update stock via PATCH /api/admin/products/{id}/stock (stock_quantity: 50) while User VUs concurrently purchase units via POST /api/user/orders. Measures the lost-update anomaly where absolute stock assignment overwrites concurrent order decrements.',
  vus: USER_PURCHASE_VUS + ADMIN_PATCH_VUS,
});
