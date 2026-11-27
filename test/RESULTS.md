# AgentBridge E2E Results — 2026-11-27

Run at: Fri Nov 27 2026 11:10:25 GMT+0000 (Coordinated Universal Time)
Chrome: /root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome
Extension: /workspace/promi/scratch/ab-check
Bridge: ws://127.0.0.1:8788

| Scenario | Result | Detail |
|---|---|---|
| server listening | PASS |  |
| extension SW attached | PASS | chrome-extension://ahfkaleikmemfcdbomhmfomnhfdcpjho/background.js |
| extension hello on bridge | PASS |  |
| main tab navigated to test page | PASS | http://127.0.0.1:8799/ |
| readTab approved -> {title,url} | PASS | ({"title":"AgentBridge E2E Test Page","url":"http://127.0.0.1:8799/"}) |
| deny -> denied by user | PASS | ({"type":"result","id":"e2e-1795777829148-ork9m","ok":false,"error":"denied by user"}) |
| writeClipboard approved -> ok | PASS | ({"ok":true}) |
| readClipboard roundtrip matches | PASS | ({"text":"agentbridge-e2e-roundtrip"}) |
| inject -> field contains text | PASS | (field="agentbridge-injected", res={"ok":true,"characters":20,"field":"input"}) |

**TOTAL: 9/9 passed**
