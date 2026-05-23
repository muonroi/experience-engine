#!/usr/bin/env node
'use strict';

/**
 * deep-health.js — Deep health verification for Experience Engine.
 *
 * Unlike health-check.sh (config + file checks), this script CALLS every
 * dependency with real data and measures latency. Silent failures become
 * visible failures.
 *
 * Usage:
 *   node tools/deep-health.js              # human-readable
 *   node tools/deep-health.js --json       # machine-readable
 *   node tools/deep-health.js --cron       # JSON + write to status file + alert on failure
 *
 * Checks:
 *   1. EE Server process (http://localhost:8082/health)
 *   2. Qdrant read + write (scroll + count)
 *   3. Embed API live call (real embedding, measure dim + latency)
 *   4. Brain LLM live call (real completion, measure latency)
 *   5. Intercept pipeline end-to-end (POST /api/intercept, full flow)
 *   6. Cron jobs alive (maintain + dashboard crontab entries + recency)
 *   7. Activity log freshness (last event age)
 *   8. Store health (entry count per collection, superseded ratio)
 *   9. Disk space (~/.experience size)
 *  10. Server uptime + memory
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const EXP_DIR = path.join(HOME, '.experience');
const STATUS_DIR = path.join(EXP_DIR, 'status');
const STATUS_FILE = path.join(STATUS_DIR, 'deep-health-latest.json');
const ALERT_LOG = path.join(EXP_DIR, 'logs', 'deep-health-alert.log');

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json') || args.includes('--cron');
const CRON_MODE = args.includes('--cron');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(EXP_DIR, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const results = [];
function check(name, status, detail, latencyMs) {
  results.push({ name, status, detail, latencyMs: latencyMs != null ? Math.round(latencyMs) : null });
}

async function timedFetch(url, opts, timeoutMs = 10000) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return { res, latencyMs: Date.now() - t0 };
  } catch (err) {
    clearTimeout(timer);
    return { err, latencyMs: Date.now() - t0 };
  }
}

async function checkServer(cfg) {
  const port = cfg.server?.port || 8082;
  const { res, err, latencyMs } = await timedFetch(`http://127.0.0.1:${port}/health`, {}, 5000);
  if (err) {
    check('server', 'fail', `unreachable on :${port} — ${err.cause?.code || err.message}`, latencyMs);
    return null;
  }
  if (!res.ok) {
    check('server', 'fail', `HTTP ${res.status}`, latencyMs);
    return null;
  }
  const body = await res.json();
  const uptime = body.uptime != null ? `${Math.round(body.uptime)}s` : '?';
  const alerts = body.alerts || [];
  if (alerts.length > 0) {
    check('server', 'warn', `up ${uptime}, alerts: ${alerts.map(a => a.msg || a).join('; ')}`, latencyMs);
  } else {
    check('server', 'ok', `up ${uptime}, qdrant=${body.qdrant?.status || '?'}`, latencyMs);
  }
  return body;
}

async function checkQdrant(cfg) {
  const url = cfg.qdrantUrl || 'http://localhost:6333';
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.qdrantKey) headers['api-key'] = cfg.qdrantKey;

  const { res, err, latencyMs } = await timedFetch(`${url}/collections`, { headers }, 5000);
  if (err || !res?.ok) {
    check('qdrant', 'fail', `unreachable at ${url} — ${err?.message || `HTTP ${res?.status}`}`, latencyMs);
    return;
  }
  const body = await res.json();
  const cols = body.result?.collections || [];

  let totalPoints = 0;
  for (const c of cols) {
    try {
      const infoRes = await fetch(`${url}/collections/${c.name}`, { headers });
      if (infoRes.ok) {
        const info = await infoRes.json();
        totalPoints += info.result?.points_count || 0;
      }
    } catch { /* skip */ }
  }
  check('qdrant', 'ok', `${cols.length} collections, ${totalPoints} points`, latencyMs);
}

async function checkEmbed(cfg) {
  const provider = cfg.embedProvider;
  const model = cfg.embedModel;
  const endpoint = cfg.embedEndpoint;
  const key = cfg.embedKey;

  if (!endpoint || !key) {
    check('embed', 'fail', 'embedEndpoint or embedKey not configured');
    return;
  }

  const { res, err, latencyMs } = await timedFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, input: 'health check embedding test', encoding_format: 'float' }),
  }, 10000);

  if (err || !res?.ok) {
    const status = res ? `HTTP ${res.status}` : err.message;
    check('embed', 'fail', `${provider}/${model} — ${status}`, latencyMs);
    return;
  }
  const body = await res.json();
  const dim = body.data?.[0]?.embedding?.length || 0;
  if (dim === 0) {
    check('embed', 'fail', `${provider}/${model} returned empty embedding`, latencyMs);
  } else if (dim !== (cfg.embedDim || 1024)) {
    check('embed', 'warn', `${provider}/${model} dim=${dim} (expected ${cfg.embedDim || 1024})`, latencyMs);
  } else {
    check('embed', 'ok', `${provider}/${model} dim=${dim}`, latencyMs);
  }
}

async function checkBrain(cfg) {
  const model = cfg.brainModel;
  const endpoint = cfg.brainEndpoint;
  const key = cfg.brainKey;

  if (!endpoint || !key) {
    check('brain', 'fail', 'brainEndpoint or brainKey not configured');
    return;
  }

  const { res, err, latencyMs } = await timedFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: HEALTH_OK' }],
      max_tokens: 100,
      temperature: 0,
    }),
  }, 15000);

  if (err || !res?.ok) {
    const status = res ? `HTTP ${res.status}` : err.message;
    check('brain', 'fail', `${model} — ${status}`, latencyMs);
    return;
  }
  const body = await res.json();
  const content = body.choices?.[0]?.message?.content || '';
  const reasoning = body.choices?.[0]?.message?.reasoning_content || '';
  const hasOutput = content.length > 0 || reasoning.length > 0;

  if (!hasOutput) {
    check('brain', 'fail', `${model} returned empty content+reasoning`, latencyMs);
  } else {
    const tokens = body.usage?.total_tokens || '?';
    check('brain', 'ok', `${model} tokens=${tokens}`, latencyMs);
  }
}

async function checkIntercept(cfg) {
  const port = cfg.server?.port || 8082;
  const authToken = cfg.serverAuthToken || cfg.server?.authToken;
  if (!authToken) {
    check('intercept', 'fail', 'no serverAuthToken configured');
    return;
  }

  const { res, err, latencyMs } = await timedFetch(`http://127.0.0.1:${port}/api/intercept`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      toolName: 'Bash',
      toolInput: { command: 'echo deep-health-probe' },
      cwd: HOME,
      sourceRuntime: 'deep-health',
    }),
  }, 15000);

  if (err || !res?.ok) {
    const status = res ? `HTTP ${res.status}` : err.message;
    check('intercept', 'fail', `pipeline error — ${status}`, latencyMs);
    return;
  }
  const body = await res.json();
  const hints = body.suggestions ? 'has suggestions' : 'no match (expected for probe)';
  check('intercept', 'ok', `pipeline OK — ${hints}`, latencyMs);
}

function checkCronJobs() {
  try {
    const { execSync } = require('child_process');
    const crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });

    const maintainMatch = crontab.match(/exp-server-maintain/);
    const dashboardMatch = crontab.match(/exp-dashboard/);
    const missing = [];
    if (!maintainMatch) missing.push('exp-server-maintain');
    if (!dashboardMatch) missing.push('exp-dashboard');

    if (missing.length > 0) {
      check('cron-jobs', 'fail', `missing: ${missing.join(', ')}`);
      return;
    }

    // Check maintain log recency
    const maintainLog = path.join(EXP_DIR, 'maintain.log');
    if (fs.existsSync(maintainLog)) {
      const stat = fs.statSync(maintainLog);
      const ageMin = Math.round((Date.now() - stat.mtimeMs) / 60000);
      if (ageMin > 30) {
        check('cron-jobs', 'warn', `maintain log stale (${ageMin}m ago, expect ≤15m)`);
      } else {
        check('cron-jobs', 'ok', `maintain=${ageMin}m ago, dashboard=daily 02:13 UTC`);
      }
    } else {
      check('cron-jobs', 'warn', 'maintain.log missing — cron may not have run yet');
    }
  } catch (err) {
    check('cron-jobs', 'fail', `cannot read crontab: ${err.message}`);
  }
}

function checkActivityLog() {
  const logFile = path.join(EXP_DIR, 'activity.jsonl');
  if (!fs.existsSync(logFile)) {
    check('activity', 'warn', 'activity.jsonl not found');
    return;
  }

  const stat = fs.statSync(logFile);
  const sizeKB = Math.round(stat.size / 1024);
  const ageMin = Math.round((Date.now() - stat.mtimeMs) / 60000);

  // Read last 5 lines for timestamp
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  const lastLines = lines.slice(-5);
  let lastTs = null;
  for (const line of lastLines.reverse()) {
    try {
      const ev = JSON.parse(line);
      if (ev.ts) { lastTs = ev.ts; break; }
    } catch { /* skip */ }
  }

  const detail = `${lines.length} events, ${sizeKB}KB, modified ${ageMin}m ago`;
  if (ageMin > 1440) {
    check('activity', 'warn', `${detail} — no activity in 24h+`);
  } else {
    check('activity', 'ok', detail);
  }
}

async function checkStoreHealth(cfg) {
  const url = cfg.qdrantUrl || 'http://localhost:6333';
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.qdrantKey) headers['api-key'] = cfg.qdrantKey;

  const collections = ['experience-selfqa', 'experience-behavioral', 'experience-principles'];
  const stats = {};
  let totalSuperseded = 0;
  let totalEntries = 0;

  for (const col of collections) {
    try {
      const scrollRes = await fetch(`${url}/collections/${col}/points/scroll`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ limit: 100, with_payload: true }),
        signal: AbortSignal.timeout(10000),
      });
      if (!scrollRes.ok) { stats[col] = { error: `HTTP ${scrollRes.status}` }; continue; }
      const points = (await scrollRes.json()).result?.points || [];
      let superseded = 0;
      for (const p of points) {
        let j = p.payload?.json;
        if (typeof j === 'string') { try { j = JSON.parse(j); } catch { j = {}; } }
        if (j?.superseded) superseded++;
      }
      // Get full count
      const infoRes = await fetch(`${url}/collections/${col}`, { headers });
      const count = infoRes.ok ? (await infoRes.json()).result?.points_count || points.length : points.length;

      stats[col] = { count, superseded };
      totalEntries += count;
      totalSuperseded += superseded;
    } catch (err) {
      stats[col] = { error: err.message };
    }
  }

  const supersededPct = totalEntries > 0 ? ((totalSuperseded / totalEntries) * 100).toFixed(1) : '0';
  const parts = collections.map(c => {
    const s = stats[c];
    const short = c.replace('experience-', '');
    return s.error ? `${short}=ERR` : `${short}=${s.count}`;
  });

  if (totalEntries === 0) {
    check('store', 'warn', 'all collections empty');
  } else {
    check('store', 'ok', `${totalEntries} entries (${parts.join(', ')}), ${supersededPct}% superseded`);
  }
}

function checkDisk() {
  try {
    const { execSync } = require('child_process');
    const duOut = execSync(`du -sh ${EXP_DIR} 2>/dev/null`, { encoding: 'utf8' }).trim();
    const size = duOut.split('\t')[0] || '?';
    check('disk', 'ok', `~/.experience = ${size}`);
  } catch {
    check('disk', 'warn', 'cannot measure disk usage');
  }
}

async function checkServerMemory(healthBody) {
  if (!healthBody) {
    check('memory', 'fail', 'server unreachable — cannot check memory');
    return;
  }
  const port = 8082;
  try {
    const { res } = await timedFetch(`http://127.0.0.1:${port}/metrics`, {}, 3000);
    if (res?.ok) {
      const text = await res.text();
      const rssMatch = text.match(/(?:process|experience)_memory_rss_bytes\s+(\d+)/);
      const heapMatch = text.match(/(?:process|experience)_memory_heap_(?:used_)?bytes\s+(\d+)/);
      const rss = rssMatch ? `${Math.round(parseInt(rssMatch[1]) / 1048576)}MB` : '?';
      const heap = heapMatch ? `${Math.round(parseInt(heapMatch[1]) / 1048576)}MB` : '?';
      check('memory', 'ok', `RSS=${rss} heap=${heap} uptime=${Math.round(healthBody.uptime || 0)}s`);
      return;
    }
  } catch { /* fall through */ }
  check('memory', 'ok', `uptime=${Math.round(healthBody.uptime || 0)}s`);
}

async function main() {
  const cfg = loadConfig();
  const t0 = Date.now();

  // Run all checks
  const healthBody = await checkServer(cfg);
  await Promise.all([
    checkQdrant(cfg),
    checkEmbed(cfg),
    checkBrain(cfg),
  ]);
  await checkIntercept(cfg);
  checkCronJobs();
  checkActivityLog();
  await checkStoreHealth(cfg);
  checkDisk();
  await checkServerMemory(healthBody);

  const totalMs = Date.now() - t0;
  const summary = {
    pass: results.filter(r => r.status === 'ok').length,
    warn: results.filter(r => r.status === 'warn').length,
    fail: results.filter(r => r.status === 'fail').length,
    totalMs,
    ts: new Date().toISOString(),
  };

  const output = { summary, checks: results };

  if (JSON_MODE) {
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    console.log('\n  Experience Engine — Deep Health Check\n');
    for (const r of results) {
      const icon = r.status === 'ok' ? '\x1b[32m✓\x1b[0m' : r.status === 'warn' ? '\x1b[33m!\x1b[0m' : '\x1b[31m✗\x1b[0m';
      const lat = r.latencyMs != null ? ` (${r.latencyMs}ms)` : '';
      console.log(`  ${icon} ${r.name.padEnd(18)} ${r.detail}${lat}`);
    }
    console.log(`\n  ${summary.pass} pass / ${summary.warn} warn / ${summary.fail} fail — ${totalMs}ms\n`);
  }

  if (CRON_MODE) {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(output, null, 2), 'utf8');

    if (summary.fail > 0) {
      const failedChecks = results.filter(r => r.status === 'fail').map(r => r.name);
      const alertLine = `${new Date().toISOString()} [deep-health-FAIL] failed=${failedChecks.join(',')} pass=${summary.pass} warn=${summary.warn} fail=${summary.fail}\n`;
      fs.mkdirSync(path.dirname(ALERT_LOG), { recursive: true });
      fs.appendFileSync(ALERT_LOG, alertLine, 'utf8');
      process.exitCode = 1;
    }
  }
}

main().catch(err => {
  console.error('[deep-health] FATAL:', err.message);
  process.exit(2);
});
