#!/usr/bin/env node
import fs from 'node:fs';
import {
  generateScenarioHtml,
  normalizeMetric,
  extractChecksAndGroups,
} from './html-report.js';

const scenarioDefinitions = [
  {
    id: '01-f08-failed-orders-flood-dos',
    title: '01 — F-08: Unbounded FAILED Order Flooding & Pagination DoS',
    shortTitle: '01 • F-08 FAILED Flood DoS',
    finding: 'NFT.MD • Finding F-08: Unbounded FAILED Order Flooding & Pagination DoS',
    description:
      'Stage 1 (Write Flood): 20 VUs rapidly submit invalid orders (422 INSUFFICIENT_FUNDS / INSUFFICIENT_STOCK) generating thousands of FAILED rows at zero balance cost. Stage 2 (Read Degradation): 4 VUs concurrently poll unpaginated GET /api/admin/orders and GET /api/user/orders.',
    vus: 24,
  },
  {
    id: '02-f10-inventory-oversell-race',
    title: '02 — F-10: Inventory Depletion Race (Overselling Check)',
    shortTitle: '02 • F-10 Oversell Race',
    finding: 'NFT.MD • Finding F-10: Inventory Depletion Race (50 VUs vs. Stock of 5)',
    description:
      '50 VUs simultaneously call POST /api/user/orders (quantity: 1) for a product with stock_quantity: 5 and high user balance. Asserts 201 Created == 5, 422 INSUFFICIENT_STOCK == 45, 0 500 errors, final stock_quantity == 0, and balance debited 5 × price.',
    vus: 50,
  },
  {
    id: '03-f10-balance-overdraft-race',
    title: '03 — F-10: Balance Overdraft Race (Double-Spend Check)',
    shortTitle: '03 • F-10 Overdraft Race',
    finding: 'NFT.MD • Finding F-10: Balance Overdraft Race (50 VUs vs. Balance for 3 Items)',
    description:
      '1 User with balance: 300.00 fires 50 simultaneous POST /api/user/orders for a $100.00 product with stock_quantity: 100. Asserts 201 Created == 3, 422 INSUFFICIENT_FUNDS == 47, final balance == 0.00, and stock_quantity == 97.',
    vus: 50,
  },
  {
    id: '04-f10-order-cancellation-race',
    title: '04 — F-10: Concurrent Order Cancellation Race (Double-Refund Check)',
    shortTitle: '04 • F-10 Cancel Race',
    finding: 'NFT.MD • Finding F-10: Concurrent Order Cancellation Race (20 Admin VUs)',
    description:
      '20 Admin VUs simultaneously send PATCH /api/admin/orders/{id}/status ({"status": "CANCELLED"}) for the same PROCESSED order. Asserts 200 OK == 1, 422 INVALID_STATUS == 19, customer balance refunded once, and product stock restored once.',
    vus: 20,
  },
  {
    id: '05-f10-cross-tx-deadlock',
    title: '05 — F-10: Cross-Transaction Deadlock Detection (40P01 / 40001)',
    shortTitle: '05 • F-10 Deadlock Check',
    finding:
      'NFT.MD • Finding F-10: Cross-Transaction Deadlock Detection (Multi-Actor Lock Contention)',
    description:
      'Runs 3 concurrent k6 scenarios targeting the same user_id and product_id simultaneously: Scenario A (20 VUs: POST /api/user/orders), Scenario B (10 VUs: PATCH /api/admin/orders/{id}/status), and Scenario C (10 VUs: POST /api/admin/users/{id}/balance/top-up).',
    vus: 40,
  },
  {
    id: '06-f10-stock-lost-update-race',
    title: '06 — F-10: Lost-Update Race on PATCH /api/admin/products/{id}/stock',
    shortTitle: '06 • F-10 Stock Lost Update',
    finding: 'NFT.MD • Finding F-10: Lost-Update Race on PATCH /api/admin/products/{id}/stock',
    description:
      'Admin VUs update stock via PATCH /api/admin/products/{id}/stock (stock_quantity: 50) while User VUs concurrently purchase units via POST /api/user/orders. Measures the lost-update anomaly where absolute stock assignment overwrites concurrent order decrements.',
    vus: 22,
  },
  {
    id: '07-br01-login-timing-oracle',
    title: '07 — BR-01a: Timing Side-Channel Check (Login Timing Oracle)',
    shortTitle: '07 • BR-01a Timing Oracle',
    finding: 'NFT.MD • Finding BR-01: Timing Oracle Check (Existing vs. Non-Existent Username)',
    description:
      'Compares k6 http_req_waiting (p50/p95) distributions on POST /api/user/login between an existing username (wrong password) and a non-existent username to validate constant-time dummy bcrypt hashing.',
    vus: 6,
  },
  {
    id: '08-br01-bcrypt-cpu-saturation-dos',
    title: '08 — BR-01b: Bcrypt Cost 12 CPU Saturation DoS & Goroutine Starvation',
    shortTitle: '08 • BR-01b Bcrypt DoS',
    finding: 'NFT.MD • Finding BR-01: Bcrypt Cost 12 DoS (50 Concurrent Logins)',
    description:
      '50 concurrent login requests (BcryptCost = 12, ~250-350ms CPU per hash) flood POST /api/user/login to verify whether login CPU saturation starves /api/user/products or /api/user/orders goroutines.',
    vus: 55,
  },
];

const summaries = [];

for (const def of scenarioDefinitions) {
  const jsonPath = `reports/${def.id}.json`;
  if (!fs.existsSync(jsonPath)) continue;
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  const reqs = normalizeMetric('http_reqs', data.metrics?.http_reqs)?.values || {};
  const dur = normalizeMetric('http_req_duration', data.metrics?.http_req_duration)?.values || {};
  const wait = normalizeMetric('http_req_waiting', data.metrics?.http_req_waiting)?.values || {};
  const iters = normalizeMetric('iterations', data.metrics?.iterations)?.values || {};
  const rx = normalizeMetric('data_received', data.metrics?.data_received)?.values || {};
  const { checks } = extractChecksAndGroups(data.root_group);
  const checkPasses = checks.reduce((s, c) => s + c.passes, 0);
  const checkFails = checks.reduce((s, c) => s + c.fails, 0);

  const allMetrics = Object.entries(data.metrics || {})
    .map(([k, v]) => normalizeMetric(k, v))
    .filter(Boolean);
  let threshTotal = 0;
  let threshFailed = 0;
  for (const m of allMetrics) {
    for (const t of m.thresholds) {
      threshTotal++;
      if (!t.ok) threshFailed++;
    }
  }

  const passed = threshFailed === 0 && checkFails === 0;
  const enrichedDef = {
    ...def,
    verdictLabel: passed ? '✓ PASSED' : '✗ FAILED / DETECTED',
    verdictClass: passed ? 'status-pass' : 'status-fail',
  };

  const html = generateScenarioHtml(data, enrichedDef);
  fs.writeFileSync(`reports/${def.id}.html`, html, 'utf8');

  summaries.push({
    ...enrichedDef,
    reqsCount: Number(reqs.count || 0),
    reqsRate: Number(reqs.rate || 0),
    itersCount: Number(iters.count || 0),
    med: Number(dur.med || 0),
    avg: Number(dur.avg || 0),
    p90: Number(dur['p(90)'] || 0),
    p95: Number(dur['p(95)'] || 0),
    p99: Number(dur['p(99)'] || 0),
    max: Number(dur.max || 0),
    waitMed: Number(wait.med || 0),
    rxBytes: Number(rx.count || 0),
    checkPasses,
    checkFails,
    threshTotal,
    threshFailed,
    passed,
  });
}

const totalReqs = summaries.reduce((s, x) => s + x.reqsCount, 0);
const totalChecksPass = summaries.reduce((s, x) => s + x.checkPasses, 0);
const totalChecksFail = summaries.reduce((s, x) => s + x.checkFails, 0);
const totalRxMB = (summaries.reduce((s, x) => s + x.rxBytes, 0) / (1024 * 1024)).toFixed(2);
const passedScenarios = summaries.filter((s) => s.passed).length;
const failedScenarios = summaries.length - passedScenarios;

function buildDashboardHtml(linkPrefix = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Warehouse REST API — Grafana k6 v2.3.0 Concurrency &amp; Stress Test Report (NFT.MD)</title>
  <style>
    :root {
      --bg: #0f172a;
      --surface: #1e293b;
      --surface-alt: #273549;
      --border: #334155;
      --fg: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --success: #22c55e;
      --success-soft: rgba(34, 197, 94, 0.15);
      --danger: #ef4444;
      --danger-soft: rgba(239, 68, 68, 0.16);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 28px 24px 60px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.5;
    }
    .container { max-width: 1340px; margin: 0 auto; }
    .hero {
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 28px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 20px;
    }
    .hero h1 { margin: 0 0 6px; font-size: 26px; }
    .hero p { margin: 0; color: var(--muted); font-size: 14px; }
    .hero-meta { display: flex; gap: 12px; flex-wrap: wrap; }
    .meta-chip {
      background: var(--surface-alt);
      border: 1px solid var(--border);
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 13px;
      color: var(--fg);
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .kpi-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px;
    }
    .kpi-label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .kpi-value { font-size: 26px; font-weight: 700; }
    .kpi-sub { font-size: 12.5px; color: var(--muted); margin-top: 4px; }
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 22px;
      margin-bottom: 24px;
    }
    .panel h2 {
      margin: 0 0 16px;
      font-size: 18px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 10px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    th, td {
      text-align: left;
      padding: 11px 12px;
      border-bottom: 1px solid var(--border);
      font-variant-numeric: tabular-nums;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      background: rgba(15, 23, 42, 0.45);
    }
    tr:hover td { background: rgba(56, 189, 248, 0.04); }
    a.report-link { color: var(--accent); text-decoration: none; font-weight: 600; }
    a.report-link:hover { text-decoration: underline; }
    .status-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-weight: 700;
      font-size: 11.5px;
      white-space: nowrap;
    }
    .status-pass { background: var(--success-soft); color: var(--success); border: 1px solid rgba(34, 197, 94, 0.35); }
    .status-fail { background: var(--danger-soft); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.35); }
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(390px, 1fr));
      gap: 18px;
    }
    .scen-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .scen-card-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 10px;
    }
    .scen-card h3 { margin: 0; font-size: 16px; }
    .scen-finding { color: var(--accent); font-size: 12px; font-weight: 600; margin-bottom: 8px; }
    .scen-desc { font-size: 13.5px; color: #cbd5e1; margin-bottom: 14px; }
    .scen-metrics-mini {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      background: rgba(15, 23, 42, 0.5);
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 12px;
      margin-bottom: 14px;
    }
    .scen-metrics-mini div span { display: block; color: var(--muted); font-size: 11px; }
    .scen-metrics-mini div strong { font-size: 13.5px; }
    .btn-open {
      display: inline-block;
      text-align: center;
      background: rgba(56, 189, 248, 0.14);
      color: var(--accent);
      border: 1px solid rgba(56, 189, 248, 0.35);
      padding: 8px 14px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
      font-size: 13px;
    }
    .btn-open:hover { background: rgba(56, 189, 248, 0.24); }
  </style>
</head>
<body>
  <div class="container">
    <div class="hero">
      <div>
        <h1>Warehouse REST API — Concurrency, Race Conditions &amp; Stress Suite (NFT.MD)</h1>
        <p>Automated Grafana k6 v2.3.0 audit covering F-08 (FAILED Order Flood &amp; Pagination DoS), F-10 (Oversell, Overdraft, Double-Refund, Deadlock 40P01, Lost-Update), and BR-01 (Timing Oracle &amp; Bcrypt Saturation)</p>
      </div>
      <div class="hero-meta">
        <div class="meta-chip"><strong>k6:</strong> v2.3.0 (linux/amd64)</div>
        <div class="meta-chip"><strong>Target:</strong> http://localhost:8080</div>
        <div class="meta-chip"><strong>Cleanup:</strong> k6/x/sql (PostgreSQL)</div>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">NFT.MD Scenarios</div>
        <div class="kpi-value">${summaries.length}</div>
        <div class="kpi-sub">${passedScenarios} PASS • ${failedScenarios} FAIL/DETECTED</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Total HTTP Requests</div>
        <div class="kpi-value">${totalReqs.toLocaleString('en-US')}</div>
        <div class="kpi-sub">Across all concurrency &amp; stress workloads</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Checks Pass Rate</div>
        <div class="kpi-value">${
          totalChecksPass + totalChecksFail > 0
            ? ((totalChecksPass / (totalChecksPass + totalChecksFail)) * 100).toFixed(2)
            : '100.00'
        }%</div>
        <div class="kpi-sub">✓ ${totalChecksPass.toLocaleString('en-US')} / ✗ ${totalChecksFail}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Total Network RX</div>
        <div class="kpi-value">${totalRxMB} MB</div>
        <div class="kpi-sub">Driven by unpaginated GET /orders in F-08</div>
      </div>
    </div>

    <div class="panel">
      <h2>Executive Summary Matrix (All ${summaries.length} NFT.MD Test Scenarios)</h2>
      <table>
        <thead>
          <tr>
            <th>Scenario (HTML Report)</th>
            <th>Peak VUs</th>
            <th>HTTP Reqs</th>
            <th>RPS</th>
            <th>med (ms)</th>
            <th>p(90) (ms)</th>
            <th>p(95) (ms)</th>
            <th>p(99) (ms)</th>
            <th>max (ms)</th>
            <th>Checks (✓ / ✗)</th>
            <th>Thresholds</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          ${summaries
            .map(
              (s) => `<tr>
                <td><a class="report-link" href="${linkPrefix}${s.id}.html">${s.shortTitle}</a></td>
                <td>${s.vus}</td>
                <td>${s.reqsCount}</td>
                <td>${s.reqsRate.toFixed(2)}/s</td>
                <td><strong>${s.med.toFixed(2)}</strong></td>
                <td>${s.p90.toFixed(2)}</td>
                <td><strong>${s.p95.toFixed(2)}</strong></td>
                <td>${s.p99.toFixed(2)}</td>
                <td>${s.max.toFixed(2)}</td>
                <td>✓ ${s.checkPasses} / ✗ ${s.checkFails}</td>
                <td>${s.threshTotal - s.threshFailed}/${s.threshTotal}</td>
                <td><span class="status-badge ${s.verdictClass}">${s.verdictLabel}</span></td>
              </tr>`
            )
            .join('\n')}
        </tbody>
      </table>
    </div>

    <h2 style="margin: 28px 0 16px; font-size: 20px;">Scenario Breakdown</h2>
    <div class="cards-grid">
      ${summaries
        .map(
          (s) => `<div class="scen-card">
            <div>
              <div class="scen-card-top">
                <h3>${s.title}</h3>
                <span class="status-badge ${s.verdictClass}">${s.verdictLabel}</span>
              </div>
              <div class="scen-finding">${s.finding}</div>
              <div class="scen-desc">${s.description}</div>
            </div>
            <div>
              <div class="scen-metrics-mini">
                <div><span>Requests</span><strong>${s.reqsCount} (${s.reqsRate.toFixed(1)}/s)</strong></div>
                <div><span>Median (p50)</span><strong>${s.med.toFixed(2)} ms</strong></div>
                <div><span>p(95) / p(99)</span><strong>${s.p95.toFixed(1)} / ${s.p99.toFixed(1)} ms</strong></div>
                <div><span>Checks</span><strong>✓ ${s.checkPasses} / ✗ ${s.checkFails}</strong></div>
              </div>
              <a class="btn-open" href="${linkPrefix}${s.id}.html">Open Full Scenario HTML Report →</a>
            </div>
          </div>`
        )
        .join('\n')}
    </div>
  </div>
</body>
</html>`;
}

fs.writeFileSync('reports/index.html', buildDashboardHtml(''), 'utf8');
fs.writeFileSync('report.html', buildDashboardHtml('reports/'), 'utf8');
console.log(
  `[Dashboard] Updated master HTML dashboards: ./report.html and ./reports/index.html (${passedScenarios} passed, ${failedScenarios} failed)`
);
