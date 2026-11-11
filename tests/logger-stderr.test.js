'use strict';

/**
 * Regression: structured diagnostics (logger.js `log()`) must go to STDERR, never stdout.
 *
 * Measured 2026-11-12 on the production VPS: `node tools/exp-gates.js --json` wrote
 *   {"ts":"...","level":"warn","msg":"brain_openai_http_error","status":402,...}
 * to stdout ahead of its JSON document, so tools/exp-dashboard.js (runExpGates ->
 * JSON.parse(stdout)) failed with "Unexpected non-whitespace character after JSON at
 * position 300" and the dashboard showed `verdict: exp-gates.js unavailable`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const GATES = path.join(REPO, 'tools', 'exp-gates.js');
const LOGGER = path.join(REPO, '.experience', 'src', 'logger.js');

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function cleanEnv(home) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('EXPERIENCE_')) env[k] = v;
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
}

function warnLines(text) {
  return text.split('\n').filter((l) => l.startsWith('{')).map((l) => {
    try { return JSON.parse(l); } catch (err) {
      assert.fail(`stderr line is not JSON: ${l.slice(0, 120)} (${err.message})`);
      return null;
    }
  });
}

test('logger: every level writes to stderr and nothing to stdout', async () => {
  const script = `const { log } = require(${JSON.stringify(LOGGER)});
    for (const level of ['error', 'warn', 'info', 'debug']) log(level, 'probe_' + level, { level_probe: level });`;
  const env = cleanEnv(os.tmpdir());
  env.EXPERIENCE_LOG_LEVEL = 'debug';
  const { code, stdout, stderr } = await run(['-e', script], env);
  assert.equal(code, 0);
  assert.equal(stdout, '', 'logger must not write to stdout');
  const entries = warnLines(stderr);
  assert.deepEqual(entries.map((e) => e.msg), ['probe_error', 'probe_warn', 'probe_info', 'probe_debug']);
});

test('exp-gates --json: brain HTTP 402 warn goes to stderr, stdout stays a clean JSON document', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-logstderr-'));
  const hits = { brain: 0 };
  // One fake host: the brain endpoint answers 402 (as api.stepfun.ai did); everything else
  // (Qdrant/embedding probes) answers 404, which exp-gates treats as "unavailable".
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.startsWith('/v1/chat/completions')) {
        hits.brain += 1;
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'insufficient balance' } }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // exp-gates loads ~/.experience/experience-core.js, so give it an install of the repo's runtime.
    fs.cpSync(path.join(REPO, '.experience'), path.join(home, '.experience'), { recursive: true });
    fs.writeFileSync(path.join(home, '.experience', 'config.json'), JSON.stringify({
      qdrantUrl: base,
      brainProvider: 'custom',
      brainEndpoint: `${base}/v1/chat/completions`,
      brainKey: 'test-key',
      brainModel: 'test-model',
      embedProvider: 'ollama',
      ollamaUrl: base,
    }));

    const { code, stdout, stderr } = await run([GATES, '--json'], cleanEnv(home));

    assert.ok(hits.brain > 0, `brain endpoint was never called; stderr: ${stderr.slice(0, 400)}`);
    assert.equal(code, 0, `exp-gates exited ${code}; stderr: ${stderr.slice(0, 400)}`);

    let doc;
    try { doc = JSON.parse(stdout); } catch (err) {
      assert.fail(`stdout is not a clean JSON document (${err.message}); head: ${stdout.slice(0, 200)}`);
    }
    assert.ok(doc.gate1 && doc.overall, 'stdout JSON is the gates document');

    const warn = warnLines(stderr).find((e) => e.msg === 'brain_openai_http_error');
    assert.ok(warn, `brain_openai_http_error not found on stderr: ${stderr.slice(0, 400)}`);
    assert.equal(warn.level, 'warn');
    assert.equal(warn.status, 402);
    assert.ok(!stdout.includes('brain_openai_http_error'), 'warn must not leak into stdout');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (err) {
      console.error(`[logger-stderr.test] cleanup failed for ${home}: ${err.message}`);
    }
  }
});
