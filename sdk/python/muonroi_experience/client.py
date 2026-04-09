"""
Experience Engine Python SDK — lightweight wrapper over REST API.

Usage:
    from muonroi_experience import Client

    client = Client("http://localhost:8082")
    result = client.intercept("Write", {"file_path": "app.py"})
    print(result["suggestions"])
"""

import json
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode


class ExperienceAPIError(Exception):
    """Raised when the Experience Engine API returns a non-2xx response."""

    def __init__(self, status_code, message, url=""):
        self.status_code = status_code
        self.message = message
        self.url = url
        super().__init__(f"[{status_code}] {message} ({url})")


class Client:
    """Experience Engine REST API client.

    Args:
        base_url: Server URL (default: http://localhost:8082)
        timeout: Request timeout in seconds (default: 30)
    """

    def __init__(self, base_url="http://localhost:8082", timeout=30):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _request(self, method, path, body=None, params=None):
        """Make HTTP request and return parsed JSON response."""
        url = f"{self.base_url}{path}"
        if params:
            url += "?" + urlencode({k: v for k, v in params.items() if v is not None})

        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = Request(url, data=data, headers=headers, method=method)

        try:
            with urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            try:
                err_body = json.loads(e.read().decode("utf-8"))
                msg = err_body.get("error", str(e))
            except Exception:
                msg = str(e)
            raise ExperienceAPIError(e.code, msg, url) from e
        except URLError as e:
            raise ExperienceAPIError(0, f"Connection failed: {e.reason}", url) from e

    def health(self):
        """GET /health — Qdrant + FileStore status."""
        return self._request("GET", "/health")

    def intercept(self, tool_name, tool_input=None):
        """POST /api/intercept — Query experience before tool call.

        Args:
            tool_name: Name of the tool being called (e.g., "Write", "Edit", "Bash")
            tool_input: Tool input dict (e.g., {"file_path": "app.py"})

        Returns:
            dict with 'suggestions' (str|None) and 'hasSuggestions' (bool)
        """
        return self._request("POST", "/api/intercept", {
            "toolName": tool_name,
            "toolInput": tool_input or {},
        })

    def extract(self, transcript, project_path=None):
        """POST /api/extract — Extract lessons from session transcript.

        Args:
            transcript: Session transcript text
            project_path: Optional project path for context

        Returns:
            dict with 'stored' (int) and 'success' (bool)
        """
        body = {"transcript": transcript}
        if project_path:
            body["projectPath"] = project_path
        return self._request("POST", "/api/extract", body)

    def evolve(self, trigger="api"):
        """POST /api/evolve — Trigger evolution cycle.

        Args:
            trigger: Trigger label (default: "api")

        Returns:
            dict with 'promoted', 'abstracted', 'demoted', 'archived', 'success'
        """
        return self._request("POST", "/api/evolve", {"trigger": trigger})

    def stats(self, since="7d", all_time=False):
        """GET /api/stats — Observability data.

        Args:
            since: Time window (e.g., "7d", "30d")
            all_time: If True, return all-time stats

        Returns:
            dict with totalIntercepts, suggestions, top5, etc.
        """
        params = {}
        if all_time:
            params["all"] = "true"
        else:
            params["since"] = since
        return self._request("GET", "/api/stats", params=params)

    def graph(self, experience_id):
        """GET /api/graph — Edges for a given experience ID.

        Args:
            experience_id: UUID of the experience

        Returns:
            dict with 'id', 'edges' (list), 'count'
        """
        return self._request("GET", "/api/graph", params={"id": experience_id})

    def timeline(self, topic):
        """GET /api/timeline — Chronological view of knowledge evolution.

        Args:
            topic: Topic to search for

        Returns:
            dict with 'topic', 'timeline' (list), 'count'
        """
        return self._request("GET", "/api/timeline", params={"topic": topic})

    def user(self):
        """GET /api/user — Current user identity.

        Returns:
            dict with 'user' (str)
        """
        return self._request("GET", "/api/user")

    def share_principle(self, principle_id):
        """POST /api/principles/share — Export a principle as portable JSON.

        Args:
            principle_id: UUID of the principle to share

        Returns:
            dict with 'shared' (portable principle data) and 'success'
        """
        return self._request("POST", "/api/principles/share", {
            "principleId": principle_id,
        })

    def import_principle(self, shared):
        """POST /api/principles/import — Import a shared principle.

        Args:
            shared: dict with 'principle'/'solution', 'confidence', 'domain', etc.

        Returns:
            dict with 'imported' (id + principle) and 'success'
        """
        return self._request("POST", "/api/principles/import", shared)
