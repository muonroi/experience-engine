// Regression: surfaced hints stashed at intercept time must be reconciled at
// PostToolUse even when the client does not echo surfacedIds back (the
// codex-windows path that left 1728/1728 posttool calls with surfacedCount:0
// and emitted zero verdicts, starving Gate 4). See server.js handleIntercept
// stash + intercept.js stashSurfacedHints/reconcilePendingHints.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "exp-stash-home-"));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.EXPERIENCE_QDRANT_URL = "http://127.0.0.1:1";

const {
  _stashSurfacedHints: stashSurfacedHints,
  _reconcilePendingHints: reconcilePendingHints,
} = require("./experience-core.js");

describe("server-side surfaced-hint stash", () => {
  it("exports the stash helper", () => {
    assert.equal(typeof stashSurfacedHints, "function");
  });

  it("reconciles a stashed hint when posttool echoes NO surfacedIds", async () => {
    const meta = { sourceSession: "stash-regression-1", sourceKind: "codex-hook", sourceRuntime: "codex-windows", project_slug: "proj-a", cwd: "/work/proj-a" };
    const surfaced = [{ collection: "experience-behavioral", id: "stash-hint-1", projectSlug: "proj-a", scope: { lang: "all" } }];
    assert.deepEqual(stashSurfacedHints(surfaced, meta), { stashed: 1 });
    // Empty incoming list = the codex failure mode. Use a DIFFERENT-project action
    // so the assessment is non-touch (wrong_repo) and avoids any Qdrant write,
    // while still proving the stashed pending was found from persistence.
    const rec = await reconcilePendingHints([], "Edit", { file_path: "/work/proj-b/src/x.ts" }, { ...meta, project_slug: "proj-b", cwd: "/work/proj-b" });
    const refs = [...rec.touched, ...rec.pending, ...rec.implicitUnused].map((r) => r.id);
    assert.ok(refs.includes("stash-hint-1"), "stashed hint must be reconciled from persistence, got: " + JSON.stringify(refs));
  });
});
