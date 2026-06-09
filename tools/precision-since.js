#!/usr/bin/env node
'use strict';
/**
 * precision-since.js — early-warning probe for interception precision (Gate 2 #4).
 *
 * The dashboard gate computes precision over a 7-DAY ROLLING window, so a fix
 * does not show up for ~7 days as pre-fix data ages out. This probe instead
 * computes precision over the slice of activity SINCE a cutoff (default: the
 * first `relevance-gate` event, i.e. when the pre-surface gate went live), so
 * the real post-fix precision is readable within ~1-2 days of accumulated
 * feedback instead of 7. It also reports whether the gate is actually firing.
 *
 * Usage:
 *   node tools/precision-since.js                 # since gate went live (auto)
 *   node tools/precision-since.js --since 2026-06-09T02:00:00Z
 *   node tools/precision-since.js --json
 *
 * Verdicts:
 *   GATE_STALLED         gate dropped 0 points since cutoff — fix not engaging, investigate NOW
 *   INSUFFICIENT_DATA    <30 classified feedback events post-cutoff — keep using, recheck tomorrow
 *   PASS_TRENDING        >=70% precision on post-cutoff slice — 7-day gate will converge here
 *   BELOW_TARGET         <70% with enough data — fix is not lifting precision, investigate without waiting 7d
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MIN_CLASSIFIED = 30;
const TARGET = 70;

function parseArgs(argv) {
  const out = { json: false, since: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--since') out.since = argv[++i];
  }
  return out;
}

function tsMs(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : 0;
}

function main() {
  const args = parseArgs(process.argv);
  const logPath = path.join(os.homedir(), '.experience', 'activity.jsonl');
  let lines = [];
  try {
    lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  } catch (err) {
    console.error(`[precision-since] cannot read ${logPath}: ${err?.message}`);
    process.exit(2);
  }

  const events = [];
  let firstGate = null;
  let gateEvents = 0;
  let gateDropped = 0;
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    events.push(e);
    if (e.op === 'relevance-gate') {
      gateEvents++;
      gateDropped += Number(e.removed) || 0;
      if (e.ts && (!firstGate || e.ts < firstGate)) firstGate = e.ts;
    }
  }

  const sinceTs = args.since || firstGate;
  if (!sinceTs) {
    const out = { verdict: 'GATE_STALLED', reason: 'no relevance-gate event found — gate never fired', gateEvents: 0, gateDropped: 0 };
    console.log(args.json ? JSON.stringify(out) : `[precision-since] ${out.verdict}: ${out.reason}`);
    process.exit(0);
  }
  const cut = tsMs(sinceTs);

  let relevant = 0;
  let irrelevant = 0;
  const reasonMix = {};
  for (const e of events) {
    if (!e.ts || tsMs(e.ts) < cut) continue;
    if (e.op === 'implicit-touch') relevant++;
    else if (e.op === 'implicit-unused') { irrelevant++; reasonMix[e.reason || '?'] = (reasonMix[e.reason || '?'] || 0) + 1; }
    else if (e.op === 'feedback') {
      const v = e.verdict || (e.followed === true ? 'FOLLOWED' : e.followed === false ? 'IGNORED' : null);
      if (v === 'FOLLOWED' || v === 'IGNORED') relevant++;
      else if (v === 'IRRELEVANT') { irrelevant++; reasonMix[e.reason || '?'] = (reasonMix[e.reason || '?'] || 0) + 1; }
    }
  }
  const classified = relevant + irrelevant;
  const precision = classified > 0 ? Math.round((relevant / classified) * 1000) / 10 : 0;

  let verdict;
  if (gateDropped === 0) verdict = 'GATE_STALLED';
  else if (classified < MIN_CLASSIFIED) verdict = 'INSUFFICIENT_DATA';
  else if (precision >= TARGET) verdict = 'PASS_TRENDING';
  else verdict = 'BELOW_TARGET';

  const out = { verdict, sinceTs, gateEvents, gateDropped, classified, relevant, irrelevant, precision, target: TARGET, reasonMix };
  if (args.json) {
    console.log(JSON.stringify(out));
  } else {
    console.log(`[precision-since] verdict=${verdict}`);
    console.log(`  since        ${sinceTs}`);
    console.log(`  gate         ${gateEvents} events, ${gateDropped} points dropped`);
    console.log(`  precision    ${precision}% (${relevant}/${classified} classified, target ${TARGET}%)`);
    console.log(`  irrelevant   ${JSON.stringify(reasonMix)}`);
  }
}

main();
