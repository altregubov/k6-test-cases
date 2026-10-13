import sql from 'k6/x/sql';
import driver from 'k6/x/sql/driver/postgres';

export const DATABASE_URL =
  __ENV.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/warehouse_db?sslmode=disable';

/**
 * Opens a PostgreSQL connection in the init context via official k6 v2.3.0 extensions:
 *   - github.com/grafana/xk6-sql (`k6/x/sql`)
 *   - github.com/grafana/xk6-sql-driver-postgres (`k6/x/sql/driver/postgres`)
 * k6 v2.3.0 automatically provisions and caches the binary on first run.
 */
const db = sql.open(driver, DATABASE_URL);

/**
 * Physically removes test orders, products, and users from PostgreSQL inside `teardown()`.
 *
 * Respects foreign key constraints (`orders.user_id` and `orders.product_id` ON DELETE RESTRICT)
 * by deleting dependent `orders` first, then `products`, then `users`.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.userIds] - Specific user UUIDs to physically remove
 * @param {string[]} [opts.productIds] - Specific product UUIDs to physically remove
 * @param {boolean} [opts.purgeByK6Prefix] - Also purge any `k6_%` / `ghost_%` records
 */
export function purgeTestDataFromDb({
  userIds = [],
  productIds = [],
  purgeByK6Prefix = true,
} = {}) {
  for (const uid of userIds) {
    if (uid) {
      db.exec('DELETE FROM orders WHERE user_id = $1;', uid);
    }
  }
  for (const pid of productIds) {
    if (pid) {
      db.exec('DELETE FROM orders WHERE product_id = $1;', pid);
      db.exec('DELETE FROM products WHERE id = $1;', pid);
    }
  }
  for (const uid of userIds) {
    if (uid) {
      db.exec('DELETE FROM users WHERE id = $1;', uid);
    }
  }

  if (purgeByK6Prefix) {
    db.exec(
      "DELETE FROM orders WHERE product_model LIKE 'k6_%' OR user_id IN (SELECT id FROM users WHERE username LIKE 'k6_%' OR username LIKE 'ghost_%');"
    );
    db.exec("DELETE FROM products WHERE model LIKE 'k6_%';");
    db.exec("DELETE FROM users WHERE username LIKE 'k6_%' OR username LIKE 'ghost_%';");
  }
}
