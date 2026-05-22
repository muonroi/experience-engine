#!/usr/bin/env node
/**
 * E2E test: run detectExperience() on real local session transcripts.
 *
 * Usage:
 *   node tests/test-detect-experience.js
 *   node tests/test-detect-experience.js --session <path-to-jsonl>
 *   node tests/test-detect-experience.js --all   (scan all recent sessions)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Load the modules under test
const contextPath = path.join(__dirname, '..', 'src', 'context.js');
const extractCompactPath = path.join(__dirname, '..', 'extract-compact.js');
const stopExtractorPath = path.join(__dirname, '..', 'stop-extractor.js');

const { detectExperience, detectMistakes } = require(contextPath);
const { compactTranscript } = require(extractCompactPath);

// Borrow buildClaudeSessionData from stop-extractor (it's exported)
let buildSessionData;
try {
  const se = require(stopExtractorPath);
  buildSessionData = se.buildSessionData || se.buildClaudeSessionData;
} catch {
  buildSessionData = null;
}

function findRecentSessions(homeDir, maxAge = 7 * 24 * 60 * 60 * 1000) {
  const projectsDir = path.join(homeDir, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return [];
  const sessions = [];
  const now = Date.now();

  for (const dir of fs.readdirSync(projectsDir)) {
    const fullDir = path.join(projectsDir, dir);
    if (!fs.statSync(fullDir).isDirectory()) continue;
    for (const file of fs.readdirSync(fullDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const fullPath = path.join(fullDir, file);
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > maxAge) continue;
      if (stat.size < 5000) continue;
      sessions.push({
        path: fullPath,
        project: dir,
        size: stat.size,
        modified: stat.mtime,
      });
    }
  }
  return sessions.sort((a, b) => b.size - a.size);
}

function buildTranscriptFromJsonl(logPath) {
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  const transcriptLines = [];

  for (const rawLine of lines) {
    let entry;
    try { entry = JSON.parse(rawLine); } catch { continue; }
    const content = entry.message?.content;
    const role = entry.message?.role;
    if (!content) continue;

    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }];
    for (const block of blocks) {
      if (!block) continue;
      if (block.type === 'text' || typeof block.text === 'string') {
        const text = String(block.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
        if (!text) continue;
        transcriptLines.push(`${role === 'user' ? 'User' : 'Assistant'}: ${text}`);
        continue;
      }
      if (block.type === 'tool_use' && block.name) {
        const args = block.input || {};
        const tool = block.name.replace(/^mcp__\w+__/, '');
        let summary = '';
        if (tool === 'Edit' || tool === 'edit') {
          const target = args.file_path || args.path || '';
          const oldStr = args.old_string || '';
          const newStr = args.new_string || '';
          const oldSnip = oldStr ? `old="${oldStr.replace(/\s+/g, ' ').trim().slice(0, 80)}" ` : '';
          const newSnip = newStr ? `new="${newStr.replace(/\s+/g, ' ').trim().slice(0, 80)}"` : '';
          summary = `${target} ${oldSnip}${newSnip}`.trim();
        } else if (tool === 'Bash' || tool === 'bash') {
          summary = String(args.command || args.cmd || '').slice(0, 300);
        } else if (tool === 'Write' || tool === 'write_file') {
          summary = String(args.file_path || args.path || '').slice(0, 200);
        } else {
          summary = String(args.file_path || args.path || JSON.stringify(args)).slice(0, 200);
        }
        transcriptLines.push(`ToolCall ${tool}: ${summary.slice(0, 300)}`);
        continue;
      }
      if (block.type === 'tool_result') {
        const resultContent = Array.isArray(block.content)
          ? block.content.map(c => c.text || '').filter(Boolean).join(' ')
          : String(block.content || '');
        const text = resultContent.replace(/\s+/g, ' ').trim().slice(0, 600);
        if (text) transcriptLines.push(`ToolOutput: ${text}`);
      }
    }
  }
  return transcriptLines.join('\n');
}

function printExperiences(experiences, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`  Found: ${experiences.length} experiences`);
  console.log(`${'='.repeat(60)}`);

  const byType = {};
  for (const exp of experiences) {
    byType[exp.type] = (byType[exp.type] || 0) + 1;
  }
  console.log('\n  Type breakdown:', JSON.stringify(byType));

  for (let i = 0; i < experiences.length; i++) {
    const exp = experiences[i];
    console.log(`\n  [${i + 1}] ${exp.type.toUpperCase()}`);
    console.log(`      Context: ${exp.context}`);
    if (exp.type === 'recipe') {
      console.log(`      Steps: ${(exp.steps || []).length}`);
      console.log(`      Files: ${(exp.files || []).join(', ')}`);
    }
    if (exp.type === 'trap') {
      console.log(`      Failed: ${(exp.failedApproach || '').slice(0, 100)}`);
      console.log(`      Worked: ${(exp.successApproach || '').slice(0, 100)}`);
    }
    if (exp.type === 'dependency') {
      console.log(`      Trigger: ${exp.trigger}`);
      console.log(`      Affected: ${exp.affected}`);
    }
    if (exp.type === 'env_trap') {
      console.log(`      Error: ${(exp.error || '').slice(0, 100)}`);
      console.log(`      Workaround: ${(exp.workaround || '').slice(0, 100)}`);
    }
    if (exp.type === 'user_correction') {
      console.log(`      Correction: ${(exp.correction || '').slice(0, 100)}`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const homeDir = os.homedir();
  let sessions = [];

  if (args.includes('--session')) {
    const idx = args.indexOf('--session');
    const sessionPath = args[idx + 1];
    if (!sessionPath || !fs.existsSync(sessionPath)) {
      console.error('Session file not found:', sessionPath);
      process.exit(1);
    }
    sessions = [{ path: sessionPath, project: path.basename(path.dirname(sessionPath)), size: fs.statSync(sessionPath).size }];
  } else if (args.includes('--all')) {
    sessions = findRecentSessions(homeDir).slice(0, 10);
  } else {
    sessions = findRecentSessions(homeDir).slice(0, 3);
  }

  if (sessions.length === 0) {
    console.log('No sessions found.');
    process.exit(0);
  }

  console.log(`\nTesting detectExperience() on ${sessions.length} sessions\n`);

  let totalNew = 0;
  let totalOld = 0;

  for (const session of sessions) {
    const shortName = `${session.project}/${path.basename(session.path).slice(0, 12)}`;
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Session: ${shortName} (${(session.size / 1024).toFixed(0)} KB)`);

    const rawTranscript = buildTranscriptFromJsonl(session.path);
    const transcript = compactTranscript(rawTranscript);
    const lineCount = transcript.split('\n').length;
    console.log(`  Transcript: ${rawTranscript.split('\n').length} raw → ${lineCount} compacted lines (${transcript.length} chars)`);

    // Old detector
    const oldResults = detectMistakes(transcript);
    totalOld += oldResults.length;
    console.log(`\n  OLD detectMistakes(): ${oldResults.length} results`);
    for (const m of oldResults) {
      console.log(`    - ${m.type}: ${m.context?.slice(0, 80)}`);
    }

    // New detector
    const newResults = detectExperience(transcript);
    totalNew += newResults.length;
    printExperiences(newResults, `NEW detectExperience() — ${shortName}`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  SUMMARY`);
  console.log(`  Sessions tested: ${sessions.length}`);
  console.log(`  Old detector total: ${totalOld}`);
  console.log(`  New detector total: ${totalNew}`);
  console.log(`${'═'.repeat(60)}\n`);
}

main();
