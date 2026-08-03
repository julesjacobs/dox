import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import DiffMatchPatch from "diff-match-patch";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { diff3Merge } from "node-diff3";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { WebSocketServer } from "ws";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;
const SERVER_ORIGIN = Symbol("dox-collaboration-server");
const MIRROR_ORIGIN = Symbol("dox-project-mirror");
const dmp = new DiffMatchPatch();

function parseArguments(argv) {
  const result = {
    host: "127.0.0.1",
    port: 0,
    doxPort: 0,
    root: null,
    origin: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case "--host": result.host = value; index += 1; break;
      case "--port": result.port = Number(value); index += 1; break;
      case "--dox-port": result.doxPort = Number(value); index += 1; break;
      case "--root": result.root = value; index += 1; break;
      case "--origin": result.origin.push(value); index += 1; break;
      default: throw new Error(`Unknown collaboration option: ${argv[index]}`);
    }
  }
  if (!result.root) throw new Error("Missing --root for collaboration server.");
  for (const [name, value] of [["port", result.port], ["Dox port", result.doxPort]]) {
    if (!Number.isInteger(value) || value < 0 || value > 65535) {
      throw new Error(`Invalid ${name}.`);
    }
  }
  return result;
}

async function atomicWrite(filename, bytes) {
  const directory = path.dirname(filename);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.dox-write-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  try {
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function safeRelativePath(root, relative) {
  if (
    typeof relative !== "string" ||
    relative.includes("\0") ||
    path.isAbsolute(relative) ||
    !relative.endsWith(".ml.md")
  ) {
    throw new Error("Invalid Dox collaboration document path.");
  }
  const absolute = path.resolve(root, relative);
  const resolvedRelative = path.relative(root, absolute);
  if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
    throw new Error("Collaboration document escapes the project root.");
  }
  return relative.split(path.sep).join("/");
}

function applyText(text, next, origin) {
  const current = text.toString();
  if (current === next) return;
  const changes = dmp.diff_main(current, next);
  dmp.diff_cleanupEfficiency(changes);
  text.doc.transact(() => {
    let offset = 0;
    for (const [kind, value] of changes) {
      if (kind === DiffMatchPatch.DIFF_EQUAL) offset += value.length;
      else if (kind === DiffMatchPatch.DIFF_DELETE) text.delete(offset, value.length);
      else if (kind === DiffMatchPatch.DIFF_INSERT) {
        text.insert(offset, value);
        offset += value.length;
      }
    }
  }, origin);
}

export function mergeProjectText(live, base, disk) {
  if (live === base) return { text: disk, conflict: false };
  if (disk === base || live === disk) return { text: live, conflict: false };
  const regions = diff3Merge(Array.from(live), Array.from(base), Array.from(disk), {
    excludeFalseConflicts: true,
  });
  let conflict = false;
  let text = "";
  for (const region of regions) {
    if (region.ok) text += region.ok.join("");
    else {
      conflict = true;
      const value = region.conflict;
      text += [
        "<<<<<<< live Dox document\n",
        value.a.join(""),
        "\n||||||| last mirrored version\n",
        value.o.join(""),
        "\n======= Dox Git working tree\n",
        value.b.join(""),
        "\n>>>>>>> Git working tree\n",
      ].join("");
    }
  }
  return { text, conflict };
}

function hasConflictMarkers(source) {
  return /^(?:<<<<<<< live Dox document|\|\|\|\|\|\|\| last mirrored version|======= Dox Git working tree|>>>>>>> Git working tree)$/m.test(source);
}

function send(connection, message) {
  if (connection.readyState === connection.OPEN) connection.send(message);
}

// Handles one inbound client message for either transport. `connection` only
// needs readyState/OPEN/send, so an SSE subscriber works here too.
function applyClientMessage(room, connection, bytes) {
  const decoder = decoding.createDecoder(bytes);
  const messageType = decoding.readVarUint(decoder);
  if (messageType === MESSAGE_SYNC) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, room.doc, connection);
    if (encoding.length(encoder) > 1) send(connection, encoding.toUint8Array(encoder));
  } else if (messageType === MESSAGE_AWARENESS) {
    const update = decoding.readVarUint8Array(decoder);
    const controlled = room.controlledIds.get(connection);
    if (controlled) for (const id of awarenessClientIds(update)) controlled.add(id);
    awarenessProtocol.applyAwarenessUpdate(room.awareness, update, connection);
  } else if (messageType === MESSAGE_QUERY_AWARENESS) {
    send(connection, encodeAwarenessMessage(
      room.awareness,
      Array.from(room.awareness.getStates().keys()),
    ));
  }
}

// One SSE subscriber, shaped like a WebSocket connection as far as send() and
// the broadcast paths are concerned. Frames are base64 because SSE is text.
function createEventStreamConnection(response) {
  const connection = {
    OPEN: 1,
    readyState: 1,
    isAlive: true,
    send(message) {
      if (connection.readyState !== connection.OPEN) return;
      const payload = Buffer.from(message).toString("base64");
      try {
        response.write(`data: ${payload}\n\n`);
      } catch {
        connection.readyState = 3;
      }
    },
    close() {
      if (connection.readyState === 3) return;
      connection.readyState = 3;
      try {
        response.end();
      } catch {
        /* already gone */
      }
    },
  };
  return connection;
}

function encodeAwarenessMessage(awareness, clientIds) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, clientIds),
  );
  return encoding.toUint8Array(encoder);
}

function awarenessClientIds(update) {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder);
    decoding.readVarString(decoder);
  }
  return ids;
}

function constantTimeEqual(left, right) {
  const leftBytes = Buffer.from(left || "");
  const rightBytes = Buffer.from(right || "");
  if (leftBytes.length !== rightBytes.length) return false;
  return crypto.timingSafeEqual(leftBytes, rightBytes);
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request, limit = 16_000_000) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error("Collaboration request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export async function createCollaborationServer({
  root,
  host = "127.0.0.1",
  port = 0,
  doxPort,
  token,
  origins = [],
  flushDelay = 45,
  pollInterval = 220,
} = {}) {
  if (!token) throw new Error("A collaboration token is required.");
  if (!doxPort) throw new Error("The Dox HTTP port is required.");
  root = await fs.realpath(root);
  const stateRoot = path.join(root, ".dox", "collaboration");
  const registryPath = path.join(stateRoot, "registry.json");
  await fs.mkdir(stateRoot, { recursive: true });
  let registry = { version: 1, documents: {} };
  try {
    registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const rooms = new Map();
  const presence = new Map();
  let projectPollingPaused = null;

  const releaseProjectPause = (leaseId) => {
    if (!projectPollingPaused || projectPollingPaused.id !== leaseId) return false;
    projectPollingPaused = null;
    for (const room of rooms.values()) {
      if (room.pendingMirror && !room.tombstoned) room.scheduleMirror(0);
    }
    return true;
  };
  const idsByPath = new Map();
  for (const [id, entry] of Object.entries(registry.documents || {})) {
    if (!entry.tombstoned) idsByPath.set(entry.path, id);
  }
  let registryWrite = Promise.resolve();
  const saveRegistry = () => {
    registryWrite = registryWrite.then(() =>
      atomicWrite(registryPath, `${JSON.stringify(registry, null, 2)}\n`),
    );
    return registryWrite;
  };

  const doxApi = async (url, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${doxPort}${url}`, {
      ...options,
      signal: options.signal || AbortSignal.timeout(5_000),
      headers: {
        "content-type": "application/json",
        "x-dox-token": token,
        ...(options.headers || {}),
      },
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error || `Dox request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return payload;
  };

  const publishMeta = (room) => {
    room.doc.transact(() => {
      room.meta.set("path", room.path);
      room.meta.set("module", room.module);
      room.meta.set("digest", room.digest);
      room.meta.set("projectVersion", room.projectVersion);
      room.meta.set("conflict", room.conflict);
      room.meta.set("error", room.error);
      room.meta.set("tombstoned", room.tombstoned);
    }, SERVER_ORIGIN);
  };

  const persistState = (room) => {
    if (room.persistFailed) return room.stateWrite;
    room.stateWrite = room.stateWrite.then(() =>
      atomicWrite(room.statePath, Y.encodeStateAsUpdate(room.doc)),
    ).catch((error) => {
      room.persistFailed = true;
      room.error = `Could not persist collaboration state: ${error.message}`;
      publishMeta(room);
    });
    return room.stateWrite;
  };

  const persistControl = (room) => {
    const value = {
      version: 1,
      path: room.path,
      module: room.module,
      baseText: room.baseText,
      digest: room.digest,
      projectVersion: room.projectVersion,
      conflict: room.conflict,
      error: room.error,
      tombstoned: room.tombstoned,
    };
    room.controlWrite = room.controlWrite
      .then(() => atomicWrite(room.controlPath, `${JSON.stringify(value)}\n`))
      .catch((error) => {
        room.error = `Could not persist collaboration metadata: ${error.message}`;
      });
    return room.controlWrite;
  };

  const transition = (room, operation) => {
    const result = room.transition.catch(() => {}).then(operation);
    room.transition = result.catch(() => {});
    return result;
  };

  const loadRoom = async (id, initial = null) => {
    if (rooms.has(id)) return rooms.get(id);
    const entry = registry.documents[id];
    if (!entry || entry.tombstoned) throw new Error("Unknown collaboration document.");
    if (!initial) throw new Error("Collaboration document has not been opened.");
    const doc = new Y.Doc();
    const statePath = path.join(stateRoot, `${id}.yjs`);
    const controlPath = path.join(stateRoot, `${id}.json`);
    let control = null;
    try {
      control = JSON.parse(await fs.readFile(controlPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      Y.applyUpdate(doc, new Uint8Array(await fs.readFile(statePath)), SERVER_ORIGIN);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const text = doc.getText("source");
    const meta = doc.getMap("dox:meta");
    const previousBase = typeof control?.baseText === "string"
      ? control.baseText
      : initial.source;
    let recovered = { text: initial.source, conflict: false };
    if (text.length === 0 && initial.source.length) {
      text.insert(0, initial.source);
    } else if (text.toString() !== initial.source) {
      recovered = mergeProjectText(text.toString(), previousBase, initial.source);
      applyText(text, recovered.text, MIRROR_ORIGIN);
    }
    const awareness = new awarenessProtocol.Awareness(doc);
    const room = {
      id,
      path: entry.path,
      module: entry.module,
      statePath,
      controlPath,
      doc,
      text,
      meta,
      awareness,
      connections: new Set(),
      controlledIds: new Map(),
      baseText: initial.source,
      digest: initial.digest,
      projectVersion: initial.projectVersion,
      revision: 0,
      conflict: recovered.conflict || hasConflictMarkers(text.toString()),
      error: null,
      tombstoned: false,
      flushTimer: null,
      mirrorPromise: Promise.resolve(),
      stateWrite: Promise.resolve(),
      persistFailed: false,
      pendingMirror: false,
      controlWrite: Promise.resolve(),
      transition: Promise.resolve(),
    };
    if (room.conflict) {
      room.error = "Live and Git edits overlap. Resolve the conflict markers in the document.";
    }
    rooms.set(id, room);

    const mirror = async () => {
      if (room.tombstoned || room.conflict) return;
      if (projectPollingPaused?.phase === "paused") {
        room.pendingMirror = true;
        return;
      }
      const source = room.text.toString();
      if (source === room.baseText) return;
      try {
        const payload = await doxApi("/api/page/source", {
          method: "PUT",
          body: JSON.stringify({
            module: room.module,
            source,
            expectedDigest: room.digest,
            editRevision: ++room.revision,
          }),
        });
        await persistState(room);
        if (room.persistFailed) {
          throw new Error(room.error);
        }
        room.baseText = source;
        room.digest = payload.digest;
        room.projectVersion = payload.projectVersion || payload.project?.version;
        room.error = null;
        room.pendingMirror = false;
        publishMeta(room);
        await persistControl(room);
        if (room.text.toString() !== source) scheduleMirror(room, 0);
      } catch (error) {
        if (error.status !== 409) {
          room.error = error.message;
          publishMeta(room);
          await persistControl(room);
          return;
        }
        try {
          const latest = await doxApi(`/api/page?module=${encodeURIComponent(room.module)}`);
          const project = await doxApi("/api/project");
          const disk = latest.document.source;
          const merged = mergeProjectText(room.text.toString(), room.baseText, disk);
          applyText(room.text, merged.text, MIRROR_ORIGIN);
          await persistState(room);
          if (room.persistFailed) {
            throw new Error(room.error);
          }
          room.baseText = disk;
          room.digest = latest.digest || latest.document.version;
          room.projectVersion = project.version;
          room.conflict = merged.conflict;
          room.error = merged.conflict
            ? "Live and Git edits overlap. Resolve the conflict markers in the document."
            : null;
          publishMeta(room);
          await persistControl(room);
          if (!merged.conflict) scheduleMirror(room, 0);
        } catch (refreshError) {
          room.error = refreshError.message;
          publishMeta(room);
          await persistControl(room);
        }
      }
    };

    const scheduleMirror = (target, delay = flushDelay) => {
      if (projectPollingPaused?.phase === "paused") {
        target.pendingMirror = true;
        return;
      }
      clearTimeout(target.flushTimer);
      target.flushTimer = setTimeout(() => {
        target.mirrorPromise = transition(target, mirror);
      }, delay);
    };
    room.scheduleMirror = (delay) => scheduleMirror(room, delay);
    room.flush = () => {
      clearTimeout(room.flushTimer);
      room.mirrorPromise = transition(room, mirror);
      return room.mirrorPromise;
    };

    doc.on("update", (update) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const connection of room.connections) send(connection, message);
      persistState(room);
    });
    text.observe(() => {
      const marked = hasConflictMarkers(text.toString());
      if (marked || room.conflict) {
        void transition(room, async () => {
          await persistState(room);
          if (room.persistFailed) return;
          room.conflict = marked;
          room.error = marked
            ? "Live and Git edits overlap. Resolve the conflict markers in the document."
            : null;
          publishMeta(room);
          await persistControl(room);
          if (!marked) room.scheduleMirror(0);
        });
        return;
      }
      room.scheduleMirror();
    });
    awareness.on("update", ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      if (!changed.length) return;
      const message = encodeAwarenessMessage(awareness, changed);
      for (const connection of room.connections) {
        if (connection !== origin) send(connection, message);
      }
    });
    publishMeta(room);
    await persistState(room);
    if (room.persistFailed) throw new Error(room.error);
    await persistControl(room);
    if (!room.conflict && room.text.toString() !== room.baseText) {
      room.scheduleMirror(0);
    }
    return room;
  };

  const openDocument = async (input) => {
    const documentPath = safeRelativePath(root, input.path);
    let id = idsByPath.get(documentPath);
    if (!id) {
      id = crypto.randomUUID();
      registry.documents[id] = {
        path: documentPath,
        module: input.module,
        generation: 1,
        tombstoned: false,
      };
      idsByPath.set(documentPath, id);
      await saveRegistry();
    }
    const entry = registry.documents[id];
    entry.module = input.module;
    const room = await loadRoom(id, input);
    await transition(room, async () => {
      if (room.digest !== input.digest) {
        const merged = mergeProjectText(
          room.text.toString(),
          room.baseText,
          input.source,
        );
        applyText(room.text, merged.text, MIRROR_ORIGIN);
        await persistState(room);
        if (room.persistFailed) throw new Error(room.error);
        room.baseText = input.source;
        room.digest = input.digest;
        room.projectVersion = input.projectVersion;
        room.conflict = merged.conflict;
        room.error = merged.conflict
          ? "Live and Git edits overlap. Resolve the conflict markers in the document."
          : null;
        if (!merged.conflict && merged.text !== input.source) room.scheduleMirror();
      }
      room.path = documentPath;
      room.module = input.module;
      publishMeta(room);
      await persistControl(room);
    });
    return { id, path: room.path, module: room.module };
  };

  const rebindDocuments = async (renames) => {
    const plan = (renames || []).map((rename) => ({
      ...rename,
      before: safeRelativePath(root, rename.beforePath),
      after: safeRelativePath(root, rename.afterPath),
      id: idsByPath.get(safeRelativePath(root, rename.beforePath)),
    }));
    for (const { before, id } of plan) {
      if (id) idsByPath.delete(before);
    }
    for (const { after, id } of plan) {
      if (id) idsByPath.set(after, id);
    }
    for (const rename of plan) {
      const { id } = rename;
      if (!id) continue;
      const entry = registry.documents[id];
      entry.path = rename.after;
      entry.module = rename.afterModule;
      const room = rooms.get(id);
      if (room) {
        await transition(room, async () => {
          room.path = rename.after;
          room.module = rename.afterModule;
          publishMeta(room);
          await persistControl(room);
        });
      }
    }
    await saveRegistry();
  };

  const tombstoneDocuments = async (paths) => {
    for (const value of paths || []) {
      const documentPath = safeRelativePath(root, value);
      const id = idsByPath.get(documentPath);
      if (!id) continue;
      idsByPath.delete(documentPath);
      const entry = registry.documents[id];
      entry.tombstoned = true;
      const room = rooms.get(id);
      if (room) {
        clearTimeout(room.flushTimer);
        await transition(room, async () => {
          room.tombstoned = true;
          room.error = "This page was deleted from the Dox project.";
          publishMeta(room);
          await persistControl(room);
          for (const connection of room.connections) {
            connection.close(4004, "This Dox page was deleted.");
          }
        });
      }
    }
    await saveRegistry();
  };

  const flushAll = async () => {
    for (const room of rooms.values()) {
      if (!room.tombstoned && !room.conflict) await room.flush();
      else await room.mirrorPromise;
      await room.stateWrite;
      await room.controlWrite;
    }
    const documents = Array.from(rooms.values(), (room) => ({
      id: room.id,
      path: room.path,
      digest: room.digest,
      projectVersion: room.projectVersion,
      conflict: room.conflict,
      error: room.error,
      tombstoned: room.tombstoned,
    }));
    const blocked = Array.from(rooms.values()).find((room) =>
      !room.tombstoned &&
      (room.conflict || room.error || room.text.toString() !== room.baseText)
    );
    if (blocked) {
      const error = new Error(
        blocked.error || `Could not mirror live edits for ${blocked.path}.`,
      );
      error.status = blocked.conflict ? 409 : 503;
      throw error;
    }
    return documents;
  };

  const pauseProject = async () => {
    if (projectPollingPaused) {
      const error = new Error("Another project mutation holds the collaboration lease.");
      error.status = 409;
      throw error;
    }
    const lease = crypto.randomUUID();
    projectPollingPaused = { id: lease, phase: "draining" };
    try {
      const documents = await flushAll();
      if (!projectPollingPaused || projectPollingPaused.id !== lease) {
        throw new Error("The collaboration mutation lease expired while draining edits.");
      }
      projectPollingPaused.phase = "paused";
      // Disconnect before acknowledging the filesystem barrier. Providers retain
      // their local Yjs updates and resynchronize after resume; no edit can be
      // accepted and then discarded by a concurrent page deletion.
      for (const connection of wss.clients) {
        connection.close(1012, "The Dox project is being reorganized.");
      }
      return { documents, lease };
    } catch (error) {
      releaseProjectPause(lease);
      throw error;
    }
  };

  const resumeProject = async (lease) => {
    if (!projectPollingPaused || lease !== projectPollingPaused.id) {
      const error = new Error("Invalid collaboration mutation lease.");
      error.status = 409;
      throw error;
    }
    releaseProjectPause(lease);
  };

  const applyClientUpdates = async (updates = []) => {
    if (!Array.isArray(updates) || updates.length > 64) {
      throw new Error("Invalid collaboration flush updates.");
    }
    for (const item of updates) {
      const room = rooms.get(item?.id);
      if (!room || room.tombstoned || typeof item.update !== "string") {
        throw new Error("Unknown collaboration document in flush.");
      }
      const bytes = Buffer.from(item.update, "base64");
      if (bytes.length > 10_000_000) {
        throw new Error("Collaboration flush update is too large.");
      }
      await transition(room, async () => {
        Y.applyUpdate(room.doc, new Uint8Array(bytes), SERVER_ORIGIN);
      });
    }
  };

  // Subscribers of the HTTP transport, keyed by a client-supplied id so a POST
  // can be attributed to the stream that opened it (needed so sync replies go
  // back to the right client and awareness ownership is tracked).
  const streamSubscribers = new Map();

  const streamRequestValid = (request, url, room) =>
    room &&
    !room.tombstoned &&
    constantTimeEqual(url.searchParams.get("token"), token) &&
    // A same-origin request sends no Origin header at all, which is the normal
    // case here; only reject an Origin that is present and not allowlisted.
    (!origins.length ||
      request.headers.origin === undefined ||
      origins.includes(request.headers.origin));

  async function handleStreamRoute(request, response, id, kind) {
    const url = new URL(request.url, "http://localhost");
    const room = rooms.get(id);
    if (!streamRequestValid(request, url, room)) {
      jsonResponse(response, 403, { error: "Forbidden" });
      return;
    }
    if (projectPollingPaused?.phase === "paused") {
      jsonResponse(response, 503, { error: "The Dox project is being reorganized." });
      return;
    }
    const subscriber = url.searchParams.get("sub");
    if (!subscriber) {
      jsonResponse(response, 400, { error: "Missing subscriber id." });
      return;
    }

    if (kind === "update") {
      if (request.method !== "POST") {
        jsonResponse(response, 405, { error: "Method not allowed." });
        return;
      }
      const connection = streamSubscribers.get(subscriber);
      if (!connection) {
        jsonResponse(response, 409, { error: "Unknown subscriber; reopen the stream." });
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        for (const frame of JSON.parse(body).messages || []) {
          applyClientMessage(room, connection, new Uint8Array(Buffer.from(frame, "base64")));
        }
      } catch {
        jsonResponse(response, 400, { error: "Invalid collaboration message." });
        return;
      }
      jsonResponse(response, 200, { ok: true });
      return;
    }

    if (request.method !== "GET") {
      jsonResponse(response, 405, { error: "Method not allowed." });
      return;
    }
    if (room.connections.size >= 32) {
      jsonResponse(response, 503, { error: "This document has too many collaborators." });
      return;
    }

    // Register before the headers go out: the client posts as soon as it sees
    // them, and a POST for an unregistered subscriber is rejected.
    const connection = createEventStreamConnection(response);
    streamSubscribers.set(subscriber, connection);
    room.connections.add(connection);
    room.controlledIds.set(connection, new Set());
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });

    // Same opening exchange the WebSocket path performs.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    send(connection, encoding.toUint8Array(encoder));
    send(
      connection,
      encodeAwarenessMessage(room.awareness, Array.from(room.awareness.getStates().keys())),
    );
    publishMeta(room);

    const keepAlive = setInterval(() => {
      if (connection.readyState !== connection.OPEN) return;
      try {
        response.write(": keep-alive\n\n");
      } catch {
        connection.readyState = 3;
      }
    }, 20_000);

    const teardown = () => {
      clearInterval(keepAlive);
      streamSubscribers.delete(subscriber);
      const controlled = room.controlledIds.get(connection) || new Set();
      awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(controlled), connection);
      room.controlledIds.delete(connection);
      room.connections.delete(connection);
      connection.close();
    };
    request.on("close", teardown);
    request.on("error", teardown);
  }

  const httpServer = http.createServer(async (request, response) => {
    try {
      if (request.url === "/health" && request.method === "GET") {
        jsonResponse(response, 200, { ok: true });
        return;
      }
      const streamRoute = request.url.match(
        /^\/document\/([0-9a-f-]+)\/(events|update)(\?|$)/,
      );
      if (streamRoute) {
        await handleStreamRoute(request, response, streamRoute[1], streamRoute[2]);
        return;
      }
      if (!constantTimeEqual(request.headers["x-dox-token"], token)) {
        jsonResponse(response, 401, { error: "Invalid collaboration token." });
        return;
      }
      const input = await readJson(request);
      if (
        projectPollingPaused &&
        (request.url === "/internal/open" || request.url === "/internal/flush")
      ) {
        const error = new Error("The Dox project is being reorganized; retry after it finishes.");
        error.status = 409;
        throw error;
      }
      if (request.url === "/internal/open" && request.method === "POST") {
        jsonResponse(response, 200, await openDocument(input));
      } else if (request.url === "/internal/rebind" && request.method === "POST") {
        if (!projectPollingPaused || input.lease !== projectPollingPaused.id) {
          const error = new Error("Invalid collaboration mutation lease.");
          error.status = 409;
          throw error;
        }
        await rebindDocuments(input.renames);
        jsonResponse(response, 200, { ok: true });
      } else if (request.url === "/internal/tombstone" && request.method === "POST") {
        if (!projectPollingPaused || input.lease !== projectPollingPaused.id) {
          const error = new Error("Invalid collaboration mutation lease.");
          error.status = 409;
          throw error;
        }
        await tombstoneDocuments(input.paths);
        jsonResponse(response, 200, { ok: true });
      } else if (request.url === "/internal/flush" && request.method === "POST") {
        await applyClientUpdates(input.updates);
        const documents = await flushAll();
        const acknowledgedSources = (input.updates || []).map(({ id }) => {
          const room = rooms.get(id);
          return { id, path: room.path, digest: room.digest };
        });
        jsonResponse(response, 200, { documents, acknowledgedSources });
      } else if (request.url === "/internal/pause" && request.method === "POST") {
        jsonResponse(response, 200, await pauseProject());
      } else if (request.url === "/internal/resume" && request.method === "POST") {
        await resumeProject(input.lease);
        jsonResponse(response, 200, { ok: true });
      } else {
        jsonResponse(response, 404, { error: "Collaboration endpoint not found." });
      }
    } catch (error) {
      jsonResponse(response, error.status || 400, { error: error.message });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16_000_000, perMessageDeflate: false });
  const presenceWss = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
  const broadcastPresence = () => {
    const message = JSON.stringify({
      type: "presence",
      participants: Array.from(presence.values()),
    });
    for (const connection of presenceWss.clients) send(connection, message);
  };
  httpServer.on("upgrade", async (request, socket, head) => {
    try {
      if (projectPollingPaused?.phase === "paused") {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\n\r\n");
        socket.destroy();
        return;
      }
      const url = new URL(request.url, "ws://localhost");
      if (url.pathname === "/presence") {
        if (
          !constantTimeEqual(url.searchParams.get("token"), token) ||
          (origins.length && !origins.includes(request.headers.origin))
        ) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        presenceWss.handleUpgrade(request, socket, head, (connection) => {
          presenceWss.emit("connection", connection, request);
        });
        return;
      }
      const id = url.pathname.match(/^\/document\/([0-9a-f-]+)$/)?.[1];
      if (
        !id ||
        !rooms.has(id) ||
        rooms.get(id).tombstoned ||
        !constantTimeEqual(url.searchParams.get("token"), token) ||
        (origins.length && !origins.includes(request.headers.origin))
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (connection) => {
        wss.emit("connection", connection, request, rooms.get(id));
      });
    } catch {
      socket.destroy();
    }
  });

  presenceWss.on("connection", (connection) => {
    const id = crypto.randomUUID();
    connection.isAlive = true;
    connection.on("pong", () => { connection.isAlive = true; });
    connection.on("message", (data) => {
      try {
        const input = JSON.parse(data.toString());
        if (
          input?.type !== "presence" ||
          typeof input.module !== "string" ||
          typeof input.name !== "string" ||
          typeof input.color !== "string" ||
          typeof input.clientId !== "string" ||
          typeof input.userId !== "string" ||
          input.module.length > 512 ||
          input.name.length > 80 ||
          input.color.length > 40 ||
          input.clientId.length > 80 ||
          input.userId.length > 80
        ) {
          throw new Error("Invalid workspace presence");
        }
        presence.set(id, {
          id,
          clientId: input.clientId,
          userId: input.userId,
          module: input.module,
          name: input.name,
          color: input.color,
        });
        broadcastPresence();
      } catch {
        connection.close(1003, "Invalid workspace presence");
      }
    });
    connection.on("close", () => {
      if (presence.delete(id)) broadcastPresence();
    });
    broadcastPresence();
  });

  wss.on("connection", (connection, _request, room) => {
    if (room.connections.size >= 32) {
      connection.close(1013, "This document has too many collaborators.");
      return;
    }
    room.connections.add(connection);
    room.controlledIds.set(connection, new Set());
    connection.binaryType = "arraybuffer";
    connection.isAlive = true;
    connection.on("pong", () => { connection.isAlive = true; });
    connection.on("message", (data) => {
      try {
        if (projectPollingPaused?.phase === "paused") {
          connection.close(1012, "The Dox project is being reorganized.");
          return;
        }
        applyClientMessage(room, connection, new Uint8Array(data));
      } catch {
        connection.close(1003, "Invalid collaboration message");
      }
    });
    connection.on("close", () => {
      room.connections.delete(connection);
      const controlled = Array.from(room.controlledIds.get(connection) || []);
      room.controlledIds.delete(connection);
      awarenessProtocol.removeAwarenessStates(room.awareness, controlled, connection);
    });
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    send(connection, encoding.toUint8Array(encoder));
    send(connection, encodeAwarenessMessage(
      room.awareness,
      Array.from(room.awareness.getStates().keys()),
    ));
  });

  const heartbeat = setInterval(() => {
    for (const connection of [...wss.clients, ...presenceWss.clients]) {
      if (!connection.isAlive) connection.terminate();
      else {
        connection.isAlive = false;
        connection.ping();
      }
    }
  }, 30_000);

  let pollRunning = false;
  const projectPoller = setInterval(async () => {
    if (pollRunning) return;
    if (projectPollingPaused) return;
    pollRunning = true;
    try {
      const project = await doxApi("/api/project");
      await Promise.all(Array.from(rooms.values(), async (room) => {
        if (!room.connections.size || room.tombstoned) return;
        await transition(room, async () => {
          try {
            const latest = await doxApi(`/api/page?module=${encodeURIComponent(room.module)}`);
            const digest = latest.digest || latest.document.version;
            if (digest === room.digest) {
              if (room.projectVersion !== project.version || room.error) {
                room.projectVersion = project.version;
                if (!room.conflict) room.error = null;
                publishMeta(room);
                await persistControl(room);
              }
              return;
            }
            const disk = latest.document.source;
            const merged = mergeProjectText(room.text.toString(), room.baseText, disk);
            applyText(room.text, merged.text, MIRROR_ORIGIN);
            await persistState(room);
            if (room.persistFailed) throw new Error(room.error);
            room.baseText = disk;
            room.digest = digest;
            room.projectVersion = project.version;
            room.conflict = merged.conflict;
            room.error = merged.conflict
              ? "Live and Git edits overlap. Resolve the conflict markers in the document."
              : null;
            publishMeta(room);
            await persistControl(room);
            if (!merged.conflict && merged.text !== disk) room.scheduleMirror();
          } catch (error) {
            if (error.status === 404) {
              room.tombstoned = true;
              room.error = "This page was removed from the Dox project.";
              const entry = registry.documents[room.id];
              if (entry) entry.tombstoned = true;
              idsByPath.delete(room.path);
              await saveRegistry();
            } else {
              room.error = error.message;
            }
            publishMeta(room);
            await persistControl(room);
          }
        });
      }));
    } catch (error) {
      for (const room of rooms.values()) {
        if (!room.connections.size || room.tombstoned) continue;
        room.error = error.message;
        publishMeta(room);
        persistControl(room);
      }
    } finally {
      pollRunning = false;
    }
  }, pollInterval);

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  const actualPort = httpServer.address().port;
  return {
    port: actualPort,
    rooms,
    openDocument,
    rebindDocuments,
    tombstoneDocuments,
    flushAll,
    pauseProject,
    resumeProject,
    async close({ mirror = true } = {}) {
      clearInterval(heartbeat);
      clearInterval(projectPoller);
      if (mirror) await flushAll();
      else {
        for (const room of rooms.values()) {
          clearTimeout(room.flushTimer);
          persistState(room);
          persistControl(room);
          await room.stateWrite;
          await room.controlWrite;
        }
      }
      for (const client of wss.clients) client.terminate();
      for (const client of presenceWss.clients) client.terminate();
      await new Promise((resolve) => httpServer.close(resolve));
      for (const room of rooms.values()) {
        room.awareness.destroy();
        room.doc.destroy();
      }
      await registryWrite;
    },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const options = parseArguments(process.argv.slice(2));
  const server = await createCollaborationServer({
    root: options.root,
    host: options.host,
    port: options.port,
    doxPort: options.doxPort,
    token: process.env.DOX_COLLAB_TOKEN,
    origins: options.origin,
  });
  process.stdout.write(`${JSON.stringify({ ready: true, port: server.port })}\n`);
  const stop = async () => {
    await server.close({ mirror: false });
    process.exit(0);
  };
  // The OCaml parent owns terminal interrupts and performs the Git flush while
  // its HTTP save API is still available.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", stop);
  process.stdin.resume();
  process.stdin.on("end", stop);
}
