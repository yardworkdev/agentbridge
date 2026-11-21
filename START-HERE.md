# AgentBridge — start here

You have two halves: a Chrome extension and a small server that runs on your own machine.
The extension is useless without the server, and the server is useless without the extension.

1. **Unzip this bundle** somewhere you will keep it (it is the extension folder *and* the server).

2. **Start the bridge.** Needs Node.js 20 or newer. In this folder:

   ```sh
   node bridge-server.mjs
   ```

   The first run creates `~/.agentbridge/keys.json` (mode 600) and prints two secrets once:
   an **agent token** and an **extension key**. Leave it running.

3. **Load the extension.** Open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked**, and choose this same folder. (Or install it from the Chrome Web Store.)

4. **Paste the extension key** into the AgentBridge popup and click **Save token**. The popup
   turns green: *Bridge: connected*.

5. **Connect an agent.** Any WebSocket client can do it: connect to `ws://127.0.0.1:8788`,
   send `{"type":"hello","role":"agent","name":"mine","token":"<agent token>"}`, then send
   `{"type":"action","id":"1","action":"readTab","params":{}}`. The request appears in your
   popup; nothing happens until you press **Approve**.

Nothing leaves your machine: the server listens on `127.0.0.1` only, and the extension makes no
network requests of its own.
