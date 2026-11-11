# AgentBridge E2E Results — 2026-08-14

Chrome: /root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome
Extension: /workspace/promi/work/ab-review
Bridge: ws://127.0.0.1:8788

| Scenario | Result | Detail |
|---|---|---|
| server listening | PASS |  |
| extension SW attached | PASS | chrome-extension://olocjbphngmbjiiacdmnoicaomjmdhhn/background.js |
| extension hello on bridge | PASS |  |
| main tab navigated to test page | PASS | http://127.0.0.1:8799/ |
| readTab approved -> {title,url} | PASS | ({"title":"AgentBridge E2E Test Page","url":"http://127.0.0.1:8799/"}) |
| deny -> denied by user | PASS | ({"type":"result","id":"e2e-1794395513073-frgop","ok":false,"error":"denied by user"}) |
| writeClipboard approved -> ok | PASS | ({"ok":true}) |
| readClipboard roundtrip matches | PASS | ({"text":"agentbridge-e2e-roundtrip"}) |
| inject -> field contains text | PASS | (field="agentbridge-injected", res={"ok":true,"characters":20,"field":"input"}) |

**TOTAL: 9/9 passed**
