#!/usr/bin/env node
/**
 * Generates demo.yml (terminalizer format) then renders demo.gif
 * Usage: node tools/create-demo-gif.js
 * Requires: npm install -g terminalizer (already installed)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── ANSI helpers ────────────────────────────────────────────────────────────
const E = '[';
const C = {
  reset:   '[0m',
  bold:    '[1m',
  dim:     '[2m',
  red:     '[31m',
  green:   '[32m',
  yellow:  '[33m',
  blue:    '[34m',
  cyan:    '[36m',
  bred:    '[91m',
  bgreen:  '[92m',
  byellow: '[93m',
  bblue:   '[94m',
  bcyan:   '[96m',
  bwhite:  '[97m',
};

// ─── Frame builder ────────────────────────────────────────────────────────────
const records = [];

function push(delay, content) {
  records.push({ delay, content });
}

function line(delay, content = '') {
  records.push({ delay, content: content + '\r\n' });
}

function nl(delay = 100) {
  records.push({ delay, content: '\r\n' });
}

function type(str, charDelay = 58) {
  for (const ch of str) {
    records.push({ delay: charDelay + Math.floor(Math.random() * 20), content: ch });
  }
}

// ─── Scene ────────────────────────────────────────────────────────────────────

// Clear
push(100, '[2J[H');

// ── Header bar
line(60,  `  ${C.dim}╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌${C.reset}`);
line(50,  `  ${C.bcyan}${C.bold}⬡  Experience Engine${C.reset}  ${C.dim}v3.2  ·  Brain: 14 principles  ·  Mistakes avoided today: 0${C.reset}`);
line(50,  `  ${C.dim}╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌${C.reset}`);
nl(500);

// ── Prompt + command
push(200, `  ${C.bgreen}❯${C.reset} `);
type('codex "add database layer for the user service"', 55);
nl(700);
nl(150);

// ── Agent thinks
line(350, `  ${C.dim}Agent: I'll create a database context. Singleton looks right for a shared resource...${C.reset}`);
nl(350);

// ── Tool call: agent writes bad code
line(450, `  ${C.bblue}${C.bold}▶ Write${C.reset}  ${C.dim}src/data/UserDbContext.cs${C.reset}`);
nl(80);
line(90,  `    ${C.dim}public static class DbExtensions {${C.reset}`);
line(75,  `    ${C.dim}  public static IServiceCollection AddUserDb(${C.reset}`);
line(70,  `    ${C.dim}      this IServiceCollection services, string conn) {${C.reset}`);
// Bad line — highlight in red + pause for drama
push(600, `    ${C.bred}${C.bold}      services.AddSingleton${C.reset}${C.dim}<UserDbContext>(o => o.UseNpgsql(conn));${C.reset}`);
nl(1400); // ← long pause so viewer reads the bad line

// ── ⚠️  WARNING BOX fires
nl(80);
line(70,  `  ${C.byellow}${C.bold}╔══════════════════════════════════════════════════════════════════════════════╗${C.reset}`);
line(55,  `  ${C.byellow}${C.bold}║  ⚠  Experience Engine  ·  High Confidence 0.93  ·  T0 Principle             ║${C.reset}`);
line(55,  `  ${C.byellow}${C.bold}╠══════════════════════════════════════════════════════════════════════════════╣${C.reset}`);
line(70,  `  ${C.byellow}║${C.reset}                                                                              ${C.byellow}║${C.reset}`);
line(65,  `  ${C.byellow}║${C.reset}  ${C.bwhite}${C.bold}PATTERN: Singleton on stateful EF Core context${C.reset}                           ${C.byellow}║${C.reset}`);
line(65,  `  ${C.byellow}║${C.reset}                                                                              ${C.byellow}║${C.reset}`);
line(65,  `  ${C.byellow}║${C.reset}  ${C.bwhite}Use ${C.bgreen}AddDbContext${C.reset}${C.bwhite} (Scoped).  Singleton = shared EF state = corruption.${C.reset}     ${C.byellow}║${C.reset}`);
line(65,  `  ${C.byellow}║${C.reset}                                                                              ${C.byellow}║${C.reset}`);
line(65,  `  ${C.byellow}║${C.reset}  ${C.dim}Generalized from 3 past sessions:${C.reset}                                          ${C.byellow}║${C.reset}`);
line(58,  `  ${C.byellow}║${C.reset}  ${C.dim}  › DbContext singleton    →  state corruption in production${C.reset}               ${C.byellow}║${C.reset}`);
line(58,  `  ${C.byellow}║${C.reset}  ${C.dim}  › HttpClient singleton   →  connection pool exhausted${C.reset}                    ${C.byellow}║${C.reset}`);
line(58,  `  ${C.byellow}║${C.reset}  ${C.dim}  › RedisConnection        →  thread-safety violation${C.reset}                      ${C.byellow}║${C.reset}`);
line(65,  `  ${C.byellow}║${C.reset}                                                                              ${C.byellow}║${C.reset}`);
line(58,  `  ${C.byellow}║${C.reset}  ${C.dim}[id:f2a9b3c1  col:experience-principles]${C.reset}                                 ${C.byellow}║${C.reset}`);
line(58,  `  ${C.byellow}║${C.reset}                                                                              ${C.byellow}║${C.reset}`);
line(58,  `  ${C.byellow}${C.bold}╚══════════════════════════════════════════════════════════════════════════════╝${C.reset}`);
nl(700);

// ── Agent corrects
line(500, `  ${C.dim}Agent: Correct. DbContext must be Scoped, not Singleton. Fixing.${C.reset}`);
nl(300);

// ── Corrected code
line(250, `  ${C.bblue}${C.bold}▶ Write${C.reset}  ${C.dim}src/data/UserDbContext.cs${C.reset}  ${C.bgreen}← corrected${C.reset}`);
nl(80);
line(80,  `    ${C.dim}public static class DbExtensions {${C.reset}`);
line(70,  `    ${C.dim}  public static IServiceCollection AddUserDb(${C.reset}`);
line(65,  `    ${C.dim}      this IServiceCollection services, string conn) {${C.reset}`);
line(80,  `    ${C.bgreen}      services.AddDbContext<UserDbContext>(${C.reset}`);
line(70,  `    ${C.bgreen}          o => o.UseNpgsql(conn));${C.reset}  ${C.dim}// scoped ✓${C.reset}`);
nl(800);

// ── Footer
line(150, `  ${C.dim}╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌${C.reset}`);
line(65,  `  ${C.bgreen}✓ 1 mistake avoided${C.reset}  ${C.dim}·${C.reset}  ${C.bcyan}14 principles active${C.reset}  ${C.dim}·${C.reset}  ${C.bwhite}Memory: ${C.bcyan}↓ shrinking${C.reset}`);
line(65,  `  ${C.dim}╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌${C.reset}`);
nl(2500); // hold at end so loop restart is smooth

// ─── Build YAML ──────────────────────────────────────────────────────────────

const theme = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  cursor:     '#58a6ff',
  black:      '#0d1117',
  red:        '#ff7b72',
  green:      '#3fb950',
  yellow:     '#d29922',
  blue:       '#58a6ff',
  magenta:    '#bc8cff',
  cyan:       '#39c5cf',
  white:      '#c9d1d9',
  brightBlack:   '#484f58',
  brightRed:     '#ffa198',
  brightGreen:   '#56d364',
  brightYellow:  '#e3b341',
  brightBlue:    '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan:    '#56d4dd',
  brightWhite:   '#ffffff',
};

const themeYaml = Object.entries(theme)
  .map(([k, v]) => `    ${k}: "${v}"`)
  .join('\n');

const recordsYaml = records
  .map(r => `  - delay: ${r.delay}\n    content: ${JSON.stringify(r.content)}`)
  .join('\n');

const yaml = `config:
  command: bash
  cwd: /tmp
  env: {}
  cols: 82
  rows: 30
  repeat: 0
  quality: 100
  frameDelay: auto
  maxIdleTime: 3000
  frameBox:
    type: floating
    title: "Experience Engine — AI that learns from mistakes"
    style:
      border: "0px black solid"
      boxShadow: "0 20px 68px rgba(0,0,0,0.75)"
      margin: "0px"
  watermark:
    imagePath: null
  cursorStyle: block
  fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', monospace"
  fontSize: 13
  lineHeight: 1.3
  letterSpacing: 0
  theme:
${themeYaml}

records:
${recordsYaml}
`;

const root = path.join(__dirname, '..');
const ymlPath = path.join(root, 'demo.yml');
fs.writeFileSync(ymlPath, yaml, 'utf8');

const total = records.reduce((s, r) => s + r.delay, 0);
console.log(`✓ demo.yml written — ${records.length} frames, ~${(total / 1000).toFixed(1)}s`);
console.log('');
console.log('Rendering GIF...');

try {
  execSync(`terminalizer render "${ymlPath}" --quality 100 --output "${path.join(root, 'demo.gif')}"`, {
    stdio: 'inherit',
    cwd: root,
  });
  console.log('\n✓ demo.gif created');
  console.log('');
  console.log('Update README to reference: ![Demo](demo.gif)');
} catch (err) {
  console.error('\n✗ terminalizer render failed:', err.message);
  console.log('');
  console.log('Manual render:');
  console.log(`  terminalizer render demo --quality 100 --output demo.gif`);
  process.exit(1);
}
