"""Tests for Experience Engine Python SDK.

Requires a running server: node experience-engine/server.js
Run: python test_client.py
"""

import sys
import os

# Add package to path for local testing
sys.path.insert(0, os.path.dirname(__file__))

from muonroi_experience import Client, ExperienceAPIError

passed = 0
failed = 0
BASE = os.environ.get("EXP_TEST_URL", "http://localhost:8082")


def assert_test(condition, label):
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS: {label}")
    else:
        failed += 1
        print(f"  FAIL: {label}")


def main():
    global passed, failed

    client = Client(BASE, timeout=10)

    # 1. Client creation
    assert_test(client.base_url == BASE, "client has correct base_url")
    assert_test(client.timeout == 10, "client has correct timeout")

    # 2. Health
    print("\n--- health ---")
    try:
        h = client.health()
        assert_test("status" in h, "health has status")
        assert_test("qdrant" in h, "health has qdrant")
        assert_test("fileStore" in h, "health has fileStore")
        assert_test("uptime" in h, "health has uptime")
    except ExperienceAPIError as e:
        print(f"  SKIP: health failed ({e})")
        failed += 4

    # 3. Intercept
    print("\n--- intercept ---")
    try:
        r = client.intercept("Write", {"file_path": "test.py"})
        assert_test("suggestions" in r, "intercept has suggestions")
        assert_test("hasSuggestions" in r, "intercept has hasSuggestions")
    except ExperienceAPIError as e:
        print(f"  SKIP: intercept failed ({e})")
        failed += 2

    # 4. Intercept validation
    print("\n--- intercept validation ---")
    try:
        client.intercept("")
        assert_test(False, "empty toolName should raise")
    except ExperienceAPIError as e:
        assert_test(e.status_code == 400, "empty toolName returns 400")

    # 5. Extract (short transcript → stored=0)
    print("\n--- extract ---")
    try:
        r = client.extract("short")
        assert_test(r.get("stored") == 0, "short transcript stores 0")
    except ExperienceAPIError as e:
        print(f"  SKIP: extract failed ({e})")
        failed += 1

    # 6. Evolve
    print("\n--- evolve ---")
    try:
        r = client.evolve()
        assert_test("promoted" in r, "evolve has promoted")
        assert_test("success" in r, "evolve has success")
    except ExperienceAPIError as e:
        print(f"  SKIP: evolve failed ({e})")
        failed += 2

    # 7. Stats
    print("\n--- stats ---")
    try:
        r = client.stats(since="7d")
        assert_test("totalIntercepts" in r, "stats has totalIntercepts")
        assert_test("top5" in r, "stats has top5")
    except ExperienceAPIError as e:
        print(f"  SKIP: stats failed ({e})")
        failed += 2

    # 8. User
    print("\n--- user ---")
    try:
        r = client.user()
        assert_test(isinstance(r.get("user"), str), "user returns string")
    except ExperienceAPIError as e:
        print(f"  SKIP: user failed ({e})")
        failed += 1

    # 9. Graph (unknown id → empty edges)
    print("\n--- graph ---")
    try:
        r = client.graph("00000000-0000-0000-0000-000000000000")
        assert_test(isinstance(r.get("edges"), list), "graph returns edges list")
        assert_test(r.get("count") == 0, "graph returns 0 for unknown id")
    except ExperienceAPIError as e:
        print(f"  SKIP: graph failed ({e})")
        failed += 2

    # 10. Share validation
    print("\n--- share principle ---")
    try:
        client.share_principle("nonexistent")
        assert_test(False, "nonexistent share should raise")
    except ExperienceAPIError as e:
        assert_test(e.status_code == 404, "share nonexistent returns 404")

    # 11. Import validation
    print("\n--- import principle ---")
    try:
        client.import_principle({})
        assert_test(False, "empty import should raise")
    except ExperienceAPIError as e:
        assert_test(e.status_code == 400, "empty import returns 400")

    # 12. Connection error
    print("\n--- connection error ---")
    bad_client = Client("http://localhost:1", timeout=2)
    try:
        bad_client.health()
        assert_test(False, "bad URL should raise")
    except ExperienceAPIError as e:
        assert_test(e.status_code == 0, "connection error has status 0")

    print(f"\n{'=' * 40}")
    print(f"{passed} passed, {failed} failed")
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()
