**0.5.2 is a packaging release. Nothing about how AgentBridge behaves changed.**

The 0.5.1 zip could not be installed. The manifest declared `icons/icon16.png` and the archive
carried `icon16.png` at the root, so Chrome refused to load the extension. It was zipped by hand;
0.5.2 is produced by `pack.mjs`, which refuses to finish if the archive is missing any path the
manifest names, and `test/package.mjs` opens the result and holds it to the manifest the way the
browser does.

Two downloads, on purpose:

- **`agentbridge-0.5.2.zip`** — the extension only. This is the file the Chrome Web Store takes.
- **`agentbridge-0.5.2-bundle.zip`** — the extension *and* `bridge-server.mjs` *and*
  `START-HERE.md`. The extension is half the product: it needs the local server, and until now the
  release never carried it, so installing from the store gave you a popup that said "disconnected"
  with no way to fix it. Unzip, `node bridge-server.mjs`, load the folder, paste the key.

Also in this release: the popup opens on *Bridge: checking…* instead of claiming *disconnected*
before the service worker has answered (measured: it showed disconnected for ~0.9 s while the
bridge was connected), and the README states the server requirement with a one-line download.

Verified: `server-self-test` 8/8 · `test/package.mjs` 15/15 on both archives.
