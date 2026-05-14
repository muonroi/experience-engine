#!/usr/bin/env node
'use strict';
/**
 * exp-backfill-cross-stack-scope.js
 *
 * Retag existing brain entries that describe cross-stack mistakes (git,
 * deploy, infra, security, shell-meta, review-meta, testing-meta) with
 * wildcard scope so they surface regardless of caller language/framework.
 *
 * Without this, an entry like "force-push lost commits" extracted while
 * working in TypeScript gets tagged scope.lang=TypeScript by the
 * caller-meta hard-override — so the same lesson never fires when the
 * user runs into the same git mistake from a C# project.
 *
 * Heuristic: same regex set used by brain-llm.js _inferCrossStackCategory.
 *
 * Usage:
 *   node tools/exp-backfill-cross-stack-scope.js
 *   node tools/exp-backfill-cross-stack-scope.js --apply
 *   node tools/exp-backfill-cross-stack-scope.js --collection experience-behavioral --apply
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const COLLECTIONS_DEFAULT = ['experience-behavioral', 'experience-selfqa', 'experience-principles'];
const SCROLL_BATCH = 128;

function parseArgs(argv) {
  const args = { apply: false, collection: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--apply') args.apply = true;
    else if (k === '--collection') args.collection = argv[++i];
    else if (k === '--qdrant-url') args.qdrantUrl = argv[++i];
    else if (k === '--qdrant-key') args.qdrantKey = argv[++i];
    else if (k === '--help' || k === '-h') {
      process.stdout.write(`exp-backfill-cross-stack-scope — retag git/deploy/security/etc with wildcard scope
  --apply              actually write (default: dry-run)
  --collection <name>  limit to one collection
`);
      process.exit(0);
    }
  }
  return args;
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.experience', 'config.json'), 'utf8')); }
  catch { return {}; }
}

function inferCrossStackCategory(exp) {
  const text = `${exp?.trigger || ''} ${exp?.solution || ''} ${exp?.why || ''} ${exp?.failureMode || ''} ${exp?.principle || ''}`.toLowerCase();
  if (!text.trim()) return null;
  if (/\bgit\s+(push|pull|reset|rebase|merge|stash|cherry-pick|reflog|commit|branch|checkout|revert|tag)\b/.test(text)) return 'git';
  if (/\b(force[- ]push|force push|lost commits|detached head|merge conflict)\b/.test(text)) return 'git';
  if (/\b(kubectl|kubernetes|k8s|helm chart|docker build|dockerfile|docker[- ]compose|rollout|canary release|blue[- ]green|ci\/cd|pipeline yaml|github actions|gitlab ci|jenkins pipeline|canary deployment|deploy.*production)\b/.test(text)) return 'deploy';
  if (/\b(terraform|cloudformation|pulumi|ansible|nginx config)\b/.test(text)) return 'infra';
  if (/\b(hardcoded secret|secret in code|env(ironment)? var leak|sql injection|xss|csrf|missing auth|unsanitized input|cors misconfiguration)\b/.test(text)) return 'security';
  if (/\b(test pyramid|tdd discipline|fixture lifecycle|test isolation|flaky test pattern|mocking strategy)\b/.test(text)) return 'testing-meta';
  if (/\b(posix vs bash|bashism|word splitting|unquoted variable|set[ -]e pitfall)\b/.test(text)) return 'shell-meta';
  if (/\b(code review process|pr review checklist|review approval)\b/.test(text)) return 'review-meta';
  return null;
}

async function qdrantPost(qdrantUrl, qdrantKey, urlPath, body) {
  const res = await fetch(`${qdrantUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`qdrant ${res.status} ${res.statusText} on ${urlPath}`);
  return res.json();
}

async function* scrollCollection(qdrantUrl, qdrantKey, collection) {
  let offset = null;
  for (;;) {
    const body = { limit: SCROLL_BATCH, with_payload: true, with_vector: false };
    if (offset) body.offset = offset;
    const res = await qdrantPost(qdrantUrl, qdrantKey, `/collections/${collection}/points/scroll`, body);
    const points = res?.result?.points || [];
    if (points.length === 0) break;
    for (const p of points) yield p;
    offset = res?.result?.next_page_offset;
    if (!offset) break;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig();
  const qdrantUrl = (args.qdrantUrl || cfg.qdrantUrl || 'http://localhost:6333').replace(/\/$/, '');
  const qdrantKey = args.qdrantKey || cfg.qdrantKey || '';
  const collections = args.collection ? [args.collection] : COLLECTIONS_DEFAULT;
  const auditPath = path.join(os.homedir(), '.experience', `backfill-cross-stack-${Date.now()}.jsonl`);
  const auditFd = fs.openSync(auditPath, 'a');

  console.log(`mode=${args.apply ? 'APPLY' : 'DRY-RUN'}  qdrant=${qdrantUrl}  audit=${auditPath}`);

  const perColl = {};
  const byCategory = { git: 0, deploy: 0, infra: 0, security: 0, 'testing-meta': 0, 'shell-meta': 0, 'review-meta': 0 };

  for (const collection of collections) {
    perColl[collection] = { scanned: 0, retagged: 0, skipped: 0 };
    for await (const point of scrollCollection(qdrantUrl, qdrantKey, collection)) {
      perColl[collection].scanned++;
      let exp;
      try { exp = JSON.parse(point.payload?.json || '{}'); } catch { continue; }
      const cat = inferCrossStackCategory(exp);
      if (!cat) { perColl[collection].skipped++; continue; }
      byCategory[cat] = (byCategory[cat] || 0) + 1;

      const before = { lang: exp?.scope?.lang, framework: exp?.scope?.framework };
      const needsRetag = before.lang !== 'all' || before.framework !== 'any' || exp.category !== cat;
      if (!needsRetag) continue;

      fs.writeSync(auditFd, JSON.stringify({
        ts: new Date().toISOString(), collection, id: point.id, action: 'cross-stack-retag',
        category: cat, before, after: { lang: 'all', framework: 'any' },
      }) + '\n');

      if (args.apply) {
        if (!exp.scope || typeof exp.scope !== 'object') exp.scope = {};
        exp.scope.lang = 'all';
        exp.scope.framework = 'any';
        exp.category = cat;
        await qdrantPost(qdrantUrl, qdrantKey, `/collections/${collection}/points/payload`, {
          points: [point.id],
          payload: { json: JSON.stringify(exp) },
        });
      }
      perColl[collection].retagged++;
    }
  }

  fs.closeSync(auditFd);
  console.log('\n=== summary ===');
  for (const [c, s] of Object.entries(perColl)) {
    console.log(`  ${c}: scanned=${s.scanned} retagged=${s.retagged} skipped=${s.skipped}`);
  }
  console.log('\n=== by category ===');
  for (const [cat, n] of Object.entries(byCategory)) {
    if (n > 0) console.log(`  ${cat}: ${n}`);
  }
  console.log(args.apply ? 'APPLIED.' : 'DRY-RUN — pass --apply to commit.');
}

main().catch((e) => { console.error(e); process.exit(1); });
