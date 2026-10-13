/**
 * Self-contained HTML Report & Console Summary Generator for Grafana k6 v2.3.0
 *
 * Works both inside the k6 `handleSummary(data)` lifecycle hook and
 * with `--summary-export` JSON payloads.
 */

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtNum(val, decimals = 2) {
  if (val === undefined || val === null || Number.isNaN(Number(val))) return '—';
  const n = Number(val);
  if (Number.isInteger(n) && decimals === 0) return String(n);
  return n.toFixed(decimals);
}

function fmtBytes(bytes) {
  if (bytes === undefined || bytes === null || Number.isNaN(Number(bytes))) return '—';
  const b = Number(bytes);
  if (b < 1024) return `${b.toFixed(0)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(2)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Normalizes a k6 metric entry from either `handleSummary(data)` or `--summary-export` JSON.
 */
export function normalizeMetric(name, raw) {
  if (!raw) return null;
  const values = raw.values ? raw.values : raw;
  const thresholds = [];

  if (raw.thresholds && typeof raw.thresholds === 'object') {
    for (const [expr, tVal] of Object.entries(raw.thresholds)) {
      // In handleSummary(data), tVal is { ok: boolean }.
      // In --summary-export JSON, tVal is boolean (false = passed, true = failed).
      const ok = typeof tVal === 'object' && tVal !== null ? Boolean(tVal.ok) : !Boolean(tVal);
      thresholds.push({ expr, ok });
    }
  }

  let type = raw.type;
  if (!type) {
    if (values.med !== undefined || values['p(95)'] !== undefined) type = 'trend';
    else if (values.passes !== undefined && values.fails !== undefined) type = 'rate';
    else if (values.count !== undefined && values.rate !== undefined) type = 'counter';
    else type = 'gauge';
  }

  return { name, type, contains: raw.contains || 'default', values, thresholds };
}

/**
 * Recursively extracts all checks and groups from `root_group`.
 */
export function extractChecksAndGroups(groupObj, parentPath = '') {
  if (!groupObj) return { checks: [], groups: [] };

  const checks = [];
  const rawChecks = groupObj.checks || {};
  const checkList = Array.isArray(rawChecks) ? rawChecks : Object.values(rawChecks);

  for (const c of checkList) {
    checks.push({
      name: c.name || '',
      group: parentPath || 'root',
      passes: Number(c.passes || 0),
      fails: Number(c.fails || 0),
    });
  }

  const groups = [];
  const rawGroups = groupObj.groups || {};
  const groupList = Array.isArray(rawGroups) ? rawGroups : Object.values(rawGroups);

  for (const g of groupList) {
    const gName = g.name || 'Group';
    const fullPath = parentPath ? `${parentPath} › ${gName}` : gName;
    const nested = extractChecksAndGroups(g, fullPath);
    groups.push({ name: fullPath, checks: nested.checks });
    checks.push(...nested.checks);
    groups.push(...nested.groups);
  }

  return { checks, groups };
}

/**
 * Generates a standalone, rich HTML report for a single k6 test run.
 */
export function generateScenarioHtml(data, meta = {}) {
  const rawMetrics = data.metrics || {};
  const metrics = Object.entries(rawMetrics)
    .map(([k, v]) => normalizeMetric(k, v))
    .filter(Boolean);

  const allThresholds = [];
  for (const m of metrics) {
    for (const t of m.thresholds) {
      allThresholds.push({ metric: m.name, expr: t.expr, ok: t.ok });
    }
  }

  const { checks } = extractChecksAndGroups(data.root_group);
  const totalCheckPasses = checks.reduce((s, c) => s + c.passes, 0);
  const totalCheckFails = checks.reduce((s, c) => s + c.fails, 0);
  const totalChecks = totalCheckPasses + totalCheckFails;
  const checkPassRate = totalChecks > 0 ? (totalCheckPasses / totalChecks) * 100 : 100;

  const failedThresholds = allThresholds.filter((t) => !t.ok).length;
  const overallPassed = failedThresholds === 0 && totalCheckFails === 0;

  const httpReqs = normalizeMetric('http_reqs', rawMetrics.http_reqs)?.values || {};
  const httpDuration =
    normalizeMetric('http_req_duration', rawMetrics.http_req_duration)?.values || {};
  const httpWaiting =
    normalizeMetric('http_req_waiting', rawMetrics.http_req_waiting)?.values || {};
  const iterations = normalizeMetric('iterations', rawMetrics.iterations)?.values || {};
  const vusMax = normalizeMetric('vus_max', rawMetrics.vus_max)?.values || {};
  const peakVus = vusMax.max ?? vusMax.value ?? meta.vus ?? iterations.count ?? '—';
  const dataRx = normalizeMetric('data_received', rawMetrics.data_received)?.values || {};
  const dataTx = normalizeMetric('data_sent', rawMetrics.data_sent)?.values || {};

  const builtinNames = new Set([
    'http_reqs',
    'http_req_duration',
    'http_req_waiting',
    'http_req_connecting',
    'http_req_tls_handshaking',
    'http_req_sending',
    'http_req_receiving',
    'http_req_blocked',
    'http_req_failed',
    'iterations',
    'iteration_duration',
    'vus',
    'vus_max',
    'data_received',
    'data_sent',
    'checks',
    'group_duration',
  ]);

  const customMetrics = metrics.filter((m) => !builtinNames.has(m.name.split('{')[0]));
  const trendMetrics = metrics.filter((m) => m.type === 'trend');

  const maxLatencyVal = Math.max(
    Number(httpDuration.max || 1),
    Number(httpDuration['p(99)'] || 1),
    1
  );

  const pctBars = [
    { label: 'min', val: httpDuration.min },
    { label: 'med (p50)', val: httpDuration.med },
    { label: 'avg', val: httpDuration.avg },
    { label: 'p(90)', val: httpDuration['p(90)'] },
    { label: 'p(95)', val: httpDuration['p(95)'] },
    { label: 'p(99)', val: httpDuration['p(99)'] },
    { label: 'max', val: httpDuration.max },
  ];

  const title = meta.title || meta.id || 'k6 Scenario Report';
  const subtitle =
    meta.finding || 'Warehouse REST API — Concurrency, Race Conditions & Stress Suite (k6 v2.3.0)';
  const description = meta.description || '';
  const analysisHtml = meta.analysisHtml || '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} — k6 v2.3.0 Report</title>
  <style>
    :root {
      --bg: #0f172a;
      --surface: #1e293b;
      --surface-alt: #273549;
      --border: #334155;
      --fg: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-soft: rgba(56, 189, 248, 0.14);
      --success: #22c55e;
      --success-soft: rgba(34, 197, 94, 0.15);
      --danger: #ef4444;
      --danger-soft: rgba(239, 68, 68, 0.16);
      --warning: #f59e0b;
      --warning-soft: rgba(245, 158, 11, 0.16);
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
    .container { max-width: 1280px; margin: 0 auto; }
    .top-nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      font-size: 14px;
    }
    .top-nav a {
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
    }
    .top-nav a:hover { text-decoration: underline; }
    .header-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 20px;
      flex-wrap: wrap;
    }
    .header-title h1 {
      margin: 0 0 6px;
      font-size: 24px;
      font-weight: 700;
    }
    .header-subtitle {
      color: var(--accent);
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .header-desc {
      color: var(--muted);
      font-size: 14px;
      max-width: 820px;
      margin: 0;
    }
    .status-badge {
      padding: 8px 16px;
      border-radius: 999px;
      font-weight: 700;
      font-size: 14px;
      letter-spacing: 0.4px;
      white-space: nowrap;
    }
    .status-pass {
      background: var(--success-soft);
      color: var(--success);
      border: 1px solid rgba(34, 197, 94, 0.4);
    }
    .status-fail {
      background: var(--danger-soft);
      color: var(--danger);
      border: 1px solid rgba(239, 68, 68, 0.4);
    }
    .status-warn {
      background: var(--warning-soft);
      color: var(--warning);
      border: 1px solid rgba(245, 158, 11, 0.4);
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(185px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .kpi-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 18px;
    }
    .kpi-label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .kpi-value {
      font-size: 24px;
      font-weight: 700;
      color: var(--fg);
    }
    .kpi-sub {
      font-size: 12px;
      color: var(--muted);
      margin-top: 4px;
    }
    .section-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 24px;
    }
    @media (max-width: 960px) {
      .section-grid { grid-template-columns: 1fr; }
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .panel h2 {
      margin: 0 0 16px;
      font-size: 17px;
      font-weight: 600;
      border-bottom: 1px solid var(--border);
      padding-bottom: 10px;
    }
    .bar-row {
      display: grid;
      grid-template-columns: 95px 1fr 90px;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
      font-size: 13px;
    }
    .bar-track {
      height: 12px;
      background: var(--surface-alt);
      border-radius: 6px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #38bdf8, #818cf8);
      border-radius: 6px;
    }
    .bar-val {
      text-align: right;
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13.5px;
    }
    th, td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      font-variant-numeric: tabular-nums;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      background: rgba(15, 23, 42, 0.4);
    }
    tr:last-child td { border-bottom: none; }
    .pill {
      display: inline-block;
      padding: 2px 9px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
    }
    .pill-ok { background: var(--success-soft); color: var(--success); }
    .pill-fail { background: var(--danger-soft); color: var(--danger); }
    .analysis-box {
      background: rgba(56, 189, 248, 0.08);
      border-left: 4px solid var(--accent);
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 24px;
      font-size: 14px;
    }
    .analysis-box h3 {
      margin: 0 0 8px;
      font-size: 16px;
      color: var(--accent);
    }
    code {
      background: rgba(15, 23, 42, 0.65);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12.5px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="top-nav">
      <a href="index.html">← Back to Master Suite Dashboard (k6 v2.3.0)</a>
      <span style="color: var(--muted);">Grafana k6 v2.3.0 • Warehouse REST API Testbench</span>
    </div>

    <div class="header-card">
      <div class="header-title">
        <div class="header-subtitle">${escapeHtml(subtitle)}</div>
        <h1>${escapeHtml(title)}</h1>
        ${description ? `<p class="header-desc">${escapeHtml(description)}</p>` : ''}
      </div>
      <div class="status-badge ${
        meta.verdictClass || (overallPassed ? 'status-pass' : 'status-fail')
      }">
        ${escapeHtml(meta.verdictLabel || (overallPassed ? '✓ PASSED' : '✗ FAILED / DETECTED'))}
      </div>
    </div>

    ${
      analysisHtml
        ? `<div class="analysis-box"><h3>Audit Analysis & Findings</h3>${analysisHtml}</div>`
        : ''
    }

    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">HTTP Requests</div>
        <div class="kpi-value">${fmtNum(httpReqs.count, 0)}</div>
        <div class="kpi-sub">${fmtNum(httpReqs.rate, 2)} req/s</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Iterations / Peak VUs</div>
        <div class="kpi-value">${fmtNum(iterations.count, 0)} <span style="font-size:15px;color:var(--muted)">/ ${fmtNum(peakVus, 0)} VUs</span></div>
        <div class="kpi-sub">${fmtNum(iterations.rate, 2)} iter/s</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Latency p(95) / p(99)</div>
        <div class="kpi-value">${fmtNum(httpDuration['p(95)'], 2)} ms</div>
        <div class="kpi-sub">p(99): ${fmtNum(httpDuration['p(99)'], 2)} ms • med: ${fmtNum(httpDuration.med, 2)} ms</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">TTFB (Waiting) med / p(95)</div>
        <div class="kpi-value">${fmtNum(httpWaiting.med, 2)} ms</div>
        <div class="kpi-sub">p(95): ${fmtNum(httpWaiting['p(95)'], 2)} ms • max: ${fmtNum(httpWaiting.max, 2)} ms</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Checks Pass Rate</div>
        <div class="kpi-value">${fmtNum(checkPassRate, 2)}%</div>
        <div class="kpi-sub">✓ ${totalCheckPasses} / ✗ ${totalCheckFails}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Network I/O (RX / TX)</div>
        <div class="kpi-value">${fmtBytes(dataRx.count)}</div>
        <div class="kpi-sub">TX: ${fmtBytes(dataTx.count)}</div>
      </div>
    </div>

    <div class="section-grid">
      <div class="panel" style="margin-bottom:0;">
        <h2>HTTP Response Time Distribution (http_req_duration)</h2>
        ${pctBars
          .map((b) => {
            const v = Number(b.val || 0);
            const pct = Math.min(100, Math.max(2, (v / maxLatencyVal) * 100));
            return `<div class="bar-row">
              <div style="color:var(--muted)">${escapeHtml(b.label)}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
              <div class="bar-val">${fmtNum(v, 2)} ms</div>
            </div>`;
          })
          .join('\n')}
      </div>

      <div class="panel" style="margin-bottom:0;">
        <h2>Thresholds (${allThresholds.length - failedThresholds}/${allThresholds.length} Passed)</h2>
        ${
          allThresholds.length === 0
            ? '<p style="color:var(--muted)">No thresholds configured</p>'
            : `<table>
                <thead>
                  <tr><th>Metric</th><th>Threshold Expression</th><th>Status</th></tr>
                </thead>
                <tbody>
                  ${allThresholds
                    .map(
                      (t) => `<tr>
                        <td><code>${escapeHtml(t.metric)}</code></td>
                        <td><code>${escapeHtml(t.expr)}</code></td>
                        <td><span class="pill ${t.ok ? 'pill-ok' : 'pill-fail'}">${
                          t.ok ? '✓ PASS' : '✗ FAIL'
                        }</span></td>
                      </tr>`
                    )
                    .join('\n')}
                </tbody>
              </table>`
        }
      </div>
    </div>

    <div class="panel">
      <h2>Custom Scenario Metrics</h2>
      ${
        customMetrics.length === 0
          ? '<p style="color:var(--muted)">No custom metrics recorded</p>'
          : `<table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Type</th>
                  <th>Value / Count</th>
                  <th>min</th>
                  <th>med (p50)</th>
                  <th>avg</th>
                  <th>p(90)</th>
                  <th>p(95)</th>
                  <th>p(99)</th>
                  <th>max</th>
                </tr>
              </thead>
              <tbody>
                ${customMetrics
                  .map((m) => {
                    const v = m.values;
                    let mainVal = '—';
                    if (m.type === 'counter') mainVal = `${fmtNum(v.count, 0)} (${fmtNum(v.rate, 2)}/s)`;
                    else if (m.type === 'rate')
                      mainVal = `${fmtNum((v.value ?? 0) * 100, 2)}% (✓ ${v.passes ?? 0} / ✗ ${v.fails ?? 0})`;
                    else if (m.type === 'gauge') mainVal = `${fmtNum(v.value, 0)}`;
                    return `<tr>
                      <td><code>${escapeHtml(m.name)}</code></td>
                      <td>${escapeHtml(m.type)}</td>
                      <td><strong>${escapeHtml(mainVal)}</strong></td>
                      <td>${v.min !== undefined && m.type === 'trend' ? fmtNum(v.min, 2) : '—'}</td>
                      <td>${v.med !== undefined ? fmtNum(v.med, 2) : '—'}</td>
                      <td>${v.avg !== undefined ? fmtNum(v.avg, 2) : '—'}</td>
                      <td>${v['p(90)'] !== undefined ? fmtNum(v['p(90)'], 2) : '—'}</td>
                      <td>${v['p(95)'] !== undefined ? fmtNum(v['p(95)'], 2) : '—'}</td>
                      <td>${v['p(99)'] !== undefined ? fmtNum(v['p(99)'], 2) : '—'}</td>
                      <td>${v.max !== undefined && m.type === 'trend' ? fmtNum(v.max, 2) : '—'}</td>
                    </tr>`;
                  })
                  .join('\n')}
              </tbody>
            </table>`
      }
    </div>

    <div class="panel">
      <h2>All Timing & Latency Metrics (Trends Breakdown)</h2>
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th>min (ms)</th>
            <th>med / p50 (ms)</th>
            <th>avg (ms)</th>
            <th>p(90) (ms)</th>
            <th>p(95) (ms)</th>
            <th>p(99) (ms)</th>
            <th>max (ms)</th>
          </tr>
        </thead>
        <tbody>
          ${trendMetrics
            .map((m) => {
              const v = m.values;
              return `<tr>
                <td><code>${escapeHtml(m.name)}</code></td>
                <td>${fmtNum(v.min, 3)}</td>
                <td><strong>${fmtNum(v.med, 3)}</strong></td>
                <td>${fmtNum(v.avg, 3)}</td>
                <td>${fmtNum(v['p(90)'], 3)}</td>
                <td><strong>${fmtNum(v['p(95)'], 3)}</strong></td>
                <td>${fmtNum(v['p(99)'], 3)}</td>
                <td>${fmtNum(v.max, 3)}</td>
              </tr>`;
            })
            .join('\n')}
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h2>Checks Breakdown (${totalCheckPasses} Passed / ${totalCheckFails} Failed)</h2>
      <table>
        <thead>
          <tr>
            <th>Group</th>
            <th>Check Name</th>
            <th>Passes</th>
            <th>Fails</th>
            <th>Pass Rate</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${checks
            .map((c) => {
              const tot = c.passes + c.fails;
              const rate = tot > 0 ? (c.passes / tot) * 100 : 100;
              const ok = c.fails === 0;
              return `<tr>
                <td style="color:var(--muted)">${escapeHtml(c.group)}</td>
                <td>${escapeHtml(c.name)}</td>
                <td>${c.passes}</td>
                <td>${c.fails}</td>
                <td>${fmtNum(rate, 1)}%</td>
                <td><span class="pill ${ok ? 'pill-ok' : 'pill-fail'}">${ok ? '✓ PASS' : '✗ FAIL'}</span></td>
              </tr>`;
            })
            .join('\n')}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Creates a k6 `handleSummary(data)` function that writes both HTML and JSON reports
 * to `reports/<id>.html` and `reports/<id>.json` while printing a concise console summary.
 */
export function createSummaryHandler(meta = {}) {
  const id = meta.id || 'k6-report';
  return function handleSummary(data) {
    const envHtml = typeof __ENV !== 'undefined' ? __ENV.REPORT_HTML : undefined;
    const envJson = typeof __ENV !== 'undefined' ? __ENV.REPORT_JSON : undefined;
    const htmlPath = envHtml || meta.outputHtml || `reports/${id}.html`;
    const jsonPath = envJson || meta.outputJson || `reports/${id}.json`;
    const html = generateScenarioHtml(data, meta);
    const reqs = normalizeMetric('http_reqs', data.metrics?.http_reqs)?.values || {};
    const dur = normalizeMetric('http_req_duration', data.metrics?.http_req_duration)?.values || {};
    const summaryLine = `\n[k6 HTML Report] Saved -> ${htmlPath} & ${jsonPath} | reqs=${
      reqs.count ?? 0
    } (${fmtNum(reqs.rate, 2)}/s) | p95=${fmtNum(dur['p(95)'], 2)}ms | p99=${fmtNum(
      dur['p(99)'],
      2
    )}ms\n`;
    return {
      stdout: summaryLine,
      [htmlPath]: html,
      [jsonPath]: JSON.stringify(data, null, 2),
    };
  };
}
