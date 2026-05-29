"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateStaticRules, _internal } = require("./src/static-rules.js");
const { isSizeCapExempt, countLines, SIZE_CAP_LINES_WRITE, SIZE_CAP_LINES_EDIT } = _internal;

const bigContent = (n) => Array.from({ length: n }, (_, i) => "x=" + i).join("\n");

test("countLines: basic", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a\nb\n"), 3);
});

test("isSizeCapExempt: data/snapshot/generated paths", () => {
  for (const p of [
    "/repo/src/models/catalog.json",
    "/repo/__snapshots__/foo.snap",
    "/repo/package-lock.json",
    "/repo/bun.lockb",
    "/repo/tests/harness/fixtures/x.json",
    "/repo/tests/fixtures/x.ts",
    "/repo/node_modules/lib/index.js",
    "/repo/src/x.min.js",
    "/repo/data/load.fixture.ts",
    "/repo/data.json",
  ]) {
    assert.equal(isSizeCapExempt(p), true, "expected exempt: " + p);
  }
  assert.equal(isSizeCapExempt("/repo/src/orchestrator/big.ts"), false);
  assert.equal(isSizeCapExempt("/repo/package.json"), false);
});

test("Write > 1000 lines fires when not exempt", () => {
  const r = evaluateStaticRules("Write", { file_path: "/repo/big.ts", content: bigContent(1500) });
  assert.equal(r.length, 1);
  assert.ok(r[0].id.startsWith("file-size-cap-"));
  assert.match(r[0].line, /Static Rule/);
  assert.match(r[0].line, /1500 lines/);
});

test("Write at/under cap is silent", () => {
  assert.equal(evaluateStaticRules("Write", { file_path: "/repo/small.ts", content: bigContent(50) }).length, 0);
  assert.equal(evaluateStaticRules("Write", { file_path: "/repo/edge.ts", content: bigContent(SIZE_CAP_LINES_WRITE) }).length, 0);
});

test("Write to exempt paths is silent", () => {
  for (const p of ["/repo/catalog.json", "/repo/__snapshots__/x.snap", "/repo/tests/harness/fixtures/y.json"]) {
    assert.equal(evaluateStaticRules("Write", { file_path: p, content: bigContent(1500) }).length, 0, "should skip: " + p);
  }
});

test("Edit fires only on wholesale > 1500-line replacement", () => {
  const big = bigContent(1600);
  const fired = evaluateStaticRules("Edit", { file_path: "/repo/file.ts", old_string: "x", new_string: big });
  assert.equal(fired.length, 1);
  assert.match(fired[0].id, /1500-edit/);
});

test("Small Edit on existing file is silent", () => {
  const r = evaluateStaticRules("Edit", { file_path: "/repo/big.ts", old_string: "const a = 1", new_string: "const a = 2" });
  assert.equal(r.length, 0);
});

test("Tools without file_path are silent (Bash etc.)", () => {
  assert.equal(evaluateStaticRules("Bash", { command: "ls -la" }).length, 0);
  assert.equal(evaluateStaticRules("Read", { file_path: "/repo/anything.ts" }).length, 0);
});

test("Static rule line carries id + collection tag for feedback helper", () => {
  const r = evaluateStaticRules("Write", { file_path: "/repo/big.ts", content: bigContent(1500) });
  assert.match(r[0].line, /\[id:file-size-cap-1000-write col:static-rules\]/);
});
