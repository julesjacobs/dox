import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import { createCollaborationServer, mergeProjectText } from "./server.mjs";

const waitFor = async (predicate, message, timeout = 3000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};

async function fakeDoxServer({ token, source: initialSource }) {
  let source = initialSource;
  let revision = 1;
  const digest = () => `digest-${revision}`;
  const projectVersion = () => `project-${revision}`;
  const server = http.createServer(async (request, response) => {
    const reply = (status, value) => {
      const body = JSON.stringify(value);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    };
    if (request.headers["x-dox-token"] !== token) {
      reply(401, { error: "bad token" });
      return;
    }
    if (request.method === "GET" && request.url.startsWith("/api/page?")) {
      reply(200, {
        module: "Test",
        digest: digest(),
        projectVersion: projectVersion(),
        document: { path: "test.ml.md", source, version: digest() },
      });
      return;
    }
    if (request.method === "GET" && request.url === "/api/project") {
      reply(200, { version: projectVersion() });
      return;
    }
    if (request.method === "PUT" && request.url === "/api/page/source") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (input.expectedDigest !== digest()) {
        reply(409, { error: "changed" });
        return;
      }
      source = input.source;
      revision += 1;
      reply(200, {
        digest: digest(),
        projectVersion: projectVersion(),
        document: { path: "test.ml.md", source, version: digest() },
      });
      return;
    }
    reply(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    get source() { return source; },
    externalEdit(next) { source = next; revision += 1; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const synced = (provider) => new Promise((resolve) => {
  if (provider.synced) resolve();
  else provider.once("sync", (value) => { if (value) resolve(); });
});

test("three-way merge preserves non-overlap and marks overlap", () => {
  assert.deepEqual(mergeProjectText("A!\nB\n", "A\nB\n", "A\nB?\n"), {
    text: "A!\nB?\n",
    conflict: false,
  });
  const overlap = mergeProjectText("A-live\n", "A\n", "A-git\n");
  assert.equal(overlap.conflict, true);
  assert.match(overlap.text, /<<<<<<< live Dox document/);
  assert.match(overlap.text, /-live/);
  assert.match(overlap.text, /-git/);
});

test("two clients converge, mirror through Dox, and ingest Git edits", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dox-collab-"));
  await fs.writeFile(path.join(root, "test.ml.md"), "# Test\n\nhello\n");
  const token = "test-collaboration-token";
  const dox = await fakeDoxServer({ token, source: "# Test\n\nhello\n" });
  const collab = await createCollaborationServer({
    root,
    token,
    doxPort: dox.port,
    origins: [],
    flushDelay: 5,
    pollInterval: 20,
  });
  t.after(async () => {
    await collab.close();
    await dox.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const opened = await collab.openDocument({
    path: "test.ml.md",
    module: "Test",
    source: dox.source,
    digest: "digest-1",
    projectVersion: "project-1",
  });
  const makeClient = () => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(
      `ws://127.0.0.1:${collab.port}/document`,
      opened.id,
      doc,
      {
        WebSocketPolyfill: WebSocket,
        params: { token },
        disableBc: true,
      },
    );
    return { doc, text: doc.getText("source"), provider };
  };
  const first = makeClient();
  const second = makeClient();
  t.after(() => {
    first.provider.destroy();
    second.provider.destroy();
    first.doc.destroy();
    second.doc.destroy();
  });
  await Promise.all([synced(first.provider), synced(second.provider)]);
  assert.equal(first.text.toString(), "# Test\n\nhello\n");
  first.text.insert(first.text.length, "from one\n");
  second.text.insert(second.text.length, "from two\n");
  await waitFor(
    () => first.text.toString() === second.text.toString(),
    "clients did not converge",
  );
  await collab.flushAll();
  assert.equal(dox.source, first.text.toString());

  dox.externalEdit(dox.source.replace("hello", "hello from Git"));
  await waitFor(
    () => first.text.toString().includes("hello from Git") &&
      second.text.toString().includes("hello from Git"),
    "external edit did not reach both clients",
  );
  assert.equal(first.text.toString(), second.text.toString());
});

test("project mutation leases hold live edits until the filesystem mutation finishes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dox-collab-pause-"));
  await fs.writeFile(path.join(root, "test.ml.md"), "seed");
  const token = "pause-token";
  const dox = await fakeDoxServer({ token, source: "seed" });
  const collab = await createCollaborationServer({
    root, token, doxPort: dox.port, origins: [], flushDelay: 5,
  });
  t.after(async () => {
    await collab.close({ mirror: false });
    await dox.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const opened = await collab.openDocument({
    path: "test.ml.md", module: "Test", source: "seed",
    digest: "digest-1", projectVersion: "project-1",
  });
  const clientDoc = new Y.Doc();
  const provider = new WebsocketProvider(
    `ws://127.0.0.1:${collab.port}/document`, opened.id, clientDoc,
    { WebSocketPolyfill: WebSocket, params: { token }, disableBc: true },
  );
  t.after(() => {
    provider.destroy();
    clientDoc.destroy();
  });
  await synced(provider);
  const simultaneous = await Promise.allSettled([
    collab.pauseProject(),
    collab.pauseProject(),
  ]);
  assert.deepEqual(simultaneous.map(({ status }) => status).sort(), [
    "fulfilled",
    "rejected",
  ]);
  const lease = simultaneous.find(({ status }) => status === "fulfilled").value.lease;
  await waitFor(() => !provider.wsconnected, "provider stayed connected through pause");
  clientDoc.getText("source").insert(4, " live");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(dox.source, "seed");
  await assert.rejects(collab.pauseProject(), /holds the collaboration lease/);
  await assert.rejects(collab.resumeProject("wrong-lease"), /Invalid collaboration/);
  await collab.resumeProject(lease);
  await waitFor(() => provider.wsconnected, "provider did not reconnect after resume");
  await waitFor(() => dox.source === "seed live", "paused edit was not mirrored after resume");
});

test("restart retains Yjs identity and stale clients cannot duplicate text", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dox-collab-restart-"));
  await fs.writeFile(path.join(root, "test.ml.md"), "seed");
  const token = "restart-token";
  const dox = await fakeDoxServer({ token, source: "seed" });
  t.after(async () => {
    await dox.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const firstServer = await createCollaborationServer({
    root, token, doxPort: dox.port, origins: [], flushDelay: 5,
  });
  const opened = await firstServer.openDocument({
    path: "test.ml.md", module: "Test", source: "seed", digest: "digest-1", projectVersion: "project-1",
  });
  const staleDoc = new Y.Doc();
  const staleProvider = new WebsocketProvider(
    `ws://127.0.0.1:${firstServer.port}/document`, opened.id, staleDoc,
    { WebSocketPolyfill: WebSocket, params: { token }, disableBc: true },
  );
  await synced(staleProvider);
  staleDoc.getText("source").insert(4, " once");
  await waitFor(
    () => firstServer.rooms.get(opened.id).text.toString() === "seed once",
    "server did not receive the client update",
  );
  await firstServer.flushAll();
  staleProvider.destroy();
  await firstServer.close();

  const secondServer = await createCollaborationServer({
    root, token, doxPort: dox.port, origins: [], flushDelay: 5,
  });
  t.after(() => secondServer.close({ mirror: false }));
  const reopened = await secondServer.openDocument({
    path: "test.ml.md", module: "Test", source: dox.source,
    digest: "digest-2", projectVersion: "project-2",
  });
  assert.equal(reopened.id, opened.id);
  const reconnect = new WebsocketProvider(
    `ws://127.0.0.1:${secondServer.port}/document`, opened.id, staleDoc,
    { WebSocketPolyfill: WebSocket, params: { token }, disableBc: true },
  );
  await synced(reconnect);
  await waitFor(() => staleDoc.getText("source").toString() === "seed once", "restart diverged");
  assert.equal(staleDoc.getText("source").toString(), "seed once");
  reconnect.destroy();
  staleDoc.destroy();
});

test("renames retain identity and deletion tombstones old generations", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dox-collab-identity-"));
  await fs.writeFile(path.join(root, "old.ml.md"), "seed");
  const token = "identity-token";
  const dox = await fakeDoxServer({ token, source: "seed" });
  const collab = await createCollaborationServer({
    root, token, doxPort: dox.port, origins: [],
  });
  t.after(async () => {
    await collab.close({ mirror: false });
    await dox.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const original = await collab.openDocument({
    path: "old.ml.md", module: "Old", source: "seed",
    digest: "digest-1", projectVersion: "project-1",
  });
  await collab.rebindDocuments([{
    beforePath: "old.ml.md", afterPath: "new.ml.md",
    beforeModule: "Old", afterModule: "New",
  }]);
  const renamed = await collab.openDocument({
    path: "new.ml.md", module: "New", source: "seed",
    digest: "digest-1", projectVersion: "project-1",
  });
  assert.equal(renamed.id, original.id);
  await collab.tombstoneDocuments(["new.ml.md"]);
  const replacement = await collab.openDocument({
    path: "new.ml.md", module: "New", source: "seed",
    digest: "digest-1", projectVersion: "project-1",
  });
  assert.notEqual(replacement.id, original.id);
});

test("a cyclic rename preserves every room identity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dox-collab-swap-"));
  await Promise.all([
    fs.writeFile(path.join(root, "a.ml.md"), "a"),
    fs.writeFile(path.join(root, "b.ml.md"), "b"),
  ]);
  const token = "swap-token";
  const dox = await fakeDoxServer({ token, source: "a" });
  const collab = await createCollaborationServer({
    root, token, doxPort: dox.port, origins: [],
  });
  t.after(async () => {
    await collab.close({ mirror: false });
    await dox.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const a = await collab.openDocument({
    path: "a.ml.md", module: "A", source: "a",
    digest: "a-1", projectVersion: "project-1",
  });
  const b = await collab.openDocument({
    path: "b.ml.md", module: "B", source: "b",
    digest: "b-1", projectVersion: "project-1",
  });
  await collab.rebindDocuments([
    { beforePath: "a.ml.md", afterPath: "b.ml.md", beforeModule: "A", afterModule: "B" },
    { beforePath: "b.ml.md", afterPath: "a.ml.md", beforeModule: "B", afterModule: "A" },
  ]);
  const newA = await collab.openDocument({
    path: "a.ml.md", module: "A", source: "b",
    digest: "b-1", projectVersion: "project-1",
  });
  const newB = await collab.openDocument({
    path: "b.ml.md", module: "B", source: "a",
    digest: "a-1", projectVersion: "project-1",
  });
  assert.equal(newA.id, b.id);
  assert.equal(newB.id, a.id);
});

test("restart preserves an overlapping live and Git conflict", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dox-collab-conflict-"));
  await fs.writeFile(path.join(root, "test.ml.md"), "seed");
  const token = "conflict-token";
  const dox = await fakeDoxServer({ token, source: "seed" });
  t.after(async () => {
    await dox.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const first = await createCollaborationServer({
    root, token, doxPort: dox.port, origins: [], flushDelay: 10_000,
  });
  const opened = await first.openDocument({
    path: "test.ml.md", module: "Test", source: "seed",
    digest: "digest-1", projectVersion: "project-1",
  });
  first.rooms.get(opened.id).text.insert(4, "-live");
  await first.close({ mirror: false });
  dox.externalEdit("seed-git");
  const second = await createCollaborationServer({
    root, token, doxPort: dox.port, origins: [],
  });
  t.after(() => second.close({ mirror: false }));
  await second.openDocument({
    path: "test.ml.md", module: "Test", source: dox.source,
    digest: "digest-2", projectVersion: "project-2",
  });
  const room = second.rooms.get(opened.id);
  assert.equal(room.conflict, true);
  assert.match(room.text.toString(), /<<<<<<< live Dox document/);
  await assert.rejects(second.flushAll(), /overlap|conflict/i);
});

test("restart treats durable conflict markers conservatively after a metadata crash", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dox-collab-crash-conflict-"));
  await fs.writeFile(path.join(root, "test.ml.md"), "seed");
  const token = "crash-conflict-token";
  const dox = await fakeDoxServer({ token, source: "seed" });
  t.after(async () => {
    await dox.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const first = await createCollaborationServer({
    root, token, doxPort: dox.port, origins: [], flushDelay: 10_000,
  });
  const opened = await first.openDocument({
    path: "test.ml.md", module: "Test", source: "seed",
    digest: "digest-1", projectVersion: "project-1",
  });
  const markers = [
    "<<<<<<< live Dox document", "live", "||||||| last mirrored version",
    "seed", "======= Dox Git working tree", "git", ">>>>>>> Git working tree",
  ].join("\n");
  const room = first.rooms.get(opened.id);
  room.doc.transact(() => {
    room.text.delete(0, room.text.length);
    room.text.insert(0, markers);
  });
  await waitFor(() => room.conflict, "client conflict markers were not recognized");
  await first.close({ mirror: false });
  const controlPath = path.join(root, ".dox", "collaboration", `${opened.id}.json`);
  const control = JSON.parse(await fs.readFile(controlPath, "utf8"));
  control.conflict = false;
  control.error = null;
  await fs.writeFile(controlPath, `${JSON.stringify(control)}\n`);

  const second = await createCollaborationServer({
    root, token, doxPort: dox.port, origins: [],
  });
  t.after(() => second.close({ mirror: false }));
  await second.openDocument({
    path: "test.ml.md", module: "Test", source: dox.source,
    digest: "digest-1", projectVersion: "project-1",
  });
  assert.equal(second.rooms.get(opened.id).conflict, true);
  await assert.rejects(second.flushAll(), /overlap|conflict/i);
});
