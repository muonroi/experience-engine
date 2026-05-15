## Resume Digest

Phase 1 — Hoàn thành toàn bộ ✅

Test coverage mới:
- interceptor.test.js: 10 tests ✅
- embedding.test.js: 7 tests ✅
- qdrant-io.test.js: 11 tests ✅

Module extraction (from experience-core.js 4102 LOC):
- src/config.js: 128 LOC — config/constants
- src/embedding.js: 157 LOC — embedding providers
- src/qdrant.js: 315 LOC — Qdrant I/O + FileStore
- src/utils.js: 345 LOC — scoring/formatting/context/noise

Delegate: experience-core.js now delegates ~40 functions to modules

Tổng: 51 tests — 0 fail ✅

## Experience Snapshot

- 945 LOC extracted, ~40 functions delegated
- experience-core.js giảm tải nhưng giữ nguyên backward compat
- Module mới standalone, zero deps, require()-able
- Deploy VPS: git push
