'use strict';

/**
 * agent-md.js — write/refresh the Experience Engine managed instruction block
 * into each installed agent's config file. Pure Node port of
 * `.experience/inject-agent-instructions.sh` so the cross-platform installer
 * (`bin/init.js`) can inject without depending on bash.
 *
 * IMPORTANT: keep INSTRUCTION_BLOCK in sync with the heredoc in
 * inject-agent-instructions.sh. Both paths write the same marker-delimited
 * block and refresh it idempotently on every install/upgrade.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const START_MARKER = '<!-- experience-engine:start -->';
const END_MARKER = '<!-- experience-engine:end -->';

const INSTRUCTION_BLOCK = `${START_MARKER}
## Experience Engine

Passive hints fire before Edit/Write/Bash and end with \`[id col]\` tags — follow
high-confidence ones. Beyond passive hints, **actively query the brain** whenever
a step is unfamiliar or risky:

\`\`\`
node ~/.experience/exp-recall.js "<your question>"
\`\`\`

**Recall-first, verify-before-acting.** On an unfamiliar or risky step, query the
brain to orient and surface prior gotchas BEFORE diving in — then read the specific
code it points to and confirm against ground truth before acting. Recall replaces
broad blind exploration (read 1 file, not 10); it does NOT replace verifying the
exact code you are about to change, and recalled lessons are point-in-time and can
be stale — Evidence-First wins over a remembered claim.

After acting on any hint, report the verdict so the brain learns (this drives
Gate-4 precision — skipping it lets useful hints get auto-pruned):

\`\`\`
node ~/.experience/exp-feedback.js followed|ignored|noise <id> <col>
\`\`\`

Use the helper above — it resolves the brain URL and auth token from
\`~/.experience/config.json\` (on thin-client installs the hosted brain at
\`https://experience.muonroi.com\`; on a local full brain \`http://localhost:8082\`).
**Never** hand-roll a raw \`curl\` to a hardcoded endpoint — that skips URL + token
resolution and silently no-ops on thin-client installs.

Noise reasons (pick the FIRST match): \`stale_rule\` → \`wrong_repo\` →
\`wrong_language\` → \`wrong_task\` (last resort). Wrong reason = lost knowledge.

Full workflow, verdict table, and the noise decision tree:
\`~/.experience/AGENT_GUIDE.md\` (also at https://docs.muonroi.com/docs/experience-engine).

### Project Memory Self-Curation
To document new lessons, core architectural decisions, specialized UI/UX workflows, or bug fixes from this session, you MUST write/update the workspace memory before you finish the task:
- **For Gemini CLI**: Append or update bullet points under headings in \`~/.gemini/projects/<project-slug>/memory/MEMORY.md\`.
- **For Antigravity**: Append or update bullet points under headings in \`~/.gemini/antigravity/projects/<project-slug>/memory/MEMORY.md\`.
- **For Codex CLI**: Append or update bullet points under headings in \`~/.codex/projects/<project-slug>/memory/MEMORY.md\`.
- **For Claude Code**: Create/update individual markdown files under \`~/.claude/projects/<project-slug>/memory/<name>.md\` with YAML frontmatter (fields: \`name\`, \`type: feedback|project\`, \`description\`).
*In a single-file MEMORY.md a bullet defaults to a project-scoped lesson; prefix the label with \`[feedback]\` for a behavioral rule/correction (e.g. \`- **[feedback] Library-first**: …\`). Dash, asterisk and numbered (\`1.\`) bullets are all parsed. Always create the parent directories if they do not exist. Write memories to ensure the team can automatically sync them.*
${END_MARKER}`;

/**
 * Replace the managed block in `content` if present, else append it.
 * Pure string transform — exported for testing.
 */
function applyBlock(content, block = INSTRUCTION_BLOCK) {
  if (content.includes(START_MARKER)) {
    const lines = content.split(/\r?\n/);
    const out = [];
    let skip = false;
    for (const line of lines) {
      if (line.includes(START_MARKER)) {
        skip = true;
        continue;
      }
      if (line.includes(END_MARKER)) {
        skip = false;
        continue;
      }
      if (!skip) out.push(line);
    }
    let text = out.join('\n');
    // Collapse a trailing blank run, then append the fresh block.
    text = text.replace(/\s*$/, '');
    return `${text}\n\n${block}\n`;
  }
  // No managed block yet — append, preserving existing content.
  const base = content.replace(/\s*$/, '');
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

/**
 * Inject/refresh the managed block into every installed agent's MD file.
 * Skips targets whose parent dir is absent (agent not installed).
 *
 * @param {object} [opts]
 * @param {string} [opts.home] home dir (testing override)
 * @param {(msg:string)=>void} [opts.log] logger
 * @returns {{injected:number, results:Array<{file:string, action:string}>}}
 */
function injectAgentInstructions(opts = {}) {
  const home = opts.home || os.homedir();
  const log = opts.log || (() => {});

  if (process.env.EXPERIENCE_SKIP_MD_INJECT === '1') {
    log('  [inject] EXPERIENCE_SKIP_MD_INJECT=1 — skipping agent instruction injection');
    return { injected: 0, results: [] };
  }

  const targets = [
    path.join(home, '.claude', 'CLAUDE.md'),
    path.join(home, '.gemini', 'GEMINI.md'),
    path.join(home, '.codex', 'AGENTS.md'),
    path.join(home, '.config', 'opencode', 'AGENTS.md'),
  ];

  const results = [];
  let injected = 0;

  for (const file of targets) {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) continue; // agent not installed

    try {
      let action;
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, `${INSTRUCTION_BLOCK}\n`);
        action = 'created';
      } else {
        const current = fs.readFileSync(file, 'utf8');
        const had = current.includes(START_MARKER);
        fs.writeFileSync(file, applyBlock(current));
        action = had ? 'updated' : 'injected';
      }
      injected += 1;
      results.push({ file, action });
      log(`  [inject] ${action}: ${file}`);
    } catch (err) {
      results.push({ file, action: 'error', error: err.message });
      log(`  [inject] WARN: failed for ${file}: ${err.message}`);
    }
  }

  return { injected, results };
}

module.exports = {
  INSTRUCTION_BLOCK,
  START_MARKER,
  END_MARKER,
  applyBlock,
  injectAgentInstructions,
};
