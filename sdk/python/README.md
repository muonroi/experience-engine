# muonroi-experience

Python client for the [Experience Engine](https://github.com/muonroi/experience-engine)
REST API. Standard library only — no dependencies.

```bash
pip install muonroi-experience
```

```python
from muonroi_experience import Client, ExperienceAPIError

client = Client("http://localhost:8082", token="<server.authToken>")  # token optional

hints = client.intercept("Write", {"file_path": "app.py"})
client.feedback("experience-behavioral", "<point-id>", "FOLLOWED")
print(client.stats(since="7d"))
```

The token can also come from the `EXPERIENCE_SERVER_TOKEN` environment variable.
Errors raise `ExperienceAPIError` with `status_code` and `message`.

Tests need a running server: `node server.js`, then `python test_client.py`.
