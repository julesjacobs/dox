import {
  mountMarkdownEditor,
  mountModuleOutlineEditor,
  updateModuleOutlineEditor,
  setMarkdownEditorMode,
  setMarkdownEditorEvaluation,
  setMarkdownEditorDebugProjection,
  setMarkdownEditorResultInvalidation,
  scrollMarkdownEditorTo,
  replaceEditorStateDocument,
  connectPageCollaboration,
  connectWorkspacePresence,
  encodeCollaborationUpdate,
} from "./editor.bundle.js?v=20260803b";
import {
  dispatchExecutionIntent,
  executionPendingToken,
  installExecutionArtifact,
  presentExecution,
} from "./execution-adapter.js";
import {
  deriveOutlineOperation,
  duplicateOutlineModule,
  isOptimisticOutlineCreation,
  outlineDraftPreviewTitle,
  remapModule,
} from "./outline-operation.mjs";
import { executionTraceNavigationTarget } from "./execution-trace.js";
import {
  formatDiagnosticMessage,
  inspectorDiagnostics,
  staleExecutionLabel,
} from "./evaluation-presentation.js";

const app = document.querySelector("#app");

function storedJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

const state = {
  projectRoot: null,
  project: null,
  projectVersion: null,
  projectRequestEpoch: 0,
  projectInstallEpoch: 0,
  projectRefreshPromise: null,
  projectRefreshQueued: false,
  projectMutationTail: Promise.resolve(),
  sessionToken: null,
  collaborationPort: null,
  workspacePresence: null,
  collaboratorsByModule: new Map(),
  module: null,
  path: null,
  document: null,
  savedVersion: null,
  savedSource: null,
  evaluation: null,
  evaluationPlan: null,
  evaluationInvalidation: null,
  view: "document",
  selected: null,
  selectedDefinitionName: null,
  dirty: false,
  evaluating: false,
  saving: false,
  evalGeneration: 0,
  loadGeneration: 0,
  navigationGeneration: 0,
  navigationController: null,
  pendingModule: null,
  pendingVisible: false,
  pendingTimer: null,
  provisionalNavigation: null,
  pageRevalidations: new Map(),
  evalFrame: null,
  pendingEvaluation: null,
  requestController: null,
  evaluationController: null,
  evaluationEngine:
    localStorage.getItem("dox:v1:evaluation-engine") === "browser"
      ? "browser"
      : "server",
  executionEngineLocked: false,
  collaborationTransport: "websocket",
  sourceEditorView: null,
  sourceMode:
    localStorage.getItem("dox:v2:editor-mode") === "source"
      ? "source"
      : "literate",
  paneWidths: { sidebar: 160, inspector: 340 },
  inspectorExpanded: false,
  typeInfo: null,
  cursorPosition: null,
  definitionInfo: null,
  definitionGeneration: 0,
  definitionController: null,
  definitionTimer: null,
  completion: null,
  completionCache: new Map(),
  executionArtifactCache: new Map(),
  completionGeneration: 0,
  completionController: null,
  completionRequestKey: null,
  completionPositionFrame: null,
  suppressNextCompletionLookup: false,
  executionCore: null,
  executionProblem: null,
  typeGeneration: 0,
  typeTimer: null,
  typeController: null,
  typePending: null,
  toastTimer: null,
  sessions: new Map(),
  outlineView: null,
  outlineText: "",
  outlineCommittedText: "",
  outlineLineMap: [],
  outlineBase: null,
  outlineDraftRows: [],
  outlineDraftError: null,
  outlineDraftGeneration: 0,
  outlineSubmittedGeneration: 0,
  outlineFailedGeneration: null,
  outlineConflict: null,
  outlineNavigationRun: false,
  outlineFocusTransfer: false,
  outlineSelection: 0,
  outlineSyncQueued: false,
  outlineCommitController: null,
  outlineCommitting: false,
  outlineCommitPromise: null,
  outlineOperation: null,
  outlineOptimisticRefactor: null,
  outlinePageDraft: null,
  refactorInFlight: false,
  refactorSessionRefresh: null,
  refactorModuleMapping: null,
  workspaceError: null,
  dependency: null,
  inspectorHtml: null,
  dependencyGeneration: 0,
  dependencyController: null,
};

const escapeHtml = (value = "") =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const recoveryKey = (modulePath) => `dox:v2:draft:${modulePath}`;

function storeRecoveryDraft(session, source) {
  try {
    localStorage.setItem(
      recoveryKey(session.module),
      JSON.stringify({
        source,
        expectedDigest: session.savedVersion,
        editRevision: session.editRevision,
      }),
    );
  } catch {
    // Autosave remains authoritative when private browsing disables storage.
  }
}

function recoveredDraft(modulePath, expectedDigest) {
  try {
    const key = recoveryKey(modulePath);
    const raw = localStorage.getItem(key);
    const value = JSON.parse(raw);
    if (!value) return null;
    if (value.expectedDigest === expectedDigest) return value;
    const conflictKey =
      `dox:v2:conflict:${modulePath}:${Date.now()}`;
    localStorage.setItem(conflictKey, raw);
    localStorage.removeItem(key);
    return { conflictKey };
  } catch {
    return null;
  }
}

function clearRecoveryDraft(modulePath) {
  try {
    localStorage.removeItem(recoveryKey(modulePath));
  } catch {
    // Nothing else is required when storage is unavailable.
  }
}

function migrateRecoveryDraftKeys(mapping) {
  if (!mapping?.length) return;
  try {
    const captured = mapping.map(({ before, after }) => ({
      before,
      after,
      raw: localStorage.getItem(recoveryKey(before)),
    }));
    const destinations = new Set(mapping.map(({ after }) => after));
    for (const { after, raw } of captured) {
      if (raw !== null) localStorage.setItem(recoveryKey(after), raw);
    }
    for (const { before } of captured) {
      if (!destinations.has(before)) {
        localStorage.removeItem(recoveryKey(before));
      }
    }
  } catch {
    // Active sessions keep the draft when browser storage is unavailable.
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.sessionToken ? { "X-Dox-Token": state.sessionToken } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(
      payload.error || `Request failed (${response.status})`,
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function acquireProjectMutation() {
  const previous = state.projectMutationTail;
  let release;
  state.projectMutationTail = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  return release;
}

async function withProjectMutation(operation) {
  const release = await acquireProjectMutation();
  try {
    return await operation();
  } finally {
    release();
  }
}

function toast(message) {
  document.querySelector(".toast")?.remove();
  const element = document.createElement("div");
  element.className = "toast";
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");
  element.textContent = message;
  document.body.appendChild(element);
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.remove(), 3000);
}

function paneStorageKey() {
  return `dox:v3:pane-widths:${state.projectRoot || "default"}`;
}

function loadPaneWidths() {
  const stored = storedJson(paneStorageKey(), {});
  const legacy = storedJson(
    `dox:v2:pane-widths:${state.projectRoot || "default"}`,
    {},
  );
  state.paneWidths = {
    sidebar: Number.isFinite(stored.sidebar) ? stored.sidebar : 160,
    inspector: Number.isFinite(stored.inspector)
      ? stored.inspector
      : Math.max(Number.isFinite(legacy.inspector) ? legacy.inspector : 0, 340),
  };
}

function savePaneWidths() {
  localStorage.setItem(paneStorageKey(), JSON.stringify(state.paneWidths));
}

async function initialize() {
  try {
    const session = await api("/api/session");
    state.sessionToken = session.token;
    state.projectRoot = session.projectRoot;
    state.collaborationPort = session.collaborationPort;
    // A shared workspace pins the engine server-side; do not let a stale
    // localStorage preference put this browser back on server-side execution.
    state.executionEngineLocked = session.executionEngineLocked === true;
    state.collaborationTransport = session.collaborationTransport || "websocket";
    if (state.executionEngineLocked) {
      state.evaluationEngine = session.executionEngine || "browser";
    }
    state.workspacePresence = connectWorkspacePresence({
      port: state.collaborationPort,
      token: state.sessionToken,
      transport: state.collaborationTransport,
      onPresence: (participants) => {
        const byModule = new Map();
        const seenByModule = new Map();
        for (const participant of participants) {
          if (!participant?.module) continue;
          const seen = seenByModule.get(participant.module) || new Set();
          const identity = participant.userId || participant.clientId;
          if (seen.has(identity)) continue;
          seen.add(identity);
          seenByModule.set(participant.module, seen);
          const peers = byModule.get(participant.module) || [];
          peers.push(participant);
          byModule.set(participant.module, peers);
        }
        state.collaboratorsByModule = byModule;
        syncOutlineEditor();
      },
    });
    loadPaneWidths();
    const project = await refreshProjectIndex({ forceOutline: true });
    const routeModule = decodeURIComponent(
      window.location.pathname.match(/^\/page\/(.+)$/)?.[1] || "",
    );
    const initialModule =
      project.documents.find((document) => document.module === routeModule)
        ?.module ||
      project.documents[0]?.module ||
      null;
    if (initialModule) {
      await loadDocument(initialModule, {
        force: true,
        history: "replace",
        focus: "none",
      });
    }
    else render();
  } catch (error) {
    app.innerHTML = `<div class="empty-state"><h2>Could not open the project</h2><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function currentSession() {
  return state.module ? state.sessions.get(state.module) : null;
}

function sessionSource(session) {
  return (
    session?.collaboration?.text.toString() ??
    session?.editorState?.doc.toString() ??
    session?.document?.source ??
    ""
  );
}

function reconcileCollaborativeSession(session) {
  if (!session?.collaboration) return false;
  const source = session.collaboration.text.toString();
  if (source === session.document.source && session.editorState?.doc.toString() === source) {
    return false;
  }
  session.document = {
    ...session.document,
    source,
    blocks: parseDraftBlocks(source),
  };
  session.editorState = replaceEditorStateDocument(session.editorState, source);
  session.evaluation = null;
  session.evaluationPlan = null;
  session.evaluationInvalidation = null;
  session.executionCore = null;
  session.executionProblem = null;
  return true;
}

function reconcileCollaborativeIdentity(session, meta) {
  if (!meta.module || !meta.path) return;
  session.collaborationIdentityPending = meta;
  if (
    state.outlineOptimisticRefactor ||
    state.refactorInFlight ||
    session.collaborationIdentityPromise
  ) {
    return;
  }
  session.collaborationIdentityPromise = (async () => {
    while (
      session.collaborationIdentityPending &&
      !state.outlineOptimisticRefactor &&
      !state.refactorInFlight
    ) {
      const pending = session.collaborationIdentityPending;
      session.collaborationIdentityPending = null;
      if (pending.module === session.module && pending.path === session.path) {
        continue;
      }
      const project = await refreshProjectIndex();
      const authoritative = project.documents?.find(
        (document) =>
          document.module === pending.module && document.path === pending.path,
      );
      if (!authoritative) continue;
      const wasCurrent = session === currentSession();
      const oldModule = session.module;
      if (state.sessions.get(oldModule) === session) state.sessions.delete(oldModule);
      session.module = pending.module;
      session.path = pending.path;
      session.document = { ...session.document, path: pending.path };
      state.sessions.set(pending.module, session);
      if (wasCurrent) {
        state.module = pending.module;
        state.path = pending.path;
        state.document = session.document;
        updateRoute(pending.module, "replace");
        render();
      }
    }
  })()
    .catch((error) => {
      session.conflict = error.message;
    })
    .finally(() => {
      session.collaborationIdentityPromise = null;
      if (
        session.collaborationIdentityPending &&
        !state.outlineOptimisticRefactor &&
        !state.refactorInFlight
      ) {
        queueMicrotask(() =>
          reconcileCollaborativeIdentity(
            session,
            session.collaborationIdentityPending,
          ),
        );
      }
    });
}

async function attachSessionCollaboration(session) {
  if (session.collaboration || session.provisional || !state.collaborationPort) {
    return session.collaboration || null;
  }
  const opened = await api("/api/collaboration/open", {
    method: "POST",
    body: JSON.stringify({ module: session.module }),
  });
  const collaboration = await connectPageCollaboration({
    id: opened.id,
    port: state.collaborationPort,
    token: state.sessionToken,
    projectRoot: state.projectRoot,
    transport: state.collaborationTransport,
    onMeta: (meta) => {
      reconcileCollaborativeIdentity(session, meta);
      if (meta.digest) session.savedVersion = meta.digest;
      if (typeof meta.baseText === "string") session.savedSource = meta.baseText;
      session.conflict = meta.error || null;
      if (session === currentSession()) {
        state.savedVersion = session.savedVersion;
        state.savedSource = session.savedSource;
        state.dirty = state.document.source !== state.savedSource;
        state.workspaceError = meta.error || state.outlineConflict || null;
        updateStatusOnly();
      }
      if (meta.tombstoned && !session.collaborationTombstoneHandled) {
        session.collaborationTombstoneHandled = true;
        queueMicrotask(async () => {
          const project = await refreshProjectIndex().catch(() => null);
          if (session !== currentSession()) return;
          if (
            project?.documents?.some(
              (document) => document.module === session.module,
            )
          ) {
            session.collaborationTombstoneHandled = false;
            return;
          }
          const fallback = project?.documents?.find(
            (document) => document.module !== session.module,
          )?.module;
          if (fallback) {
            await loadDocument(fallback, {
              force: true,
              history: "replace",
              focus: "main",
            });
          } else {
            session.collaboration?.destroy();
            state.sessions.delete(session.module);
            state.module = null;
            state.path = null;
            state.document = null;
            state.workspaceError =
              "This page was deleted. Create a page in the module outline to continue.";
            render();
          }
        });
      }
      if (meta.projectVersion && meta.projectVersion !== state.projectVersion) {
        clearTimeout(session.collaborationProjectTimer);
        session.collaborationProjectTimer = setTimeout(
          () => void refreshProjectIndex(),
          80,
        );
      }
    },
    onStatus: (status) => {
      session.collaborationStatus = status;
      if (status === "connected") {
        session.collaborationIntentionalDisconnect = false;
        session.collaborationWasConnected = true;
        if (
          session === currentSession() &&
          state.workspaceError === "Live collaboration is reconnecting…"
        ) {
          state.workspaceError = state.outlineConflict || null;
          updateStatusOnly();
        }
      } else if (
        session.collaborationWasConnected &&
        !session.collaborationIntentionalDisconnect &&
        session === currentSession()
      ) {
        state.workspaceError = "Live collaboration is reconnecting…";
        updateStatusOnly();
      }
    },
  });
  session.collaboration = collaboration;
  return collaboration;
}

function setExecutionCore(executionCore) {
  state.executionCore = executionCore;
  const session = currentSession();
  if (session) session.executionCore = executionCore;
  return executionCore;
}

function captureCurrentSession() {
  if (!state.module || !state.document) return;
  const session = currentSession() || { module: state.module };
  const editor =
    state.sourceEditorView?.doxModule === state.module
      ? state.sourceEditorView
      : null;
  session.module = state.module;
  session.path = state.path;
  session.document = state.document;
  session.savedVersion = state.savedVersion;
  session.savedSource = state.savedSource;
  session.evaluation = state.evaluation;
  session.evaluationPlan = state.evaluationPlan;
  session.evaluationInvalidation = state.evaluationInvalidation;
  session.executionCore = state.executionCore;
  session.executionProblem = state.executionProblem;
  session.selected = state.selected;
  session.editorState = editor?.state || session.editorState;
  session.scrollTop =
    editor?.scrollDOM.scrollTop ?? session.scrollTop ?? 0;
  session.editRevision ??= 0;
  session.acknowledgedRevision ??= 0;
  session.autosaveTimer ??= null;
  session.autosaveInFlight ??= false;
  session.conflict ??= null;
  state.sessions.set(state.module, session);
}

function restoreSession(session) {
  state.module = session.module;
  state.path = session.path;
  state.document = session.document;
  state.savedVersion = session.savedVersion;
  state.savedSource = session.savedSource;
  state.evaluation = session.evaluation || null;
  state.evaluationPlan = session.evaluationPlan || null;
  state.evaluationInvalidation = session.evaluationInvalidation || null;
  state.executionCore = session.executionCore || null;
  state.executionProblem = session.executionProblem || null;
  state.selected = session.selected || session.document.blocks[0]?.id || null;
  state.dirty = session.document.source !== session.savedSource;
  state.workspaceError = session.conflict || state.outlineConflict || null;
}

function moduleSourcePath(modulePath) {
  return `${modulePath
    .split(".")
    .map((component) =>
      component ? component[0].toLowerCase() + component.slice(1) : component
    )
    .join("/")}.ml.md`;
}

function beginOptimisticPage(modulePath, { focus = "main" } = {}) {
  const existing = state.sessions.get(modulePath);
  if (existing) {
    restoreSession(existing);
    if (window.location.pathname !== `/page/${encodeURIComponent(modulePath)}`) {
      updateRoute(modulePath, "push");
    }
    render();
    return existing;
  }
  captureCurrentSession();
  invalidateEvaluation();
  invalidateDependencyContext({ clear: true });
  const source = `# ${modulePath}\n\n`;
  const path = moduleSourcePath(modulePath);
  const document = {
    path,
    source,
    version: null,
    blocks: parseDraftBlocks(source),
  };
  const session = {
    module: modulePath,
    path,
    document,
    savedVersion: null,
    savedSource: source,
    evaluation: null,
    evaluationPlan: null,
    evaluationInvalidation: null,
    executionCore: null,
    executionProblem: null,
    selected: document.blocks[0]?.id || null,
    editorState: null,
    scrollTop: 0,
    editRevision: 0,
    acknowledgedRevision: 0,
    autosaveTimer: null,
    autosaveInFlight: false,
    autosaveQueued: false,
    conflict: null,
    provisional: true,
  };
  state.sessions.set(modulePath, session);
  restoreSession(session);
  state.view = "document";
  state.workspaceError = null;
  state.outlineOperation = {
    kind: "create",
    modulePath,
  };
  updateRoute(modulePath, "push");
  clearPendingNavigation();
  if (focus === "outline") state.outlineFocusTransfer = true;
  render();
  queueMicrotask(() => {
    if (focus === "outline") {
      state.outlineView?.focus();
      queueMicrotask(() => {
        state.outlineFocusTransfer = false;
      });
    } else {
      state.sourceEditorView?.focus();
    }
  });
  return session;
}

function beginOutlinePageDraft(selection) {
  if (state.outlinePageDraft) return;
  captureCurrentSession();
  const previousModule = state.module;
  invalidateEvaluation();
  invalidateDependencyContext({ clear: true });
  const source = "# \n\n";
  const document = {
    path: null,
    source,
    version: null,
    blocks: parseDraftBlocks(source),
  };
  state.outlinePageDraft = {
    previousModule,
    selection,
    modulePath: null,
  };
  state.module = null;
  state.path = null;
  state.document = document;
  state.savedVersion = null;
  state.savedSource = source;
  state.evaluation = null;
  state.evaluationPlan = null;
  state.evaluationInvalidation = null;
  state.executionCore = null;
  state.executionProblem = null;
  state.selected = document.blocks[0]?.id || null;
  state.dirty = false;
  state.view = "document";
  state.workspaceError = null;
  state.outlineFocusTransfer = true;
  render();
  queueMicrotask(() => {
    state.outlineView?.focus();
    queueMicrotask(() => {
      state.outlineFocusTransfer = false;
    });
  });
}

function updateOutlinePageDraftPreview(view) {
  const draft = state.outlinePageDraft;
  if (!draft || !state.document) return;
  const position = Math.min(draft.selection, view.state.doc.length);
  const line = view.state.doc.lineAt(position);
  const row = outlineRowAtLine(line.number);
  // An invalid row can carry identity metadata from its last valid state so
  // that editing can recover without losing the page it came from. Never use
  // that stale metadata for the visible draft: the preview must reflect the
  // characters that are actually in the outline.
  const title = outlineDraftPreviewTitle(line.text, row);
  const source = `# ${title}\n\n`;
  draft.modulePath = row?.targetModule || null;
  state.path = draft.modulePath ? moduleSourcePath(draft.modulePath) : null;
  state.document = {
    path: state.path,
    source,
    version: null,
    blocks: parseDraftBlocks(source),
  };
  state.savedSource = source;
  state.selected = state.document.blocks[0]?.id || null;
  if (state.sourceEditorView) {
    state.sourceEditorView.setState(
      replaceEditorStateDocument(state.sourceEditorView.state, source),
    );
    state.sourceEditorView.doxModule = null;
  }
}

async function reconcileCreatedOperation(operation) {
  if (operation?.kind !== "create" || !operation.created?.length) return false;
  try {
    const project = await refreshProjectIndex();
    if (
      !operation.created.every((modulePath) =>
        project.pageIndex?.modules?.includes(modulePath)
      )
    ) {
      return false;
    }
    for (const modulePath of operation.created) {
      const payload = await api(
        `/api/page?module=${encodeURIComponent(modulePath)}`,
      );
      confirmOptimisticPage(modulePath, payload.document);
    }
    state.workspaceError = null;
    render();
    return true;
  } catch {
    return false;
  }
}

function rollbackOptimisticPage(modulePath, previousModule) {
  const provisional = state.sessions.get(modulePath);
  if (provisional?.provisional) state.sessions.delete(modulePath);
  if (state.module !== modulePath || !provisional?.provisional) return;
  const previous = previousModule ? state.sessions.get(previousModule) : null;
  if (previous) {
    restoreSession(previous);
    updateRoute(previousModule, "replace");
  } else {
    state.module = null;
    state.path = null;
    state.document = null;
  }
  state.outlineOperation = null;
  render();
  queueMicrotask(() => state.outlineView?.focus());
}

function confirmOptimisticPage(modulePath, document) {
  const session = state.sessions.get(modulePath);
  if (!session?.provisional || !document) return;
  const localSource =
    session === currentSession()
      ? state.document.source
      : sessionSource(session);
  session.provisional = false;
  session.path = document.path;
  session.savedVersion = document.version;
  session.savedSource = document.source;
  session.document =
    localSource === document.source
      ? document
      : {
          ...document,
          source: localSource,
          blocks: parseDraftBlocks(localSource),
        };
  session.editorState = replaceEditorStateDocument(
    session.editorState,
    localSource,
  );
  if (session === currentSession()) restoreSession(session);
  if (state.collaborationPort) {
    void attachSessionCollaboration(session)
      .then((collaboration) => {
        if (!collaboration) return;
        // Typing may continue while the collaboration room is opening. Read the
        // draft now, rather than using the snapshot captured before the await.
        const latestDraft =
          session === currentSession()
            ? state.document.source
            : session.editorState?.doc.toString() || session.document.source;
        const sharedSource = collaboration.text.toString();
        if (latestDraft !== sharedSource) {
          const change = contiguousTextChange(document.source, latestDraft);
          const expected = document.source.slice(change.from, change.to);
          if (
            sharedSource.slice(change.from, change.from + expected.length) ===
            expected
          ) {
            collaboration.doc.transact(() => {
              collaboration.text.delete(change.from, expected.length);
              collaboration.text.insert(change.from, change.insert);
            });
          } else {
            session.conflict =
              "Another collaborator edited this new page at the same position. Both drafts are preserved below.";
            const preserved = [
              "<<<<<<< live Dox document",
              latestDraft,
              "||||||| last mirrored version",
              document.source,
              "======= Dox Git working tree",
              sharedSource,
              ">>>>>>> Git working tree",
            ].join("\n");
            collaboration.doc.transact(() => {
              collaboration.text.delete(0, collaboration.text.length);
              collaboration.text.insert(0, preserved);
            });
          }
        }
        session.editorState = null;
        session.document = {
          ...session.document,
          source: collaboration.text.toString(),
          blocks: parseDraftBlocks(collaboration.text.toString()),
        };
        if (session === currentSession()) {
          restoreSession(session);
          render();
          queueMicrotask(() => state.sourceEditorView?.focus());
        }
      })
      .catch((error) => {
        session.conflict = error.message;
        if (session === currentSession()) {
          state.workspaceError = error.message;
          updateStatusOnly();
        }
      });
    return;
  }
  if (localSource !== document.source || session.autosaveQueued) {
    scheduleAutosave(session, { immediate: true });
  }
}

function currentOutlineOperation(openModule = null) {
  if (state.outlineDraftError || !state.outlineBase) return null;
  try {
    const draft = parseOutlineDraft(state.outlineText, {
      previousRows: state.outlineDraftRows,
    });
    return deriveOutlineOperation({
      committedRows: state.outlineBase.committedRowsWithOrigins,
      draftRows: draft.rows,
      openModule,
    });
  } catch {
    return null;
  }
}

function remapSessions(mapping, { preservePersistence = false } = {}) {
  const sessions = new Map();
  for (const [modulePath, session] of state.sessions) {
    const nextModule = remapModule(modulePath, mapping);
    if (nextModule !== modulePath) {
      // EditorState owns callbacks mounted for modulePath. Reusing it under a
      // new identity makes edits visible in CodeMirror but invisible to Dox.
      session.editorState = null;
    }
    if (preservePersistence && nextModule !== modulePath) {
      session.persistenceModule ||= modulePath;
    }
    session.module = nextModule;
    session.path = moduleSourcePath(nextModule);
    if (session.document) {
      session.document = { ...session.document, path: session.path };
    }
    sessions.set(nextModule, session);
  }
  state.sessions = sessions;
}

function beginOptimisticRefactor(operation) {
  if (
    operation?.kind !== "refactor" ||
    !operation.renames?.length ||
    state.outlineOptimisticRefactor
  ) {
    return;
  }
  const nextModule = remapModule(state.module, operation.renames);
  if (!nextModule || nextModule === state.module) return;
  captureCurrentSession();
  const previousModule = state.module;
  remapSessions(operation.renames, { preservePersistence: true });
  state.outlineOptimisticRefactor = {
    mapping: operation.renames,
    previousModule,
    nextModule,
  };
  const current = state.sessions.get(nextModule);
  if (current) restoreSession(current);
  updateRoute(nextModule, "replace");
  render();
  queueMicrotask(() => state.outlineView?.focus());
}

function rollbackOptimisticRefactor() {
  const optimistic = state.outlineOptimisticRefactor;
  if (!optimistic) return;
  const inverse = [...optimistic.mapping]
    .reverse()
    .map(({ before, after }) => ({ before: after, after: before }));
  captureCurrentSession();
  remapSessions(inverse);
  for (const session of state.sessions.values()) {
    session.persistenceModule = null;
  }
  const current = state.sessions.get(optimistic.previousModule);
  if (current) restoreSession(current);
  updateRoute(optimistic.previousModule, "replace");
  state.outlineOptimisticRefactor = null;
  render();
  queueMicrotask(() => state.outlineView?.focus());
}

function updateRoute(modulePath, mode = "push") {
  const url = `/page/${encodeURIComponent(modulePath)}`;
  const payload = {
    module: modulePath,
    outlineSelection: state.outlineSelection,
  };
  if (mode === "replace") window.history.replaceState(payload, "", url);
  else if (mode === "push") window.history.pushState(payload, "", url);
}

function outlineHistoryMode(kind) {
  if (kind === "vertical" && state.outlineNavigationRun) return "replace";
  state.outlineNavigationRun = true;
  return "push";
}

function clearPendingNavigation() {
  clearTimeout(state.pendingTimer);
  state.pendingTimer = null;
  state.pendingModule = null;
  state.pendingVisible = false;
  syncOutlineEditor();
}

function beginPendingNavigation(modulePath) {
  clearTimeout(state.pendingTimer);
  state.pendingModule = modulePath;
  state.pendingVisible = false;
  syncOutlineEditor();
  state.pendingTimer = setTimeout(() => {
    if (state.pendingModule !== modulePath) return;
    state.pendingVisible = true;
    syncOutlineEditor();
  }, 120);
}

function invalidateDependencyContext({ clear = false, stale = true } = {}) {
  state.dependencyGeneration += 1;
  state.dependencyController?.abort();
  state.dependencyController = null;
  if (clear) {
    state.dependency = null;
  } else if (state.dependency) {
    state.dependency = { ...state.dependency, stale };
  }
}

async function loadDependencyContext(modulePath, { retry = true } = {}) {
  const generation = ++state.dependencyGeneration;
  state.dependencyController?.abort();
  const controller = new AbortController();
  state.dependencyController = controller;
  try {
    const payload = await api(
      `/api/dependencies?module=${encodeURIComponent(modulePath)}`,
      { signal: controller.signal },
    );
    if (
      generation !== state.dependencyGeneration ||
      state.module !== modulePath
    ) {
      return;
    }
    if (payload.projectVersion !== state.projectVersion) {
      if (retry) {
        await refreshProjectIndex();
        if (
          generation === state.dependencyGeneration &&
          state.module === modulePath
        ) {
          void loadDependencyContext(modulePath, { retry: false });
        }
      }
      return;
    }
    state.dependency = payload.dependency;
    refreshInspector();
  } catch (error) {
    if (
      error.name !== "AbortError" &&
      generation === state.dependencyGeneration &&
      state.module === modulePath
    ) {
      state.dependency = null;
      refreshInspector();
    }
  } finally {
    if (state.dependencyController === controller) {
      state.dependencyController = null;
    }
  }
}

function invalidateTypeLookup() {
  clearTimeout(state.typeTimer);
  state.typeGeneration += 1;
  state.typePending = null;
  state.typeController?.abort();
  state.typeController = null;
  state.typeInfo = null;
  state.cursorPosition = null;
  invalidateDefinitionLookup();
}

function invalidateDefinitionLookup() {
  clearTimeout(state.definitionTimer);
  state.definitionGeneration += 1;
  state.definitionController?.abort();
  state.definitionController = null;
  state.definitionInfo = null;
}

function invalidateCompletion({ clearCache = false } = {}) {
  state.completionGeneration += 1;
  state.completionController?.abort();
  state.completionController = null;
  state.completionRequestKey = null;
  state.completion = null;
  state.suppressNextCompletionLookup = false;
  if (clearCache) state.completionCache.clear();
}

function invalidateEvaluation() {
  if (state.evalFrame !== null) cancelAnimationFrame(state.evalFrame);
  state.evalFrame = null;
  state.pendingEvaluation = null;
  state.evalGeneration += 1;
  state.loadGeneration += 1;
  state.requestController?.abort();
  state.requestController = null;
  state.evaluationController?.abort();
  state.evaluationController = null;
  invalidateTypeLookup();
  invalidateCompletion({ clearCache: true });
  state.evaluating = false;
}

async function loadDocument(
  modulePath,
  {
    force = false,
    history = "push",
    focus = "main",
    projectRetry = 0,
  } = {},
) {
  if (state.refactorSessionRefresh) {
    const barrier = state.refactorSessionRefresh;
    const mapping = state.refactorModuleMapping;
    try {
      await barrier;
    } catch {
      return false;
    }
    modulePath = mapping?.get(modulePath) || modulePath;
  }
  if (!force && modulePath === state.module) return true;
  const previousSession = currentSession();
  captureCurrentSession();
  if (modulePath !== state.module) {
    if (previousSession?.collaboration) {
      previousSession.collaborationIntentionalDisconnect = true;
      previousSession.collaboration.awareness.setLocalStateField("cursor", null);
      previousSession.collaboration.provider.disconnect();
    }
    state.executionCore = null;
    state.executionProblem = null;
  }
  const inheritedProvisional = state.provisionalNavigation;
  const previousModule =
    inheritedProvisional?.previousModule ?? state.module;
  const previousHistoryState =
    inheritedProvisional?.previousHistoryState ?? window.history.state;
  const previousUrl =
    inheritedProvisional?.previousUrl ??
    window.location.pathname + window.location.search + window.location.hash;
  const cached = state.sessions.get(modulePath);
  invalidateEvaluation();
  invalidateDependencyContext({ clear: true });
  state.navigationController?.abort();
  const generation = ++state.navigationGeneration;
  const controller = new AbortController();
  state.navigationController = controller;
  beginPendingNavigation(modulePath);
  if (cached?.document) {
    cached.collaborationIntentionalDisconnect = false;
    cached.collaboration?.provider.connect();
    reconcileCollaborativeSession(cached);
    restoreSession(cached);
    state.workspacePresence?.setModule(modulePath);
    state.view = "document";
    updateRoute(modulePath, history);
    state.provisionalNavigation = {
      generation,
      module: modulePath,
      previousModule,
      previousHistoryState,
      previousUrl,
    };
    clearPendingNavigation();
    if (focus === "outline") state.outlineFocusTransfer = true;
    render();
    void loadDependencyContext(modulePath);
    if (!cached.evaluation) {
      scheduleEvaluation(cached.document.source, { immediate: true });
    }
    void revalidateCachedSession(cached, state.provisionalNavigation);
    if (focus === "main") {
      queueMicrotask(() => state.sourceEditorView?.focus());
    } else if (focus === "outline") {
      queueMicrotask(() => {
        state.outlineView?.focus();
        queueMicrotask(() => {
          state.outlineFocusTransfer = false;
        });
      });
    }
    if (state.navigationController === controller) {
      state.navigationController = null;
    }
    return true;
  }
  state.requestController = controller;
  try {
    const payload = await api(
      `/api/page?module=${encodeURIComponent(modulePath)}`,
      { signal: controller.signal },
    );
    if (
      generation !== state.navigationGeneration ||
      state.pendingModule !== modulePath
    ) {
      return false;
    }
    const diskSource = payload.document.source;
    const diskVersion = payload.digest || payload.document.version;
    const indexed = state.project?.documents.find(
      (entry) => entry.module === payload.module,
    );
    if (!indexed || indexed.version !== diskVersion) {
      await refreshProjectIndex();
      if (
        generation !== state.navigationGeneration ||
        state.pendingModule !== modulePath
      ) {
        return false;
      }
      const refreshed = state.project?.documents.find(
        (entry) => entry.module === payload.module,
      );
      if (!refreshed) {
        throw new Error(`Module ${payload.module} no longer exists.`);
      }
      if (refreshed.version !== diskVersion && projectRetry < 1) {
        return loadDocument(modulePath, {
          force: true,
          history,
          focus,
          projectRetry: projectRetry + 1,
        });
      }
      if (refreshed.version !== diskVersion) {
        throw new Error(
          `Module ${payload.module} changed again while it was opening.`,
        );
      }
    }
    const recovery = state.collaborationPort
      ? null
      : recoveredDraft(payload.module, diskVersion);
    const recovered =
      recovery?.source && recovery.source !== payload.document.source;
    if (recovery?.conflictKey) {
      state.workspaceError =
        "A browser recovery draft was based on an older file version and was preserved as a conflict.";
    }
    if (recovered) {
      payload.document = {
        ...payload.document,
        source: recovery.source,
        blocks: parseDraftBlocks(recovery.source),
      };
      state.workspaceError = "Recovered an autosave draft from this browser.";
    }
    state.module = payload.module;
    state.workspacePresence?.setModule(payload.module);
    state.path = payload.document.path;
    state.document = payload.document;
    state.savedVersion = diskVersion;
    state.savedSource = diskSource;
    state.evaluation = null;
    state.evaluationPlan = null;
    state.evaluationInvalidation = null;
    state.executionCore = null;
    state.evaluating = true;
    state.selected = payload.document.blocks[0]?.id || null;
    state.selectedDefinitionName = null;
    state.typeInfo = null;
    state.cursorPosition = null;
    state.dirty = Boolean(recovered);
    const session = {
      module: payload.module,
      path: payload.document.path,
      document: payload.document,
      savedVersion: diskVersion,
      savedSource: diskSource,
      evaluation: null,
      evaluationPlan: null,
      evaluationInvalidation: null,
      executionCore: null,
      selected: payload.document.blocks[0]?.id || null,
      editorState: null,
      scrollTop: 0,
      editRevision: recovery?.editRevision || 0,
      acknowledgedRevision: 0,
      autosaveTimer: null,
      autosaveInFlight: false,
      conflict: null,
    };
    state.sessions.set(payload.module, session);
    try {
      const collaboration = await attachSessionCollaboration(session);
      if (collaboration) {
        const collaborativeSource = collaboration.text.toString();
        session.document = {
          ...session.document,
          source: collaborativeSource,
          blocks: parseDraftBlocks(collaborativeSource),
        };
        state.document = session.document;
        state.savedVersion = session.savedVersion;
        state.savedSource = session.savedSource;
        state.dirty = collaborativeSource !== session.savedSource;
      }
    } catch (error) {
      state.workspaceError = error.message;
      throw error;
    }
    state.provisionalNavigation = null;
    updateRoute(payload.module, history);
    clearPendingNavigation();
    if (focus === "outline") state.outlineFocusTransfer = true;
    render();
    void loadDependencyContext(payload.module);
    scheduleEvaluation(state.document.source, { immediate: true });
    if (recovered) scheduleAutosave(session, { immediate: true });
    if (focus === "main") {
      queueMicrotask(() => state.sourceEditorView?.focus());
    } else if (focus === "outline") {
      queueMicrotask(() => {
        state.outlineView?.focus();
        queueMicrotask(() => {
          state.outlineFocusTransfer = false;
        });
      });
    }
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    if (
      error.status === 404 &&
      projectRetry < 1 &&
      generation === state.navigationGeneration
    ) {
      try {
        await refreshProjectIndex();
        if (generation !== state.navigationGeneration) return false;
        if (
          state.project?.documents.some(
            (entry) => entry.module === modulePath,
          )
        ) {
          return loadDocument(modulePath, {
            force: true,
            history,
            focus,
            projectRetry: projectRetry + 1,
          });
        }
      } catch {
        // Keep the original page-load failure as the persistent diagnostic.
      }
    }
    if (generation === state.navigationGeneration) {
      clearPendingNavigation();
      state.workspaceError = error.message;
      updateStatusOnly();
    }
    return false;
  } finally {
    if (state.navigationController === controller) {
      state.navigationController = null;
    }
    if (state.requestController === controller) {
      state.requestController = null;
    }
  }
}

function cachedRevalidationRequest(modulePath, digest) {
  const key = `${modulePath}\u0000${digest}`;
  let request = state.pageRevalidations.get(key);
  if (!request) {
    request = api(
      `/api/page?module=${encodeURIComponent(modulePath)}&ifDigest=${encodeURIComponent(digest)}`,
    ).finally(() => {
      if (state.pageRevalidations.get(key) === request) {
        state.pageRevalidations.delete(key);
      }
    });
    state.pageRevalidations.set(key, request);
  }
  return request;
}

function finishProvisionalNavigation(provisional) {
  if (
    provisional &&
    state.provisionalNavigation?.generation === provisional.generation
  ) {
    state.provisionalNavigation = null;
  }
}

async function rollbackProvisionalNavigation(provisional, message) {
  if (
    !provisional ||
    state.provisionalNavigation?.generation !== provisional.generation ||
    state.navigationGeneration !== provisional.generation ||
    state.module !== provisional.module
  ) {
    return;
  }
  state.sessions.delete(provisional.module);
  invalidateEvaluation();
  const previous = provisional.previousModule
    ? state.sessions.get(provisional.previousModule)
    : null;
  if (previous) {
    restoreSession(previous);
    if (Number.isFinite(provisional.previousHistoryState?.outlineSelection)) {
      const length =
        state.outlineView?.state.doc.length ?? state.outlineText.length;
      state.outlineSelection = Math.min(
        Math.max(provisional.previousHistoryState.outlineSelection, 0),
        length,
      );
    }
    window.history.replaceState(
      provisional.previousHistoryState,
      "",
      provisional.previousUrl,
    );
  } else {
    state.module = null;
    state.path = null;
    state.document = null;
  }
  state.provisionalNavigation = null;
  state.workspaceError = message;
  invalidateDependencyContext({ clear: true });
  render();
  if (state.module) {
    void loadDependencyContext(state.module);
    if (!previous?.evaluation || previous.evaluationInvalidation) {
      scheduleEvaluation(previous.document.source, { immediate: true });
    }
  }
}

async function refreshProjectIndex({ forceOutline = false } = {}) {
  if (state.projectRefreshPromise) {
    state.projectRefreshQueued = true;
    await state.projectRefreshPromise;
    if (forceOutline) {
      installProjectSnapshot(state.project, {
        forceOutline: true,
        installEpoch: state.projectInstallEpoch,
      });
    }
    if (state.projectRefreshQueued) {
      state.projectRefreshQueued = false;
      return refreshProjectIndex({ forceOutline });
    }
    return state.project;
  }
  const requestEpoch = ++state.projectRequestEpoch;
  const request = api("/api/project")
    .then((project) => {
      installProjectSnapshot(project, {
        forceOutline,
        installEpoch: requestEpoch,
      });
      return project;
    })
    .finally(() => {
      if (state.projectRefreshPromise === request) {
        state.projectRefreshPromise = null;
      }
    });
  state.projectRefreshPromise = request;
  await request;
  if (state.projectRefreshQueued) {
    state.projectRefreshQueued = false;
    return refreshProjectIndex({ forceOutline });
  }
  return state.project;
}

async function revalidateCachedSession(
  session,
  provisional = null,
  refreshRetry = 0,
) {
  if (session.collaboration) {
    finishProvisionalNavigation(provisional);
    return;
  }
  const modulePath = session.module;
  const digest = session.savedVersion;
  const revision = session.editRevision;
  const source = sessionSource(session);
  try {
    const payload = await cachedRevalidationRequest(modulePath, digest);
    if (state.sessions.get(modulePath) !== session) {
      finishProvisionalNavigation(provisional);
      return;
    }
    if (
      payload.notModified === true ||
      payload.digest === digest ||
      payload.document?.version === digest
    ) {
      finishProvisionalNavigation(provisional);
      return;
    }
    const document = payload.document;
    if (!document) {
      throw new Error(`Module ${modulePath} no longer exists.`);
    }
    const latestSource =
      session === currentSession()
        ? state.document.source
        : sessionSource(session);
    if (
      session.editRevision !== revision ||
      latestSource !== source ||
      latestSource !== session.savedSource
    ) {
      session.conflict =
        `${modulePath} changed on disk while this page had local edits.`;
      if (session === currentSession()) {
        state.workspaceError = session.conflict;
        updateStatusOnly();
      }
      finishProvisionalNavigation(provisional);
      return;
    }
    const indexed = state.project?.documents.find(
      (entry) => entry.module === modulePath,
    );
    if (!indexed || indexed.version !== payload.digest) {
      await refreshProjectIndex();
      if (state.sessions.get(modulePath) !== session) {
        finishProvisionalNavigation(provisional);
        return;
      }
      const latestAfterRefresh =
        session === currentSession()
          ? state.document.source
          : sessionSource(session);
      if (
        session.editRevision !== revision ||
        latestAfterRefresh !== source ||
        latestAfterRefresh !== session.savedSource
      ) {
        session.conflict =
          `${modulePath} changed on disk while this page had local edits.`;
        if (session === currentSession()) {
          state.workspaceError = session.conflict;
          updateStatusOnly();
        }
        finishProvisionalNavigation(provisional);
        return;
      }
      const refreshedEntry = state.project?.documents.find(
        (entry) => entry.module === modulePath,
      );
      if (!refreshedEntry) {
        throw new Error(`Module ${modulePath} no longer exists.`);
      }
      if (refreshedEntry.version !== payload.digest) {
        if (refreshRetry < 1) {
          return revalidateCachedSession(
            session,
            provisional,
            refreshRetry + 1,
          );
        }
        throw new Error(
          `Module ${modulePath} changed again while it was revalidating.`,
        );
      }
    }
    session.document = document;
    session.savedSource = document.source;
    session.savedVersion = payload.digest || document.version;
    session.editorState = replaceEditorStateDocument(
      session.editorState,
      document.source,
    );
    session.evaluation = null;
    session.evaluationPlan = null;
    session.evaluationInvalidation = null;
    session.executionCore = null;
    session.executionProblem = null;
    if (session === currentSession()) {
      restoreSession(session);
      state.workspaceError = state.outlineConflict || null;
      finishProvisionalNavigation(provisional);
      render();
      void loadDependencyContext(modulePath);
      scheduleEvaluation(document.source, { immediate: true });
    } else {
      finishProvisionalNavigation(provisional);
    }
  } catch (error) {
    let project = null;
    try {
      project = await refreshProjectIndex();
    } catch {
      // The direct read error remains the useful navigation failure.
    }
    if (state.sessions.get(modulePath) !== session) {
      finishProvisionalNavigation(provisional);
      return;
    }
    const stillExists = project?.documents?.some(
      (entry) => entry.module === modulePath,
    );
    if (stillExists) {
      finishProvisionalNavigation(provisional);
      return;
    }
    if (session.document.source !== session.savedSource) {
      session.conflict = error.message;
      if (session === currentSession()) {
        state.workspaceError = error.message;
        updateStatusOnly();
      }
      finishProvisionalNavigation(provisional);
      return;
    }
    if (state.module !== modulePath) {
      state.sessions.delete(modulePath);
      finishProvisionalNavigation(provisional);
      return;
    }
    await rollbackProvisionalNavigation(provisional, error.message);
  }
}

function currentProjectDocument() {
  return state.project?.documents.find(
    (document) => document.module === state.module,
  );
}

function evaluationStatus() {
  if (state.evaluating) return { label: "Evaluating…", className: "" };
  if (state.evaluationInvalidation) {
    return { label: "Results out of date", className: "" };
  }
  if (state.executionProblem) {
    return { label: "Needs attention", className: "status-error" };
  }
  if (state.evaluation?.ok) return { label: "Ready", className: "status-ok" };
  if (state.evaluation) {
    return { label: "Needs attention", className: "status-error" };
  }
  return { label: "Not evaluated", className: "" };
}

function disposeMountedEditors() {
  if (state.completionPositionFrame !== null) {
    cancelAnimationFrame(state.completionPositionFrame);
    state.completionPositionFrame = null;
  }
  const sourceEditor = state.sourceEditorView;
  if (sourceEditor) {
    if (sourceEditor.doxModule === state.module) {
      const session = currentSession();
      if (session) {
        session.editorState ??= sourceEditor.state;
        session.scrollTop = sourceEditor.scrollDOM.scrollTop;
      }
    }
    sourceEditor.destroy();
    state.sourceEditorView = null;
  }
}

const sourceModeOrder = ["literate", "source"];
const sourceModeName = {
  literate: "Document",
  source: "Source",
};

function nextSourceMode(mode = state.sourceMode) {
  const index = sourceModeOrder.indexOf(mode);
  return sourceModeOrder[(Math.max(0, index) + 1) % sourceModeOrder.length];
}

function renderShell() {
  disposeMountedEditors();
  const existingSidebar = app.querySelector(".sidebar");
  app.innerHTML = `
    <div
      class="workspace ${state.view === "document" ? "document-context" : ""} ${state.sourceMode === "source" ? "source-context" : ""} ${state.inspectorExpanded ? "inspector-expanded" : ""}"
      style="--sidebar-width: ${state.paneWidths.sidebar}px; --inspector-width: ${state.paneWidths.inspector}px"
    >
      <div class="body-grid">
        <aside class="sidebar">${renderSidebar()}</aside>
        <button class="sidebar-backdrop" id="files-backdrop" type="button" aria-label="Close project files"></button>
        <div class="pane-resizer pane-resizer-left" data-pane-resizer="sidebar" role="separator" aria-label="Resize module pane" aria-orientation="vertical" tabindex="0"></div>
        <button class="pane-toggle files-toggle" id="files-toggle" type="button" aria-label="Show project files" aria-expanded="false" title="Show project files"><span class="files-toggle-icon" aria-hidden="true"></span></button>
        <main class="main" id="main-pane">
          <div class="main-actions">
            <button class="button secondary-action ${state.sourceMode !== "literate" ? "active" : ""}" id="source-mode-button" aria-label="Switch to ${sourceModeName[nextSourceMode()]} view">${sourceModeName[nextSourceMode()]}</button>
          </div>
          ${renderMain()}
        </main>
        <div class="pane-resizer pane-resizer-right" data-pane-resizer="inspector" role="separator" aria-label="Resize context pane" aria-orientation="vertical" tabindex="0"></div>
        <aside class="inspector">${renderInspector()}</aside>
        <button type="button" class="inspector-width-toggle" id="inspector-width-toggle" aria-label="${state.inspectorExpanded ? "Restore context pane width" : "Expand context pane"}" aria-keyshortcuts="Meta+Shift+Enter Control+Shift+Enter" aria-pressed="${state.inspectorExpanded}" title="${state.inspectorExpanded ? "Restore context pane" : "Expand context pane"} (Command/Control–Shift–Enter)"><span aria-hidden="true">${state.inspectorExpanded ? "⤡" : "⤢"}</span></button>
      </div>
      ${
        state.workspaceError
          ? `<footer class="statusbar status-error" aria-live="assertive">${escapeHtml(state.workspaceError)}</footer>`
          : '<footer class="statusbar" aria-hidden="true"></footer>'
      }
    </div>
  `;
  if (existingSidebar) {
    app.querySelector(".sidebar")?.replaceWith(existingSidebar);
  }
  syncEvaluationEngineToggle();
  bindEvents();
}

function renderSidebar() {
  if (!state.project?.documents.length) {
    return `<div class="sidebar-brand">Dox</div><div class="module-outline-host" data-module-outline aria-label="Editable module outline"></div>${renderEvaluationEngineToggle()}`;
  }
  return `
    <div class="sidebar-brand">Dox</div>
    <div class="module-outline-host" data-module-outline aria-label="Editable module outline"></div>
    ${renderEvaluationEngineToggle()}
  `;
}

function renderEvaluationEngineToggle() {
  const browser = state.evaluationEngine === "browser";
  const evaluationState = state.evaluating
    ? "evaluating"
    : state.evaluation?.ok
      ? "ready"
      : state.evaluation
        ? "error"
        : "idle";
  return `<button class="evaluation-engine-toggle" id="evaluation-engine-toggle" type="button" aria-pressed="${browser}" data-evaluation-state="${evaluationState}" title="Run OxCaml ${browser ? "in this browser" : "on the local Dox server"}"><span class="evaluation-engine-dot" aria-hidden="true"></span>${browser ? "Browser" : "Server"}</button>`;
}

function syncEvaluationEngineToggle() {
  const toggle = document.querySelector("#evaluation-engine-toggle");
  if (!toggle) return;
  const browser = state.evaluationEngine === "browser";
  toggle.setAttribute("aria-pressed", String(browser));
  toggle.title = `Run OxCaml ${browser ? "in this browser" : "on the local Dox server"}`;
  toggle.lastChild.textContent = browser ? "Browser" : "Server";
  toggle.dataset.evaluationState = state.evaluating
    ? "evaluating"
    : state.evaluation?.ok
      ? "ready"
      : state.evaluation
        ? "error"
        : "idle";
}

function normalizeOutlineEntries(project) {
  const raw = project?.pageIndex?.outline || [];
  const stack = [];
  return raw.map((entry, index) => {
    const text = entry.text || "";
    const spaces = text.match(/^ */)?.[0].length || 0;
    const depth = entry.depth ?? spaces / 2;
    const component = text.slice(spaces);
    stack.length = depth;
    stack.push(component);
    const path = entry.path || stack.join(".");
    const pageModule = entry.pageModule ?? null;
    const namespace = Boolean(entry.namespace || entry.hasChildren);
    return {
      ...entry,
      rowId: entry.rowId || `${path}\u0000${pageModule || ""}`,
      sourceLine: index + 1,
      text,
      depth,
      component,
      path,
      pageModule,
      namespace,
      hasChildren: entry.hasChildren ?? Boolean(entry.namespace),
      originPath: path,
      originModule: pageModule,
      originNamespace: namespace,
      originTarget: pageModule,
      proposedPath: path,
      changed: false,
    };
  });
}

function outlineFingerprint(entries) {
  return entries
    .map((entry) =>
      [
        entry.rowId,
        entry.path,
        entry.pageModule || "",
        entry.namespace ? "n" : "p",
      ].join("\u0001"),
    )
    .join("\u0000");
}

function captureOutlineCursor() {
  const view = state.outlineView;
  if (!view) return null;
  const position = Math.min(
    state.outlineSelection,
    view.state.doc.length,
  );
  const line = view.state.doc.lineAt(position);
  const row = state.outlineLineMap.find(
    (candidate) => candidate.sourceLine === line.number,
  );
  const modulePath =
    row?.originTarget || row?.targetModule || row?.pageModule || null;
  const path = row?.proposedPath || row?.path || null;
  if (!modulePath && !path) return null;
  return {
    modulePath,
    path,
    column: position - line.from,
  };
}

function outlinePositionForCursor(entries, cursor) {
  if (!cursor) return null;
  let offset = 0;
  for (const entry of entries) {
    if (
      (cursor.modulePath && entry.pageModule === cursor.modulePath) ||
      (cursor.path && entry.path === cursor.path)
    ) {
      return offset + Math.min(cursor.column, entry.text.length);
    }
    offset += entry.text.length + 1;
  }
  return null;
}

function outlinePositionForModule(entries, modulePath) {
  let offset = 0;
  for (const entry of entries) {
    if (
      entry.pageModule === modulePath ||
      entry.targetModule === modulePath ||
      entry.originTarget === modulePath
    ) {
      return offset + entry.text.length;
    }
    offset += entry.text.length + 1;
  }
  return null;
}

function installOutlineBase(project, entries, { keepDraft = false } = {}) {
  const cursor = keepDraft ? null : captureOutlineCursor();
  const text = entries.map((entry) => entry.text).join("\n");
  state.outlineBase = {
    projectVersion: project.version,
    committedText: text,
    committedRowsWithOrigins: entries,
    fingerprint: outlineFingerprint(entries),
  };
  state.outlineCommittedText = text;
  if (!keepDraft) {
    state.outlineText = text;
    state.outlineDraftRows = entries;
    state.outlineLineMap = entries;
    state.outlineSelection =
      outlinePositionForCursor(entries, cursor) ??
      Math.min(state.outlineSelection, text.length);
    state.outlineDraftError = null;
    state.outlineConflict = null;
    state.outlineFailedGeneration = null;
  } else {
    try {
      const draft = preserveBlankOutlineOrigins(
        state.outlineText,
        parseOutlineDraft(state.outlineText, {
          previousRows: state.outlineDraftRows,
        }),
        state.outlineDraftRows,
      );
      state.outlineDraftRows = draft.rows;
      state.outlineLineMap = draft.lineMap;
      state.outlineDraftError = null;
      state.outlineConflict = null;
    } catch (error) {
      state.outlineDraftError = error;
    }
  }
}

function installProjectSnapshot(
  project,
  {
    forceOutline = false,
    installEpoch = ++state.projectRequestEpoch,
  } = {},
) {
  if (!project || installEpoch < state.projectInstallEpoch) return false;
  state.projectInstallEpoch = installEpoch;
  const entries = normalizeOutlineEntries(project);
  const fingerprint = outlineFingerprint(entries);
  const dirty =
    state.outlineText !== state.outlineCommittedText ||
    Boolean(state.outlineDraftError);
  state.project = project;
  state.projectVersion = project.version;
  if (!state.outlineBase || forceOutline || !dirty) {
    installOutlineBase(project, entries);
  } else if (fingerprint === state.outlineBase.fingerprint) {
    installOutlineBase(project, entries, { keepDraft: true });
  } else {
    state.outlineConflict =
      "The module tree changed while this outline draft was being edited. Press Escape to reload it.";
    state.workspaceError = state.outlineConflict;
  }
  syncOutlineEditor();
  updateStatusOnly();
  return true;
}

function installAuthoritativeProject(project, options = {}) {
  return installProjectSnapshot(project, {
    ...options,
    installEpoch: ++state.projectRequestEpoch,
  });
}

function refreshOutlineModel({ force = false } = {}) {
  if (!state.outlineBase || force) {
    installProjectSnapshot(state.project, { forceOutline: true });
  }
  return {
    entries: state.outlineLineMap,
    text: state.outlineCommittedText,
  };
}

function mappedPreviousRows(previousRows, update) {
  const mapped = new Map();
  if (!previousRows?.length) return mapped;
  if (!update) {
    for (const row of previousRows) {
      if (!mapped.has(row.sourceLine)) mapped.set(row.sourceLine, row);
      else mapped.set(row.sourceLine, null);
    }
    return mapped;
  }
  for (const row of previousRows) {
    if (!row.sourceLine || row.sourceLine > update.startState.doc.lines) continue;
    const position = update.startState.doc.line(row.sourceLine).from;
    const nextPosition = update.changes.mapPos(position, 1);
    const nextLine = update.state.doc.lineAt(
      Math.min(nextPosition, update.state.doc.length),
    ).number;
    if (!mapped.has(nextLine)) mapped.set(nextLine, row);
    else mapped.set(nextLine, null);
  }
  return mapped;
}

function carryOutlineRowsThroughUpdate(previousRows, update) {
  return Array.from(mappedPreviousRows(previousRows, update).entries())
    .filter(([, row]) => Boolean(row))
    .map(([sourceLine, row]) => ({ ...row, sourceLine }));
}

function carryOutlineRowsThroughMove(previousRows, moveOrigins) {
  const byLine = new Map(
    previousRows.map((row) => [row.sourceLine, row]),
  );
  return moveOrigins.flatMap((originLine, index) => {
    const row = byLine.get(originLine);
    return row ? [{ ...row, sourceLine: index + 1 }] : [];
  });
}

function parseOutlineDraft(source, { previousRows = [], update = null } = {}) {
  const raw = source.split("\n");
  const rows = [];
  const stack = [];
  for (let index = 0; index < raw.length; index += 1) {
    const text = raw[index];
    if (!text.trim()) continue;
    const spaces = text.match(/^ */)?.[0].length || 0;
    if (spaces % 2 !== 0) {
      throw new Error(`Line ${index + 1} must use two spaces per level.`);
    }
    const depth = spaces / 2;
    const component = text.slice(spaces);
    if (!/^[A-Z][A-Za-z0-9_']*$/.test(component)) {
      throw new Error(
        `Line ${index + 1} is not an OCaml module component.`,
      );
    }
    if (depth > stack.length) {
      throw new Error(`Line ${index + 1} skips a namespace level.`);
    }
    stack.length = depth;
    stack.push(component);
    rows.push({
      sourceLine: index + 1,
      depth,
      component,
      proposedPath: stack.join("."),
    });
  }
  for (let index = 0; index < rows.length; index += 1) {
    rows[index].hasChildren =
      index + 1 < rows.length && rows[index + 1].depth > rows[index].depth;
  }
  const baseRows = state.outlineBase?.committedRowsWithOrigins || [];
  const baseByPath = new Map();
  for (const entry of baseRows) {
    const values = baseByPath.get(entry.path) || [];
    values.push(entry);
    baseByPath.set(entry.path, values);
  }
  const previousByLine = mappedPreviousRows(previousRows, update);
  const claimed = new Set();
  for (const row of rows) {
    const exact = baseByPath.get(row.proposedPath) || [];
    const mapped = previousByLine.get(row.sourceLine);
    let origin =
      exact.length === 1 && !claimed.has(exact[0].rowId)
        ? exact[0]
        : mapped?.rowId && !claimed.has(mapped.rowId)
          ? mapped
          : null;
    if (origin) claimed.add(origin.rowId);
    const originNamespace = Boolean(
      origin?.originNamespace ?? origin?.namespace,
    );
    const namespace = row.hasChildren;
    const originModule = origin?.originModule || null;
    const targetModule = origin?.originPath
      ? originModule
        ? row.proposedPath
        : null
      : row.proposedPath;
    Object.assign(row, {
      rowId: origin?.rowId || `draft:${state.outlineDraftGeneration}:${row.sourceLine}`,
      originPath: origin?.originPath || null,
      originModule,
      originNamespace,
      originTarget: originModule,
      path: row.proposedPath,
      pageModule: targetModule,
      namespace,
      targetModule,
      changed:
        !origin ||
        origin.originPath !== row.proposedPath ||
        originNamespace !== namespace,
      text: raw[row.sourceLine - 1],
    });
  }
  const duplicate = duplicateOutlineModule(rows);
  if (duplicate) {
    const error = new Error(
      `Line ${duplicate.lines[1]} duplicates ${duplicate.modulePath} on line ${duplicate.lines[0]}.`,
    );
    error.outlineLines = duplicate.lines;
    throw error;
  }
  const modules = rows.flatMap((row) =>
    row.targetModule ? [row.targetModule] : [],
  );
  const lineMap = raw.map((_, index) =>
    rows.find((row) => row.sourceLine === index + 1) || null,
  );
  return { rows, modules, lineMap };
}

function preserveBlankOutlineOrigins(
  source,
  draft,
  previousRows,
  update = null,
) {
  const lines = source.split("\n");
  const previousByLine = mappedPreviousRows(previousRows, update);
  const placeholders = [];
  const lineMap = [...draft.lineMap];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() || lineMap[index]) continue;
    const previous = previousByLine.get(index + 1);
    if (!previous?.originPath && !previous?.originModule) continue;
    const placeholder = {
      ...previous,
      sourceLine: index + 1,
      text: lines[index],
      component: "",
      pageModule: null,
      targetModule: null,
      changed: true,
      blank: true,
    };
    placeholders.push(placeholder);
    lineMap[index] = placeholder;
  }
  return {
    ...draft,
    rows: [...draft.rows, ...placeholders].sort(
      (left, right) => left.sourceLine - right.sourceLine,
    ),
    lineMap,
  };
}

function outlineRowAtLine(lineNumber) {
  return state.outlineLineMap[lineNumber - 1] || null;
}

function rewriteModulePaths(source, mapping) {
  const entries = [...mapping].sort(
    (left, right) => right.before.length - left.before.length,
  );
  let result = "";
  for (let index = 0; index < source.length; ) {
    const match = entries.find(({ before }) => {
      if (!source.startsWith(before, index)) return false;
      const prior = index > 0 ? source[index - 1] : "";
      const after = source[index + before.length] || "";
      const identifier = /[A-Za-z0-9_']/;
      return (!prior || (!identifier.test(prior) && prior !== ".")) &&
        (!after || after === "." || !identifier.test(after));
    });
    if (match) {
      result += match.after;
      index += match.before.length;
    } else {
      result += source[index];
      index += 1;
    }
  }
  return result;
}

async function refreshSessionsAfterRefactor(mapping, project, bases) {
  const renamed = new Map(mapping.map(({ before, after }) => [before, after]));
  captureCurrentSession();
  state.navigationGeneration += 1;
  state.navigationController?.abort();
  state.navigationController = null;
  state.requestController?.abort();
  state.requestController = null;
  clearPendingNavigation();
  state.provisionalNavigation = null;
  const entries = Array.from(state.sessions.entries());
  const currentModule = renamed.get(state.module) || state.module;
  const payloads = new Map();
  for (const [oldModule, session] of entries) {
    const modulePath = renamed.get(oldModule) || oldModule;
    const payload = await api(
      `/api/page?module=${encodeURIComponent(modulePath)}`,
    );
    const expected = project.documents.find(
      (entry) => entry.module === modulePath,
    );
    const digest = payload.digest || payload.document.version;
    if (!expected || expected.version !== digest) {
      throw new Error(
        `Module ${modulePath} changed while refactor sessions were refreshing.`,
      );
    }
    payloads.set(oldModule, { modulePath, payload, session });
  }

  let refreshed = null;
  for (let pass = 0; pass < 5 && !refreshed; pass += 1) {
    const staged = [];
    const revisions = new Map(
      entries.map(([oldModule, session]) => [
        oldModule,
        session.editRevision,
      ]),
    );
    for (const [oldModule] of entries) {
      const { modulePath, payload, session } = payloads.get(oldModule);
      const savedSource = payload.document.source;
      const baseSource = bases.get(oldModule)?.source ?? session.savedSource;
      const draft = sessionSource(session);
      let source = savedSource;
      let changedDuringRefactor = false;
      if (draft !== baseSource) {
        const rewritten = await api("/api/refactor/rewrite", {
          method: "POST",
          body: JSON.stringify({
            path: session.path,
            source: draft,
            renames: mapping,
          }),
        });
        source = rewritten.source;
        changedDuringRefactor = true;
      }
      staged.push({
        oldModule,
        modulePath,
        payload,
        session,
        source,
        changedDuringRefactor,
        editorState:
          modulePath === oldModule
            ? replaceEditorStateDocument(session.editorState, source)
            : null,
      });
    }
    if (
      entries.every(
        ([oldModule, session]) =>
          session.editRevision === revisions.get(oldModule),
      )
    ) {
      refreshed = staged;
    }
  }
  if (!refreshed) {
    throw new Error(
      "Pause typing briefly so the completed refactor can rebase this draft.",
    );
  }

  const nextSessions = new Map(state.sessions);
  const recoveryDestinations = new Set();
  for (const {
    oldModule,
    modulePath,
    payload,
    session,
    source,
    changedDuringRefactor,
    editorState,
  } of refreshed) {
    const savedSource = payload.document.source;
    if (nextSessions.get(oldModule) === session) {
      nextSessions.delete(oldModule);
    }
    if (session.collaboration && session.collaboration.text.toString() !== source) {
      session.collaboration.doc.transact(() => {
        session.collaboration.text.delete(0, session.collaboration.text.length);
        session.collaboration.text.insert(0, source);
      });
    }
    session.module = modulePath;
    session.path = payload.document.path;
    session.document = changedDuringRefactor
      ? {
          ...payload.document,
          source,
          blocks: parseDraftBlocks(source),
        }
      : payload.document;
    session.editorState = replaceEditorStateDocument(editorState, source);
    session.savedSource = savedSource;
    session.savedVersion = payload.digest || payload.document.version;
    session.provisional = false;
    session.persistenceModule = null;
    session.evaluation = null;
    session.evaluationPlan = null;
    session.evaluationInvalidation = null;
    session.executionCore = null;
    session.executionProblem = null;
    session.conflict = null;
    session.autosaveQueued = changedDuringRefactor && !session.collaboration;
    if (changedDuringRefactor && !session.collaboration) {
      storeRecoveryDraft(session, source);
      recoveryDestinations.add(modulePath);
    }
    nextSessions.set(modulePath, session);
  }
  for (const { oldModule, modulePath, changedDuringRefactor } of refreshed) {
    if (!recoveryDestinations.has(oldModule)) clearRecoveryDraft(oldModule);
    if (!changedDuringRefactor) clearRecoveryDraft(modulePath);
  }
  state.sessions = nextSessions;
  state.module = currentModule;
  const current = state.sessions.get(currentModule);
  if (current) {
    restoreSession(current);
    updateRoute(currentModule, "replace");
  }
  return project;
}

async function drainDirtySessions() {
  captureCurrentSession();
  for (let pass = 0; pass < 5; pass += 1) {
    const dirty = Array.from(state.sessions.values()).filter((session) => {
      if (session.provisional) return false;
      const source = sessionSource(session);
      return source !== session.savedSource;
    });
    if (!dirty.length) {
      return new Map(
        Array.from(state.sessions.entries())
          .filter(([, session]) => !session.provisional)
          .map(([modulePath, session]) => [
            modulePath,
            {
              source: sessionSource(session),
              revision: session.editRevision,
            },
          ]),
      );
    }
    for (const session of dirty) {
      if (!(await drainAutosave(session))) {
        throw new Error(
          `Could not save ${session.module} before refactoring.`,
        );
      }
    }
  }
  throw new Error("Pause typing briefly so the refactor can catch up.");
}

function outlineModules(entries) {
  return entries.flatMap((entry) => {
    const modulePath = entry.targetModule || entry.pageModule;
    return modulePath ? [modulePath] : [];
  });
}

function mappedNamespacePath(originPath, mapping) {
  const direct = mapping.get(originPath);
  if (direct) return direct;
  const descendant = Array.from(mapping.entries()).find(([before]) =>
    before.startsWith(`${originPath}.`),
  );
  if (!descendant) return originPath;
  const [before, after] = descendant;
  const suffix = before.slice(originPath.length);
  return after.endsWith(suffix)
    ? after.slice(0, after.length - suffix.length)
    : null;
}

function rebaseOutlineRowsThroughMapping(rows, mapping, authoritativeRows) {
  if (!mapping.length) return rows;
  const renamed = new Map(
    mapping.map(({ before, after }) => [before, after]),
  );
  const byPath = new Map();
  for (const row of authoritativeRows) {
    const matches = byPath.get(row.path) || [];
    matches.push(row);
    byPath.set(row.path, matches);
  }
  return rows.map((row) => {
    if (!row.originPath && !row.originModule) {
      return row;
    }
    const mappedModule = row.originModule
      ? renamed.get(row.originModule) || row.originModule
      : null;
    const mappedPath =
      mappedModule || mappedNamespacePath(row.originPath, renamed);
    const candidates = byPath.get(mappedPath) || [];
    if (candidates.length !== 1) {
      throw new Error(
        `The newer outline draft could not be mapped through ${row.originPath}.`,
      );
    }
    const origin = candidates[0];
    return {
      ...row,
      rowId: origin.rowId,
      originPath: origin.originPath,
      originModule: origin.originModule,
      originNamespace: origin.originNamespace,
      originTarget: origin.originTarget,
    };
  });
}

function commitOutline(options = {}) {
  if (state.outlineCommitPromise) {
    const activeCommit = state.outlineCommitPromise;
    return activeCommit.then((committed) => {
      if (!committed) return false;
      return commitOutline(options);
    });
  }
  const promise = performOutlineCommit(options);
  state.outlineCommitPromise = promise;
  void promise.then(
    () => {
      if (state.outlineCommitPromise === promise) {
        state.outlineCommitPromise = null;
      }
    },
    () => {
      if (state.outlineCommitPromise === promise) {
        state.outlineCommitPromise = null;
      }
    },
  );
  return promise;
}

async function performOutlineCommit({
  reason = "explicit",
  openModule = null,
} = {}) {
  if (state.outlineCommitting) {
    return false;
  }
  if (state.outlineDraftError) {
    state.workspaceError = state.outlineDraftError.message;
    updateStatusOnly();
    return false;
  }
  if (state.outlineConflict) {
    state.workspaceError = state.outlineConflict;
    updateStatusOnly();
    return false;
  }
  if (state.outlineText === state.outlineCommittedText) {
    return true;
  }

  const submittedDraft = state.outlineText;
  const submittedGeneration = state.outlineDraftGeneration;
  const submittedCursorLine =
    state.outlineView?.state.doc.lineAt(state.outlineSelection).number || 1;
  const draft = parseOutlineDraft(submittedDraft, {
    previousRows: state.outlineDraftRows,
  });
  const submittedCursorRow = draft.rows.find(
    (row) => row.sourceLine === submittedCursorLine,
  );
  const submittedCursorDocumentLine =
    state.outlineView?.state.doc.line(submittedCursorLine);
  const submittedCursorColumn = submittedCursorDocumentLine
    ? state.outlineSelection - submittedCursorDocumentLine.from
    : 0;
  const operation = deriveOutlineOperation({
    committedRows: state.outlineBase?.committedRowsWithOrigins || [],
    draftRows: draft.rows,
    openModule,
  });
  const next = operation.order;
  const renames = operation.renames || [];
  const deleted = operation.deleted || [];
  const created = operation.created || [];
  if (
    operation.kind === "none" &&
    state.outlineText !== state.outlineCommittedText
  ) {
    if (!submittedDraft.split("\n").some((line) => !line.trim())) {
      installProjectSnapshot(state.project, { forceOutline: true });
    }
    return true;
  }
  state.outlineCommitting = true;
  state.outlineOperation = operation;
  state.outlineSubmittedGeneration = submittedGeneration;
  const controller = new AbortController();
  state.outlineCommitController = controller;
  let authoritativeProject = null;
  let appliedMapping = [];
  let collaborationWarning = null;
  let releaseProjectMutation = null;
  try {
    if (operation.kind === "ambiguous") {
      throw new Error(
        "Create, rename, and delete pages in separate outline operations.",
      );
    }
    if (deleted.length) {
      const description =
        deleted.length === 1
          ? deleted[0]
          : `${deleted.length} pages`;
      if (!window.confirm(`Move ${description} to Dox trash?`)) {
        cancelOutlineDraft();
        return false;
      }
    }
    if (renames.length || created.length || deleted.length) {
      if (new Set(renames.map(({ after }) => after)).size !== renames.length) {
        throw new Error(
          "This outline edit is ambiguous. Rename or move one module at a time.",
        );
      }
      state.refactorInFlight = true;
      const refactorBases = await drainDirtySessions();
      if (state.outlineConflict) throw new Error(state.outlineConflict);
      releaseProjectMutation = await acquireProjectMutation();
      authoritativeProject = state.project;
      if (renames.length) {
        const projectVersion = authoritativeProject.version;
        const preview = await api("/api/refactor/preview", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({ projectVersion, renames, order: next }),
        });
        const payload = await api("/api/refactor/apply", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            projectVersion,
            previewId: preview.previewId,
            renames,
            order: next,
          }),
        });
        appliedMapping = payload.mapping || [];
        collaborationWarning ||= payload.collaborationWarning || null;
        authoritativeProject = payload.project;
        migrateRecoveryDraftKeys(appliedMapping);
        state.refactorModuleMapping = new Map(
          appliedMapping.map(({ before, after }) => [before, after]),
        );
        const sessionRefresh = refreshSessionsAfterRefactor(
          payload.mapping,
          payload.project,
          refactorBases,
        );
        state.refactorSessionRefresh = sessionRefresh;
        try {
          await sessionRefresh;
        } finally {
          if (state.refactorSessionRefresh === sessionRefresh) {
            state.refactorSessionRefresh = null;
          }
        }
      }
      let createdDocuments = [];
      if (created.length) {
        const payload = await api("/api/pages", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            modules: created,
            order: next,
            baseProjectVersion: authoritativeProject.version,
          }),
        });
        authoritativeProject = payload.project;
        createdDocuments = payload.documents || [];
      }
      if (deleted.length) {
        const payload = await api("/api/pages", {
          method: "DELETE",
          signal: controller.signal,
          body: JSON.stringify({
            modules: deleted,
            order: next,
            baseProjectVersion: authoritativeProject.version,
          }),
        });
        authoritativeProject = payload.project;
        collaborationWarning ||= payload.collaborationWarning || null;
        operation.trashPath = payload.trashPath;
        for (const modulePath of deleted) {
          state.sessions.get(modulePath)?.collaboration?.destroy();
          state.sessions.delete(modulePath);
          clearRecoveryDraft(modulePath);
        }
      }
      operation.createdDocuments = createdDocuments;
    } else {
      authoritativeProject = state.project;
    }

    const authoritativeOrder = outlineModules(
      normalizeOutlineEntries(authoritativeProject),
    );
    const shouldPersistOrder =
      authoritativeOrder.length !== next.length ||
      authoritativeOrder.some(
        (modulePath, index) => modulePath !== next[index],
      );
    if (shouldPersistOrder) {
      releaseProjectMutation ??= await acquireProjectMutation();
      const payload = await api("/api/page-order", {
        method: "PUT",
        signal: controller.signal,
        body: JSON.stringify({
          modules: next,
          baseOrder: authoritativeOrder,
          baseProjectVersion: authoritativeProject.version,
        }),
      });
      authoritativeProject = payload.project;
    }

    const draftAdvanced = state.outlineDraftGeneration > submittedGeneration;
    const retainsInsertionRow = !deleted.length && submittedDraft
      .split("\n")
      .some((line) => !line.trim());
    const retainsActiveDraft = draft.rows.some(
      (row) => row.changed && row.sourceLine === submittedCursorLine,
    );
    const newerDraft = deleted.length
      ? null
      : draftAdvanced
        ? state.outlineText
        : !openModule && (retainsInsertionRow || retainsActiveDraft)
          ? submittedDraft
          : null;
    const newerRows =
      newerDraft !== null
        ? draftAdvanced
          ? state.outlineDraftRows
          : draft.rows
        : null;
    installAuthoritativeProject(authoritativeProject, { forceOutline: true });
    for (let index = 0; index < created.length; index += 1) {
      confirmOptimisticPage(created[index], operation.createdDocuments?.[index]);
    }
    if (newerDraft !== null) {
      state.outlineText = newerDraft;
      try {
        const rebasedRows = rebaseOutlineRowsThroughMapping(
          newerRows,
          appliedMapping,
          state.outlineBase.committedRowsWithOrigins,
        );
        const reparsed = parseOutlineDraft(newerDraft, {
          previousRows: rebasedRows,
        });
        state.outlineDraftRows = reparsed.rows;
        state.outlineLineMap = reparsed.lineMap;
      } catch (error) {
        state.outlineDraftRows = newerRows.map((row) => ({
          ...row,
          rowId: `unmapped:${row.sourceLine}`,
          originPath: null,
          originModule: null,
          originTarget: null,
        }));
        state.outlineLineMap = newerDraft.split("\n").map((text, index) => ({
          ...(state.outlineDraftRows.find(
            (row) => row.sourceLine === index + 1,
          ) || {}),
          text,
        }));
        state.outlineConflict =
          `${error.message} Press Escape to reload the committed outline.`;
        state.workspaceError = state.outlineConflict;
      }
    }
    state.outlineFailedGeneration = null;
    if (!state.outlineConflict) state.workspaceError = collaborationWarning;
    invalidateDependencyContext({ clear: true });
    const openedModule = remapModule(openModule, appliedMapping);
    const cursorModule = remapModule(
      submittedCursorRow?.targetModule ||
        submittedCursorRow?.originTarget ||
        null,
      appliedMapping,
    );
    const cursorPath = appliedMapping.reduce(
      (path, mapping) =>
        path === mapping.before
          ? mapping.after
          : path?.startsWith(`${mapping.before}.`)
            ? mapping.after + path.slice(mapping.before.length)
            : path,
      submittedCursorRow?.proposedPath || submittedCursorRow?.path || null,
    );
    const currentEntries =
      newerDraft !== null
        ? state.outlineDraftRows
        : state.outlineBase.committedRowsWithOrigins;
    const deletedCurrent = deleted.includes(state.module);
    const deletedIndex = operation.previous?.indexOf(state.module) ?? -1;
    const fallbackModule = deletedCurrent
      ? next[Math.min(Math.max(deletedIndex, 0), next.length - 1)] || null
      : null;
    if (deletedCurrent) {
      state.module = null;
      state.path = null;
      state.document = null;
      state.savedVersion = null;
      state.savedSource = null;
      state.evaluation = null;
      state.executionCore = null;
      state.executionProblem = null;
    }
    const cursorPosition = outlinePositionForCursor(currentEntries, {
      modulePath: cursorModule,
      path: cursorPath,
      column: submittedCursorColumn,
    });
    if (cursorPosition !== null) state.outlineSelection = cursorPosition;
    if (openedModule) {
      const position = outlinePositionForModule(
        currentEntries,
        openedModule,
      );
      if (position !== null) state.outlineSelection = position;
    }
    if (reason === "reorder") state.outlineFocusTransfer = true;
    if (
      state.module &&
      window.location.pathname !== `/page/${encodeURIComponent(state.module)}`
    ) {
      updateRoute(state.module, "replace");
    }
    render();
    if (deletedCurrent && fallbackModule) {
      await loadDocument(fallbackModule, {
        force: true,
        history: "replace",
        focus: "outline",
      });
      toast(
        `${deleted.length === 1 ? deleted[0] : `${deleted.length} pages`} moved to Dox trash.`,
      );
      return true;
    }
    if (state.document && !state.executionCore) {
      scheduleEvaluation(state.document.source, {
        immediate: true,
        plan: buildExecutionPlan(state.document.source, state.document.blocks),
      });
    }
    syncOutlineEditor({
      moveSelection: cursorPosition !== null || Boolean(openedModule),
    });
    if (reason === "reorder") {
      queueMicrotask(() => {
        state.outlineView?.focus();
        queueMicrotask(() => {
          state.outlineFocusTransfer = false;
        });
      });
    }
    state.outlineOptimisticRefactor = null;
    if (state.module) void loadDependencyContext(state.module);
    if (deleted.length) {
      toast(
        `${deleted.length === 1 ? deleted[0] : `${deleted.length} pages`} moved to Dox trash.`,
      );
    }
    return true;
  } catch (error) {
    if (await reconcileCreatedOperation(operation)) return true;
    if (!appliedMapping.length) rollbackOptimisticRefactor();
    if (authoritativeProject && appliedMapping.length) {
      const outlineText = state.outlineText;
      const outlineRows = state.outlineDraftRows;
      migrateRecoveryDraftKeys(appliedMapping);
      installAuthoritativeProject(authoritativeProject, {
        forceOutline: true,
      });
      state.outlineText = outlineText;
      state.outlineDraftRows = outlineRows.map((row) => ({
        ...row,
        rowId: `unmapped:${row.sourceLine}`,
        originPath: null,
        originModule: null,
        originTarget: null,
      }));
      state.outlineLineMap = outlineText.split("\n").map((text, index) => ({
        ...(state.outlineDraftRows.find(
          (row) => row.sourceLine === index + 1,
        ) || {}),
        text,
      }));
      state.outlineConflict =
        "The refactor committed, but local page sessions could not be refreshed. Browser recovery drafts were preserved; press Escape to reload the module outline.";
      syncOutlineEditor();
    }
    if (error.name !== "AbortError") {
      state.outlineFailedGeneration = submittedGeneration;
      state.workspaceError = state.outlineConflict
        ? `${state.outlineConflict} ${error.message}`
        : error.message;
      updateStatusOnly();
    }
    return false;
  } finally {
    releaseProjectMutation?.();
    state.refactorModuleMapping = null;
    state.refactorInFlight = false;
    state.outlineOptimisticRefactor = null;
    state.outlineOperation = null;
    for (const session of state.sessions.values()) {
      if (session.collaborationIdentityPending) {
        reconcileCollaborativeIdentity(
          session,
          session.collaborationIdentityPending,
        );
      }
      if (session.autosaveQueued) scheduleAutosave(session, { immediate: true });
    }
    if (state.outlineCommitController === controller) {
      state.outlineCommitController = null;
    }
    state.outlineCommitting = false;
  }
}

function syncOutlineEditor({ moveSelection = false } = {}) {
  const view = state.outlineView;
  if (!view?.dom.isConnected) return;
  updateModuleOutlineEditor(view, {
    doc: state.outlineText,
    selection: state.outlineSelection,
    activeModule: state.module,
    pendingModule: state.pendingModule,
    pendingVisible: state.pendingVisible,
    lineMap: state.outlineLineMap,
    collaboratorsByModule: state.collaboratorsByModule,
    moveSelection,
  });
}

function scheduleOutlineEditorSync() {
  if (state.outlineSyncQueued) return;
  state.outlineSyncQueued = true;
  queueMicrotask(() => {
    state.outlineSyncQueued = false;
    syncOutlineEditor();
  });
}

async function openOutlineModule(row, kind) {
  const modulePath =
    row?.targetModule ||
    row?.originTarget ||
    (row?.originPath && !row?.originModule ? row.proposedPath || row.path : null);
  if (!modulePath) return;
  const pageDraft = state.outlinePageDraft;
  const optimisticCreation = isOptimisticOutlineCreation(
    row,
    state.project?.pageIndex?.modules || [],
  );
  const previousModule = pageDraft?.previousModule || state.module;
  if (optimisticCreation) {
    state.outlinePageDraft = null;
    beginOptimisticPage(modulePath, { focus: "outline" });
  }
  else beginOptimisticRefactor(currentOutlineOperation(modulePath));
  if (state.outlineText !== state.outlineCommittedText) {
    const committed = await commitOutline({
      reason: "navigate",
      openModule: modulePath,
    });
    if (!committed) {
      if (optimisticCreation) {
        rollbackOptimisticPage(modulePath, previousModule);
      }
      return false;
    }
  }
  state.outlinePageDraft = null;
  if (!state.project?.pageIndex?.modules?.includes(modulePath)) {
    if (state.outlineConflict || state.outlineDraftError) return;
    await withProjectMutation(async () => {
      const order = state.outlineLineMap.flatMap((entry) => {
        if (entry === row) return [modulePath];
        const page = entry?.targetModule || entry?.pageModule;
        return page ? [page] : [];
      });
      const payload = await api("/api/pages", {
        method: "POST",
        body: JSON.stringify({
          modules: [modulePath],
          order,
          baseProjectVersion: state.projectVersion,
        }),
      });
      installAuthoritativeProject(payload.project, { forceOutline: true });
      confirmOptimisticPage(modulePath, payload.documents?.[0]);
    });
    render();
  }
  if (modulePath === state.module) {
    queueMicrotask(() => {
      if (optimisticCreation) state.sourceEditorView?.focus();
      else state.outlineView?.focus();
    });
    return true;
  }
  return loadDocument(modulePath, {
    history: outlineHistoryMode(kind),
    focus: "outline",
  });
}

function cancelOutlineDraft() {
  const pageDraft = state.outlinePageDraft;
  state.outlinePageDraft = null;
  state.outlineConflict = null;
  state.outlineDraftError = null;
  installProjectSnapshot(state.project, { forceOutline: true });
  const previous = pageDraft?.previousModule
    ? state.sessions.get(pageDraft.previousModule)
    : null;
  if (previous) {
    restoreSession(previous);
    updateRoute(pageDraft.previousModule, "replace");
  }
  render();
  queueMicrotask(() => state.outlineView?.focus());
}

function mountOutlineEditor() {
  const parent = document.querySelector("[data-module-outline]");
  if (!parent) return;
  refreshOutlineModel();
  if (state.outlineView && state.outlineView.dom.isConnected) {
    updateModuleOutlineEditor(state.outlineView, {
      doc: state.outlineText,
      selection: state.outlineSelection,
      activeModule: state.module,
      pendingModule: state.pendingModule,
      pendingVisible: state.pendingVisible,
      lineMap: state.outlineLineMap,
      collaboratorsByModule: state.collaboratorsByModule,
    });
    return;
  }
  state.outlineView = mountModuleOutlineEditor(parent, {
    doc: state.outlineText,
    selection: state.outlineSelection,
    activeModule: state.module,
    pendingModule: state.pendingModule,
    pendingVisible: state.pendingVisible,
    lineMap: state.outlineLineMap,
    collaboratorsByModule: state.collaboratorsByModule,
    onChange: (source, update, { moveOrigins = null } = {}) => {
      if (state.outlinePageDraft) {
        state.outlinePageDraft.selection = update.changes.mapPos(
          state.outlinePageDraft.selection,
          1,
        );
      }
      state.outlineText = source;
      state.outlineSelection = update.state.selection.main.head;
      state.workspaceError = state.outlineConflict || null;
      state.outlineDraftGeneration += 1;
      state.outlineFailedGeneration = null;
      const previousRows = moveOrigins
        ? carryOutlineRowsThroughMove(
            state.outlineDraftRows,
            moveOrigins,
          )
        : state.outlineDraftRows;
      const identityUpdate = moveOrigins ? null : update;
      const carriedRows = moveOrigins
        ? previousRows
        : carryOutlineRowsThroughUpdate(previousRows, identityUpdate);
      try {
        const draft = preserveBlankOutlineOrigins(
          source,
          parseOutlineDraft(source, {
            previousRows,
            update: identityUpdate,
          }),
          previousRows,
          identityUpdate,
        );
        state.outlineDraftRows = draft.rows;
        state.outlineLineMap = draft.lineMap;
        state.outlineDraftError = null;
      } catch (error) {
        state.outlineDraftError = error;
        state.outlineDraftRows = carriedRows;
        const line = Number(error.message.match(/^Line (\d+)/)?.[1] || 0);
        const invalidLines = new Set(
          error.outlineLines || (line ? [line] : []),
        );
        const carriedByLine = new Map(
          carriedRows.map((row) => [row.sourceLine, row]),
        );
        state.outlineLineMap = source.split("\n").map((text, index) => {
          const sourceLine = index + 1;
          return {
            ...(carriedByLine.get(sourceLine) || {}),
            text,
            sourceLine,
            invalid: invalidLines.size === 0 || invalidLines.has(sourceLine),
            error: error.message,
          };
        });
      }
      updateOutlinePageDraftPreview(update.view);
      scheduleOutlineEditorSync();
    },
    onSelectionChange: (selection) => {
      state.outlineSelection = selection.head;
    },
    onNavigate: (selection, update, kind) => {
      if (!selection.empty || update.view.composing) return;
      const line = update.state.doc.lineAt(selection.head);
      const row = outlineRowAtLine(line.number);
      void openOutlineModule(row, kind).catch((error) => {
        state.workspaceError = error.message;
        updateStatusOnly();
      });
    },
    onCommit: (reason, selection) => {
      if (selection !== undefined) state.outlineSelection = selection;
      if (reason === "new-draft") {
        beginOutlinePageDraft(state.outlineSelection);
        return;
      }
      const line =
        state.outlineView?.state.doc.lineAt(state.outlineSelection).number || 1;
      const row = outlineRowAtLine(line);
      const openModule =
        reason === "enter" || reason === "mod-enter"
          ? row?.targetModule || (row?.blank ? null : row?.originTarget) || null
          : null;
      if (openModule) {
        void openOutlineModule(row, "explicit").catch((error) => {
          state.workspaceError = error.message;
          updateStatusOnly();
        });
      } else {
        beginOptimisticRefactor(currentOutlineOperation());
        void commitOutline({ reason });
      }
    },
    onCancel: cancelOutlineDraft,
    onFocus: () => {
      if (!state.outlineFocusTransfer) state.outlineNavigationRun = false;
    },
    onBlur: () => {
      if (state.outlineFocusTransfer) return;
      state.outlineNavigationRun = false;
      const pageDraft = state.outlinePageDraft;
      const draftLine = pageDraft
        ? state.outlineView?.state.doc.lineAt(
            Math.min(
              pageDraft.selection,
              state.outlineView.state.doc.length,
            ),
          ).number
        : null;
      const draftRow = draftLine ? outlineRowAtLine(draftLine) : null;
      if (draftRow?.targetModule) {
        void openOutlineModule(draftRow, "explicit").catch((error) => {
          state.workspaceError = error.message;
          updateStatusOnly();
        });
        return;
      }
      if (
        state.outlineText !== state.outlineCommittedText &&
        !state.outlineDraftError
      ) {
        void commitOutline({ reason: "focusout" });
      }
    },
  });
}

function renderMain() {
  if (!state.document) {
    return `<div class="empty-state"><h2>This project has no pages yet.</h2><p>Press Enter in the module list, then type a module name.</p></div>`;
  }
  return renderDocument();
}

function viewsFor(id) {
  return state.evaluation?.views?.filter((view) => view.id === id) || [];
}

function renderView(view) {
  let body = "";
  if (view.kind === "html") {
    const source = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fffefa;color:#1d2824;font-family:system-ui,sans-serif}body{padding:15px}</style></head><body>${view.content}</body></html>`;
    body = `<iframe class="runtime-frame" sandbox="allow-scripts allow-forms" title="Sandboxed OCaml view ${escapeHtml(view.id)}" srcdoc="${escapeHtml(source)}"></iframe>`;
  } else if (view.kind === "link") {
    const [label, url] = view.content.split("\x1f");
    body = `<div class="runtime-content"><a class="runtime-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a></div>`;
  } else if (view.kind === "value") {
    const [type, value] = view.content.split("\x1f");
    body = `<div class="runtime-content value"><span class="runtime-type">${escapeHtml(type)}</span><span>${escapeHtml(value)}</span></div>`;
  } else if (view.kind === "trace") {
    body = `<div class="runtime-content runtime-trace"><span>event ${view.sequence}</span>${escapeHtml(view.content)}</div>`;
  } else {
    body = `<div class="runtime-content">${escapeHtml(view.content)}</div>`;
  }
  return `<section class="runtime-view" data-runtime="${escapeHtml(view.id)}" aria-label="${escapeHtml(view.kind)} output from ${escapeHtml(view.id)}">${body}</section>`;
}

function renderDocument() {
  return `
    <article class="document-shell ${state.sourceMode === "source" ? "source-mode" : ""}">
      <div class="literate-document-editor" data-document-editor aria-label="${state.sourceMode === "source" ? "Raw Markdown source editor" : "Editable Markdown and OCaml document"}"></div>
    </article>`;
}

function renderProject() {
  return `
    <section class="project-view">
      <div class="page-heading">
        <h1>Project structure</h1>
        <p>${state.project.documentCount} live document${state.project.documentCount === 1 ? "" : "s"} · semantic project version ${state.project.version.slice(0, 8)}</p>
      </div>
      <div class="project-grid">
        ${state.project.documents
          .map(
            (document) => `
              <article class="project-card" data-project-path="${escapeHtml(document.path)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(document.title)}">
                <h2>${escapeHtml(document.title)}</h2>
                <div class="project-card-path">${escapeHtml(document.path)}</div>
                ${(document.outline || [])
                  .map(
                    (entity) => `
                      <div class="entity-row">
                        <span>${escapeHtml(entity.name)}</span>
                        <span class="entity-kind">${escapeHtml(entity.kind)}</span>
                      </div>`,
                  )
                  .join("") || '<div class="entity-row"><span>No definitions</span></div>'}
              </article>`,
          )
          .join("")}
      </div>
      ${
        state.project.artifacts?.length
          ? `<div class="artifact-section"><h2>Generated artifacts</h2>${state.project.artifacts
              .map(
                (artifact) => `<article class="artifact-card"><strong>${escapeHtml(artifact.name)}</strong><span>${escapeHtml(artifact.entry)}</span><code>${escapeHtml(artifact.id.slice(0, 10))}</code><span>project ${escapeHtml(artifact.projectVersion.slice(0, 8))}</span></article>`,
              )
              .join("")}</div>`
          : ""
      }
    </section>`;
}

function renderCompletion() {
  const completion = state.completion;
  if (!completion) return "";
  const rows = completion.items.length
    ? completion.items
        .map(
          (item, index) => `
            <button
              class="completion-row${index === completion.selectedIndex ? " selected" : ""}"
              data-completion-index="${index}"
              type="button"
              role="option"
              aria-selected="${index === completion.selectedIndex}"
            >
              <span class="completion-name">${escapeHtml(item.name)}</span>
              <span class="completion-kind">${escapeHtml(item.kind.toLowerCase())}</span>
              ${item.type ? `<code class="completion-type">${escapeHtml(item.type)}</code>` : ""}
            </button>`,
        )
        .join("")
    : `<p class="completion-empty">${completion.loading ? "Loading compiler completions…" : "No matching identifiers."}</p>`;
  return `<div class="completion-list">${rows}</div>`;
}

function positionCompletionPopup() {
  const popup = document.querySelector("#completion-popup");
  const completion = state.completion;
  const editor = state.sourceEditorView;
  if (!popup || !completion || !editor) return;
  const coordinates = editor.coordsAtPos(
    Math.min(completion.to, editor.state.doc.length),
  );
  if (!coordinates) {
    popup.hidden = true;
    return;
  }
  popup.hidden = false;
  const margin = 8;
  const gap = 5;
  const width = Math.min(360, Math.max(260, window.innerWidth - margin * 2));
  const left = Math.min(
    Math.max(coordinates.left, margin),
    window.innerWidth - width - margin,
  );
  popup.style.width = `${width}px`;
  popup.style.left = `${left}px`;
  popup.style.top = `${coordinates.bottom + gap}px`;
  popup.style.bottom = "auto";
  popup.style.maxHeight = "none";
  const availableBelow = window.innerHeight - coordinates.bottom - margin;
  const availableAbove = coordinates.top - margin;
  const preferredHeight = Math.min(popup.scrollHeight, 390);
  if (availableBelow < Math.min(preferredHeight, 180) && availableAbove > availableBelow) {
    popup.style.top = "auto";
    popup.style.bottom = `${window.innerHeight - coordinates.top + gap}px`;
    popup.style.maxHeight = `${Math.max(120, availableAbove - gap)}px`;
  } else {
    popup.style.maxHeight = `${Math.max(120, availableBelow - gap)}px`;
  }
}

function scheduleCompletionPopupPosition() {
  if (!state.completion || state.completionPositionFrame !== null) return;
  state.completionPositionFrame = requestAnimationFrame(() => {
    state.completionPositionFrame = null;
    positionCompletionPopup();
  });
}

function renderCompletionPopup() {
  let popup = document.querySelector("#completion-popup");
  if (!state.completion || !state.sourceEditorView) {
    popup?.remove();
    state.sourceEditorView?.contentDOM.setAttribute("aria-expanded", "false");
    state.sourceEditorView?.contentDOM.removeAttribute("aria-controls");
    return;
  }
  if (!popup) {
    popup = document.createElement("div");
    popup.id = "completion-popup";
    popup.className = "completion-popup";
    popup.setAttribute("role", "listbox");
    popup.setAttribute("aria-label", "OCaml completions");
    document.body.append(popup);
  }
  popup.innerHTML = renderCompletion();
  popup.querySelectorAll("[data-completion-index]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () =>
      acceptCompletion(Number(button.dataset.completionIndex)),
    );
  });
  state.sourceEditorView.contentDOM.setAttribute("aria-expanded", "true");
  state.sourceEditorView.contentDOM.setAttribute(
    "aria-controls",
    "completion-popup",
  );
  positionCompletionPopup();
}

function renderDependencyContext() {
  const dependency = state.dependency;
  if (!dependency) return "";
  const section = (label, values) =>
    values?.length
      ? `<div class="module-relations"><span>${label}</span>${values
          .map(
            (modulePath) =>
              `<button type="button" data-module-link="${escapeHtml(modulePath)}">${escapeHtml(modulePath)}</button>`,
          )
          .join("")}</div>`
      : "";
  const boundary =
    !dependency.compilerBacked ||
    dependency.boundary === "unknown" ||
    dependency.diagnostics?.length
      ? "Compiler dependency data is unavailable"
      : dependency.boundary === "cross-namespace"
      ? "Used across namespaces"
      : dependency.boundary === "namespace-local"
        ? "Used within this namespace"
        : "No incoming module references";
  const backlinks = state.project?.pageIndex?.backlinks?.[dependency.module] || [];
  const compilerDiagnostics = dependency.diagnostics?.length
    ? `<div class="module-compiler-error">${dependency.diagnostics
        .map((message) => `<p>${escapeHtml(message)}</p>`)
        .join("")}</div>`
    : "";
  return `<section class="inspect-section module-context${dependency.stale ? " stale" : ""}">
    <h3>${escapeHtml(dependency.module)}</h3>
    ${section("Uses", dependency.uses)}
    ${section("Used by", dependency.usedBy)}
    ${section("Linked from", backlinks)}
    <p class="module-boundary">${escapeHtml(boundary)}</p>
    ${compilerDiagnostics}
  </section>`;
}

function renderDefinitionPeek() {
  const definition = state.definitionInfo;
  if (!definition) return "";
  const qualifiedName =
    definition.module && !definition.name.startsWith(`${definition.module}.`)
      ? `${definition.module}.${definition.name}`
      : definition.name;
  return `<section class="definition-peek">
    <button type="button" data-definition-peek aria-label="Open ${escapeHtml(qualifiedName)}">
      <span class="definition-peek-label">Definition</span>
      <strong>${escapeHtml(qualifiedName)}</strong>
      <span class="definition-peek-location">${escapeHtml(definition.path)} · line ${definition.line}</span>
      <pre><code>${escapeHtml(definition.source)}</code>${definition.truncated ? '<span class="definition-peek-more">…</span>' : ""}</pre>
      <span class="definition-peek-action">Open · F12</span>
    </button>
  </section>`;
}

function installInitialExecutionCore(evaluation) {
  const envelope = evaluation?.executionArtifact;
  if (!envelope || !state.path || !state.document) {
    state.executionProblem = "Execution artifact is missing.";
    return false;
  }
  const installed = installExecutionArtifact({
    envelope,
    sources: { [state.path]: state.document.source },
    cursor: state.cursorPosition
      ? { path: state.path, ...state.cursorPosition }
      : null,
  });
  if (!installed.state) {
    console.error(
      "Execution artifact could not be installed",
      installed.decision,
      installed.problems,
    );
    state.executionProblem = installed.problems
      .map((problem) => problem.detail || problem.code)
      .join("\n");
    return false;
  }
  setExecutionCore(installed.state);
  state.executionProblem = null;
  cacheExecutionArtifact(installed.artifact);
  return true;
}

function executionTokenKey(token) {
  return token
    ? [
        token.requestCodeDigest,
        token.documentRevisionId || token.sourceMaps?.documentRevisionId,
        token.projectDigest,
        token.compilerInputsDigest,
      ].join("\u001f")
    : null;
}

function cacheExecutionArtifact(envelope, token = envelope) {
  const key = executionTokenKey(token);
  if (!key) return;
  state.executionArtifactCache.delete(key);
  state.executionArtifactCache.set(key, envelope);
  while (state.executionArtifactCache.size > 8) {
    state.executionArtifactCache.delete(
      state.executionArtifactCache.keys().next().value,
    );
  }
}

function installExecutionTransition(transition) {
  state.executionCore = transition.state;
  if (transition.problems?.length) {
    state.executionProblem = transition.problems
      .map((problem) => problem.detail || problem.code)
      .join("\n");
  } else if (transition.decision?.startsWith("artifact-installed")) {
    state.executionProblem = null;
  }
  const effects = [...transition.effects];
  let evaluate = false;
  while (effects.length) {
    const effect = effects.shift();
    if (effect.kind === "lookup-artifact") {
      const artifact =
        state.executionArtifactCache.get(executionTokenKey(effect.token)) || null;
      const resolved = dispatchExecutionIntent(state.executionCore, {
        kind: "artifact-available",
        token: effect.token,
        artifact,
      });
      state.executionCore = resolved.state;
      effects.push(...resolved.effects);
    } else if (effect.kind === "cancel-evaluation") {
      const pendingToken = state.pendingEvaluation?.executionToken;
      if (executionTokenKey(pendingToken) === executionTokenKey(effect.token)) {
        state.evaluationController?.abort();
        state.evaluationController = null;
        state.pendingEvaluation = null;
        state.evaluating = false;
      }
    } else if (effect.kind === "evaluate") {
      evaluate = true;
    }
  }
  setExecutionCore(state.executionCore);
  return evaluate;
}

function executionRangeForEditor(range) {
  const editor = state.sourceEditorView;
  if (!editor || range?.path !== state.path) return null;
  const from = Math.min(Math.max(range.start, 0), editor.state.doc.length);
  const to = Math.min(Math.max(range.end, from), editor.state.doc.length);
  const start = editor.state.doc.lineAt(from);
  const end = editor.state.doc.lineAt(to);
  return {
    path: state.path,
    startLine: start.number,
    startColumn: from - start.from,
    endLine: end.number,
    endColumn: to - end.from,
    line: start.number,
    column: from - start.from,
  };
}

function executionCoreProjection() {
  if (!state.executionCore) return null;
  const model = presentExecution(state.executionCore);
  if (model.authority !== "exact") return null;
  const ranges = { active: [], inactive: [], "globally-unreached": [] };
  for (const coverage of model.coverage || []) {
    const range = executionRangeForEditor(coverage.range);
    if (range) ranges[coverage.state].push(range);
  }
  const annotationLines = (model.projection?.annotationPlan || []).flatMap(
    (slot) => {
      const annotation = slot.effective;
      if (!annotation) return [];
      const range = executionRangeForEditor(annotation.range);
      if (!range) return [];
      return [
        {
          line: slot.line,
          items: [
            {
              kind: annotation.kind,
              value: annotation.value.text,
              fullValue: annotation.value.fullText,
              type: annotation.value.type || "",
              truncated: annotation.value.truncated,
              segments: annotation.value.segments,
              occurrenceId: annotation.occurrenceId,
              selected: annotation.selected === true,
            },
          ],
        },
      ];
    },
  );
  const cursorRange = executionRangeForEditor(model.cursorInspection?.range);
  const links = (model.projection?.links || []).flatMap((link) => {
    const range = executionRangeForEditor(link.range);
    if (!range || range.startLine !== range.endLine) return [];
    return [
      {
        kind: link.kind,
        callId:
          link.kind === "parent" && link.occurrenceId
            ? `occurrence:${link.occurrenceId}`
            : link.activationId,
        label: link.label,
        line: range.startLine,
        column: range.startColumn,
        endColumn: range.endColumn,
      },
    ];
  });
  return {
    activeRanges: ranges.active,
    activationInactiveRanges: ranges.inactive,
    inactiveRanges: ranges["globally-unreached"],
    annotations: annotationLines,
    links,
    cursorFocus: cursorRange,
  };
}

function applyDebuggerProjection() {
  const editor = state.sourceEditorView;
  if (!editor) return;
  if (!state.executionCore) {
    editor.dom.classList.remove("cm-execution-lens");
    editor.dom.classList.remove("cm-execution-lens-stale");
    setMarkdownEditorDebugProjection(editor, null);
    return;
  }
  const model = presentExecution(state.executionCore);
  editor.dom.classList.add("cm-execution-lens");
  editor.dom.classList.toggle(
    "cm-execution-lens-stale",
    model.authority !== "exact",
  );
  editor.dom.classList.remove("cm-execution-lens-loading");
  setMarkdownEditorDebugProjection(editor, executionCoreProjection());
}

function installExecutionNavigation(result, { animate = true } = {}) {
  if (
    !result?.state ||
    (result.state === state.executionCore && !result.effects.length)
  ) {
    return false;
  }
  setExecutionCore(result.state);
  for (const effect of result.effects) {
    if (effect.kind !== "move-editor-cursor" || effect.range.path !== state.path) {
      continue;
    }
    const editor = state.sourceEditorView;
    if (!editor) continue;
    const anchor = Number.isInteger(effect.position?.line)
      ? Math.min(
          Math.max(
            editor.state.doc.line(effect.position.line).from +
              effect.position.column,
            effect.range.start,
          ),
          effect.range.end,
        )
      : effect.range.start;
    editor.dispatch({
      selection: { anchor },
      userEvent: "select.execution",
    });
    const line = editor.state.doc.lineAt(anchor);
    scrollMarkdownEditorTo(
      editor,
      { line: line.number, column: anchor - line.from },
      { animate },
    );
  }
  applyDebuggerProjection();
  refreshInspector({ revealExecutionChoice: true });
  return true;
}

function navigateDebugCall(callId) {
  if (state.executionCore && callId) {
    const target = executionTraceNavigationTarget(callId);
    return installExecutionNavigation(
      dispatchExecutionIntent(state.executionCore, {
        kind:
          target.kind === "occurrence"
            ? "occurrence-chosen"
            : "activation-navigated",
        ...(target.kind === "occurrence"
          ? { occurrenceId: target.id }
          : { activationId: target.id }),
      }),
    );
  }
  return false;
}

function executionValueHtml(value) {
  if (!value) return "…";
  const source = String(value.text ?? "…");
  const segments = Array.isArray(value.segments) ? value.segments : [];
  if (!segments.length) return escapeHtml(source);
  return segments
    .map((segment) => {
      const from = Math.min(Math.max(segment.from || 0, 0), source.length);
      const to = Math.min(Math.max(segment.to || from, from), source.length);
      const role = ["shape", "literal", "constructor", "variable"].includes(segment.role)
        ? segment.role
        : "neutral";
      return `<span class="execution-runtime-${role}">${escapeHtml(source.slice(from, to))}</span>`;
    })
    .join("");
}

function executionValueFullText(value) {
  return String(value?.fullText ?? value?.text ?? "…");
}

function executionValueCellAttributes(fullText, truncated = false) {
  return `data-execution-value-full="${escapeHtml(String(fullText))}" data-execution-value-truncated="${Boolean(truncated)}"`;
}

function renderWholeExecutionTrace(model) {
  const rows = model.wholeTrace
    .map((row) => {
      const depth = Math.max(0, row.depth || 0);
      if (row.kind === "activation") {
        const inputs = row.inputs
          .map(
            (input) =>
              `<code ${executionValueCellAttributes(executionValueFullText(input), input.truncated)}>${executionValueHtml(input)}</code>`,
          )
          .join('<span class="execution-trace-argument-gap"> </span>');
        const arrow = row.outcome.kind === "raise" ? "⇑" : "→";
        return `<button type="button" class="execution-trace-row execution-trace-call" style="--trace-indent:${depth * 2}ch" data-execution-trace-activation="${escapeHtml(row.activationId)}" aria-label="Open ${escapeHtml(row.name)} activation">
          <span class="execution-trace-name">${escapeHtml(row.name)}</span>${inputs ? `<span class="execution-trace-inputs">${inputs}</span>` : ""}<span class="execution-trace-arrow${row.outcome.kind === "raise" ? " raised" : ""}">${arrow}</span><code class="execution-trace-result" ${executionValueCellAttributes(executionValueFullText(row.outcome), row.outcome.truncated)}>${executionValueHtml(row.outcome)}</code>
        </button>`;
      }
      const output = row.output;
      const navigation = row.occurrenceId
        ? ` data-execution-trace-occurrence="${escapeHtml(row.occurrenceId)}"`
        : row.activationId
          ? ` data-execution-trace-activation="${escapeHtml(row.activationId)}"`
          : "";
      const tag = navigation ? "button" : "div";
      const label = output.label
        ? `<span class="execution-trace-output-label">${escapeHtml(output.label)}</span>`
        : "";
      const type = output.type
        ? `<span class="execution-trace-output-type">${escapeHtml(output.type)}</span>`
        : "";
      return `<${tag}${tag === "button" ? ' type="button"' : ""} class="execution-trace-row execution-trace-output execution-trace-output-${escapeHtml(output.kind)}" style="--trace-indent:${depth * 2}ch"${navigation}>
        <span class="execution-trace-output-marker" aria-hidden="true">${escapeHtml(output.marker)}</span>${label}<code>${escapeHtml(output.text)}</code>${type}
      </${tag}>`;
    })
    .join("");
  return `<section class="execution-panel execution-whole-trace${model.authority !== "exact" ? " stale" : ""}">
    ${rows ? `<div class="execution-trace-list" role="list" aria-label="Program execution trace">${rows}</div>` : '<p class="execution-note">This execution made no user function calls or output.</p>'}
  </section>`;
}

function renderExecutionCoreInspector() {
  const model = presentExecution(state.executionCore);
  const currentEvaluationFailed =
    state.evaluation?.ok === false && !state.evaluationInvalidation;
  if (!model.selection.constructId) return renderWholeExecutionTrace(model);
  const activationNames = [
    ...new Set(
      model.occurrenceList.rows.map((row) =>
        row.isProgram ? "top level" : row.name,
      ),
    ),
  ];
  const activationHeading =
    activationNames.length === 1 ? activationNames[0] : "activation";
  const resultHeading = ["activation", "fun"].includes(activationHeading)
    ? "result"
    : activationHeading;
  const parameterHeading = model.occurrenceList.parameterHeading;
  const programRows =
    model.occurrenceList.rows.length > 0 &&
    model.occurrenceList.rows.every((row) => row.isProgram);
  const showExpressionColumn = model.occurrenceList.rows.some(
    (row) => row.value || row.valueStatus,
  );
  const rows = model.occurrenceList.rows
    .map((row) => {
      const selectedActivation =
        row.activationId === model.occurrenceList.selectedActivationId;
      const selectedOccurrence =
        row.occurrenceId === model.occurrenceList.selectedOccurrenceId;
      const inputs = row.inputs
        .map((input) => executionValueHtml(input))
        .join('<span class="execution-choice-separator">, </span>');
      const inputsFullText = row.inputs
        .map((input) => executionValueFullText(input))
        .join(", ");
      const inputsTruncated = row.inputs.some((input) => input.truncated);
      const renderedInputs = `<span class="execution-choice-inputs"><code ${executionValueCellAttributes(inputsFullText, inputsTruncated)}>${inputs}</code></span>`;
      const repeat = row.totalInActivation > 1
        ? `<span class="execution-occurrence-index">${row.ordinal}/${row.totalInActivation}</span>`
        : "";
      const valueButton = row.value
        ? `<button type="button" class="execution-occurrence-value" data-execution-core-occurrence="${escapeHtml(row.occurrenceId)}" ${executionValueCellAttributes(executionValueFullText(row.value), row.value.truncated)} ${selectedOccurrence ? 'aria-current="true"' : ""} aria-label="Value of ${escapeHtml(model.occurrenceList.expression)}: ${escapeHtml(row.value.fullText || row.value.text)}">
          <code>${executionValueHtml(row.value)}</code>
        </button>`
        : row.valueStatus === "trace-incomplete"
          ? '<span class="execution-occurrence-status">trace ended before the value returned</span>'
        : "";
      const activationContents = row.isProgram
        ? '<span class="execution-choice-program" aria-hidden="true"></span>'
        : `${renderedInputs}
          <span class="execution-choice-arrow ${row.outcome.kind === "raise" ? "raised" : ""}">${row.outcome.kind === "raise" ? "⇑" : "→"}</span>
          <span class="execution-choice-result"><code class="execution-occurrence-outcome" ${executionValueCellAttributes(executionValueFullText(row.outcome), row.outcome.truncated)}>${executionValueHtml(row.outcome)}</code>${repeat}</span>`;
      return `<div class="execution-occurrence${row.isProgram ? " program" : ""}${row.value ? "" : " no-value"}${selectedActivation || selectedOccurrence ? " selected" : ""}" role="listitem">
        <button type="button" class="execution-occurrence-activation" data-execution-core-activation="${escapeHtml(row.activationId)}" ${selectedActivation ? 'aria-current="true"' : ""} aria-label="${row.isProgram ? "Top-level activation" : `Select ${escapeHtml(row.name)} activation`}">
          ${activationContents}
        </button>
        ${valueButton}
      </div>`;
    })
    .join("");
  const stale = model.authority !== "exact";
  return `<section class="execution-panel${showExpressionColumn ? "" : " activation-only"}${stale ? " stale" : ""}">
    ${
      rows
        ? `<header class="execution-occurrence-heading${programRows ? " program" : ""}${showExpressionColumn ? "" : " activation-only"}">
            ${programRows
              ? '<code class="execution-activation-heading" title="Top-level activation">top level</code>'
              : `<code class="execution-arguments-heading" title="${escapeHtml(`Function parameters: ${parameterHeading.fullText}`)}">${escapeHtml(parameterHeading.text)}</code><span class="execution-heading-arrow" aria-hidden="true">→</span><code class="execution-result-heading" title="Function result">${escapeHtml(resultHeading)}</code>`}
            ${showExpressionColumn ? `<span class="execution-expression-heading" title="Selected expression"><code>${escapeHtml(model.occurrenceList.expression)}</code></span>` : ""}
          </header><div class="execution-occurrences${showExpressionColumn ? "" : " activation-only"}" role="list" aria-label="Executions of the selected expression">${rows}</div>`
        : `<p class="execution-note">${
            stale
              ? currentEvaluationFailed
                ? "This selection is not available in the last successful execution."
                : "Execution is updating for the edited program."
              : model.occurrenceList.emptyReason === "trace-incomplete"
                ? "The trace ended before this expression was recorded."
                : model.occurrenceList.emptyReason === "defined-not-called"
                  ? "This function was defined but not called."
                  : model.selection.constructId
                    ? "This expression was not reached."
                    : "Place the cursor in OCaml code to inspect its executions."
          }</p>`
    }
  </section>`;
}

function renderInspector() {
  if (!state.document || state.view !== "document") return "";
  const currentEvaluation = state.evaluationInvalidation
    ? null
    : state.evaluation;
  const evaluationFailed = currentEvaluation?.ok === false;
  const diagnostics = inspectorDiagnostics(currentEvaluation, {
    path: state.path,
    cursorLine: state.cursorPosition?.line || null,
  });
  const diagnosticsHtml = diagnostics.length
      ? `<section class="inspect-section diagnostic-section"><h3>${evaluationFailed ? "Code error" : "Diagnostics"}</h3>${diagnostics.map((diagnostic) => `<button class="diagnostic" data-diagnostic-line="${diagnostic.line || ""}">${escapeHtml(formatDiagnosticMessage(diagnostic.message))}</button>`).join("")}</section>`
      : "";
  if (state.executionCore) {
    const execution = renderExecutionCoreInspector();
    if (!evaluationFailed) return execution;
    return `${diagnosticsHtml}<div class="last-successful-execution"><p class="last-successful-execution-label">${staleExecutionLabel(currentEvaluation)}</p>${execution}</div>`;
  }
  if (state.executionProblem && state.evaluation?.ok) {
    return `<p class="context-empty" title="${escapeHtml(state.executionProblem)}">Execution data is unavailable.</p>`;
  }
  if (state.evaluating) {
    return `<section class="execution-panel execution-loading" aria-live="polite">
      <span class="execution-pulse"></span>
      <span>Preparing execution…</span>
    </section>`;
  }
  if (state.evaluation?.ok) {
    return '<p class="context-empty">Execution data is unavailable.</p>';
  }
  const typeInfo = state.typeInfo;
  return `
    ${
      typeInfo
        ? `<section class="cursor-type">
            <h2 class="inspector-title"><code>${escapeHtml(typeInfo.expression)}</code></h2>
            <div class="type-card" data-source-line="${typeInfo.startLine}" data-source-column="${typeInfo.startColumn}">${escapeHtml(typeInfo.type)}</div>
          </section>`
        : ""
    }
    ${renderDefinitionPeek()}
    ${diagnosticsHtml}
    ${renderDependencyContext()}
    ${
      !typeInfo &&
      !state.definitionInfo &&
      !diagnostics.length
        ? '<p class="context-empty">Place the cursor on OCaml code to inspect its type.</p>'
        : ""
    }`;
}

function render() {
  invalidateTypeLookup();
  invalidateCompletion();
  renderShell();
}

function parseDraftBlocks(source) {
  if (!source) return [];
  const lines = source.split("\n");
  if (source.endsWith("\n")) lines.pop();
  const blocks = [];
  let index = 0;
  const isExecutableFence = (line) =>
    /^```(?:ocaml|ocaml-example)(?:\s|$)/.test(line.trim());
  const indentedCodeLines = new Set();
  let inFence = false;
  let listContext = false;
  let codeContext = false;
  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (inFence) {
      if (trimmed === "```") inFence = false;
      return;
    }
    if (isExecutableFence(line)) {
      inFence = true;
      listContext = false;
      codeContext = false;
      return;
    }
    if (line.startsWith("    ")) {
      if (!listContext) {
        indentedCodeLines.add(lineIndex);
        codeContext = true;
      }
      return;
    }
    if (trimmed === "") {
      if (codeContext && !listContext) indentedCodeLines.add(lineIndex);
      listContext = false;
      return;
    }
    codeContext = false;
    listContext = /^ {0,3}(?:[-+*]|\d+[.)])\s+/.test(line);
  });

  while (index < lines.length) {
    const line = lines[index];
    if (isExecutableFence(line)) {
      const start = index;
      const info = line.trim().slice(3).trim();
      const kind = info.split(/\s+/)[0];
      const name = info.match(/(?:^|\s)name=([^\s]+)/)?.[1] || null;
      index += 1;
      const sourceLines = [];
      while (index < lines.length && lines[index].trim() !== "```") {
        sourceLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        id: name ? `code-${name}` : `code-${start + 1}`,
        kind,
        name,
        source: sourceLines.join("\n"),
        lineStart: start + 1,
        lineEnd: index,
        sourceLine: start + 2,
      });
      continue;
    }

    if (indentedCodeLines.has(index) && line.startsWith("    ")) {
      const start = index;
      const sourceLines = [];
      while (
        index < lines.length &&
        indentedCodeLines.has(index)
      ) {
        sourceLines.push(
          lines[index].startsWith("    ") ? lines[index].slice(4) : lines[index],
        );
        index += 1;
      }
      blocks.push({
        id: `code-${start + 1}`,
        kind: "ocaml",
        name: null,
        source: sourceLines.join("\n"),
        lineStart: start + 1,
        lineEnd: index,
        sourceLine: start + 1,
      });
      continue;
    }

    const start = index;
    const sourceLines = [];
    while (
      index < lines.length &&
      !isExecutableFence(lines[index]) &&
      !(
        indentedCodeLines.has(index) &&
        lines[index].startsWith("    ")
      )
    ) {
      sourceLines.push(lines[index]);
      index += 1;
    }
    blocks.push({
      id: `prose-${start + 1}`,
      kind: "prose",
      source: sourceLines.join("\n"),
      lineStart: start + 1,
      lineEnd: index,
    });
  }
  return blocks;
}

function draftFenceMarker(line) {
  const leading = line.match(/^ {0,3}/)?.[0].length || 0;
  const marker = line[leading];
  if (marker !== "`" && marker !== "~") return null;
  let after = leading;
  while (line[after] === marker) after += 1;
  const length = after - leading;
  return length >= 3 ? { marker, length, after } : null;
}

function draftFenceCloses(line, fence) {
  const marker = draftFenceMarker(line);
  return (
    marker?.marker === fence.marker &&
    marker.length >= fence.length &&
    line.slice(marker.after).trim() === ""
  );
}

function draftBacktickIsEscaped(line, index) {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && line[cursor] === "\\";
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function draftSingleBacktickSpans(line) {
  const delimiters = [];
  for (let index = 0; index < line.length; ) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let after = index + 1;
    while (line[after] === "`") after += 1;
    if (
      after - index === 1 &&
      !draftBacktickIsEscaped(line, index)
    ) {
      delimiters.push(index);
    }
    index = after;
  }
  const spans = [];
  for (let index = 0; index + 1 < delimiters.length; index += 2) {
    spans.push({
      opening: delimiters[index],
      closing: delimiters[index + 1],
    });
  }
  return spans;
}

function buildExecutionPlan(source, blocks) {
  const programBlocks = blocks
    .filter((block) => block.kind === "ocaml")
    .map((block) => ({
      id: block.id,
      signature: JSON.stringify([block.name || "", block.source]),
      lineStart: block.lineStart,
      lineEnd: block.lineEnd,
      sourceLine: block.sourceLine,
    }));
  const codeLines = new Set();
  for (const block of blocks) {
    if (block.kind === "prose") continue;
    for (let line = block.lineStart; line <= block.lineEnd; line += 1) {
      codeLines.add(line);
    }
  }

  const inline = [];
  let fence = null;
  source.split("\n").forEach((line, offset) => {
    const lineNumber = offset + 1;
    if (fence) {
      if (draftFenceCloses(line, fence)) fence = null;
      return;
    }
    const openingFence = draftFenceMarker(line);
    if (openingFence) {
      fence = openingFence;
      return;
    }
    if (codeLines.has(lineNumber)) return;
    for (const span of draftSingleBacktickSpans(line)) {
      const content = line.slice(span.opening + 1, span.closing).trim();
      if (content.length <= 1 || !content.endsWith("=")) continue;
      const expression = content.slice(0, -1).trim();
      if (!expression) continue;
      inline.push({
        signature: expression,
        expression,
        line: lineNumber,
        columnStart: span.opening + 1,
        columnEnd: span.closing,
        resultColumn: span.closing + 1,
      });
    }
  });
  return { blocks: programBlocks, inline };
}

function firstExecutionDifference(previous, next) {
  const shared = Math.min(previous.length, next.length);
  for (let index = 0; index < shared; index += 1) {
    if (previous[index].signature !== next[index].signature) return index;
  }
  return previous.length === next.length ? null : shared;
}

function executionInvalidation(previous, next) {
  const blockFrom = firstExecutionDifference(previous.blocks, next.blocks);
  if (blockFrom !== null) return { blockFrom, inlineFrom: 0 };
  const inlineFrom = firstExecutionDifference(previous.inline, next.inline);
  return inlineFrom === null ? null : { blockFrom: null, inlineFrom };
}

function preserveUnchangedBlockIdentity(draftBlocks, previousBlocks) {
  const used = new Set();
  const preservedIds = new Set();
  const blocks = draftBlocks.map((block) => {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    previousBlocks.forEach((previous, index) => {
      if (
        used.has(index) ||
        previous.kind !== block.kind ||
        previous.source.trimEnd() !== block.source.trimEnd()
      ) {
        return;
      }
      const distance = Math.abs(previous.lineStart - block.lineStart);
      if (distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    });
    if (bestIndex < 0) return block;
    used.add(bestIndex);
    const previous = previousBlocks[bestIndex];
    preservedIds.add(previous.id);
    return { ...block, id: previous.id };
  });
  return { blocks, preservedIds };
}

function contiguousTextChange(previousSource, source) {
  let from = 0;
  const shared = Math.min(previousSource.length, source.length);
  while (from < shared && previousSource[from] === source[from]) from += 1;
  let previousEnd = previousSource.length;
  let sourceEnd = source.length;
  while (
    previousEnd > from &&
    sourceEnd > from &&
    previousSource[previousEnd - 1] === source[sourceEnd - 1]
  ) {
    previousEnd -= 1;
    sourceEnd -= 1;
  }
  return { from, to: previousEnd, insert: source.slice(from, sourceEnd) };
}

function textChanges(previousSource, source, changes) {
  if (!changes?.iterChanges) {
    return [contiguousTextChange(previousSource, source)];
  }
  const result = [];
  changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
    result.push({ from, to, insert: inserted.toString() });
  });
  return result.length ? result : [contiguousTextChange(previousSource, source)];
}

function cancelPendingEvaluation() {
  if (state.evalFrame !== null) cancelAnimationFrame(state.evalFrame);
  state.evalFrame = null;
  state.pendingEvaluation = null;
  state.evalGeneration += 1;
  state.evaluationController?.abort();
  state.evaluationController = null;
  state.evaluating = false;
}

function updateSource(
  source,
  { evaluate = true, changes = null, previousSource = null } = {},
) {
  invalidateTypeLookup();
  const executionPreviousSource = previousSource ?? state.document.source;
  let executionNeedsEvaluation = false;
  if (state.executionCore && executionPreviousSource !== source) {
    const executionTransition = dispatchExecutionIntent(state.executionCore, {
      kind: "document-edited",
      path: state.path,
      source,
      changes: textChanges(executionPreviousSource, source, changes),
    });
    executionNeedsEvaluation = installExecutionTransition(executionTransition);
  }
  const draft = preserveUnchangedBlockIdentity(
    parseDraftBlocks(source),
    state.document.blocks,
  );
  const nextPlan = buildExecutionPlan(source, draft.blocks);
  const previousPlan = state.evaluationPlan;
  const invalidation =
    state.evaluation && previousPlan
      ? executionInvalidation(previousPlan, nextPlan)
      : { blockFrom: 0, inlineFrom: 0 };
  const effectiveInvalidation =
    invalidation ||
    (state.evaluation && !state.evaluation.ok
      ? { blockFrom: 0, inlineFrom: 0 }
      : null);
  state.document = {
    ...state.document,
    source,
    blocks: draft.blocks,
    definitions: state.document.definitions.filter((definition) =>
      draft.preservedIds.has(definition.blockId),
    ),
    issues: [],
  };
  state.dirty = source !== state.savedSource;
  invalidateDependencyContext({ stale: state.dirty });
  if (!state.dirty && !state.dependency && state.module) {
    void loadDependencyContext(state.module);
  }
  const session = currentSession();
  if (session) {
    session.document = state.document;
    session.editRevision += 1;
    session.conflict = null;
    if (!session.collaboration) {
      storeRecoveryDraft(session, source);
      scheduleAutosave(session);
    }
  }
  state.evaluationInvalidation = effectiveInvalidation;
  if (effectiveInvalidation) {
    applyDebuggerProjection();
  } else {
    cancelPendingEvaluation();
    state.evaluationPlan = nextPlan;
  }
  if (state.sourceEditorView && state.evaluation) {
    setMarkdownEditorResultInvalidation(
      state.sourceEditorView,
      effectiveInvalidation,
    );
  }
  updateStatusOnly();
  refreshInspector();
  if (
    evaluate &&
    (Boolean(effectiveInvalidation) ||
      (state.executionCore &&
        executionNeedsEvaluation &&
        Boolean(executionPendingToken(state.executionCore))))
  ) {
    scheduleEvaluation(source, { plan: nextPlan });
  }
}

function typeRequestIsCurrent(request, { includeProject = true } = {}) {
  const cursor = state.cursorPosition;
  return (
    request.generation === state.typeGeneration &&
    state.view === "document" &&
    request.path === state.path &&
    request.source === state.document?.source &&
    (!includeProject || request.projectVersion === state.projectVersion) &&
    cursor?.line === request.line &&
    cursor?.column === request.column
  );
}

async function startTypeLookup() {
  if (state.typeController || !state.typePending) return;
  const request = state.typePending;
  state.typePending = null;
  const controller = new AbortController();
  state.typeController = controller;
  let retryRequest = null;
  try {
    const payload = await api("/api/type-at", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        path: request.path,
        source: request.source,
        line: request.line,
        column: request.column,
        baseProjectVersion: request.projectVersion,
      }),
    });
    if (
      payload.projectVersion &&
      payload.projectVersion !== state.projectVersion
    ) {
      const error = new Error("The project changed during type lookup.");
      error.status = 409;
      throw error;
    }
    if (!typeRequestIsCurrent(request)) return;
    state.typeInfo = payload.info;
    refreshInspector();
  } catch (error) {
    if (
      error.name !== "AbortError" &&
      error.status === 409 &&
      request.retryCount < 1 &&
      typeRequestIsCurrent(request, { includeProject: false })
    ) {
      try {
        await refreshProjectIndex();
        if (typeRequestIsCurrent(request, { includeProject: false })) {
          retryRequest = {
            ...request,
            projectVersion: state.projectVersion,
            retryCount: request.retryCount + 1,
          };
        }
      } catch {
        // Fall through to the normal empty type state.
      }
    }
    if (
      error.name !== "AbortError" &&
      !retryRequest &&
      request.generation === state.typeGeneration
    ) {
      state.typeInfo = null;
      refreshInspector();
    }
  } finally {
    if (state.typeController === controller) state.typeController = null;
    if (retryRequest && !state.typePending) state.typePending = retryRequest;
    if (state.typePending) startTypeLookup();
  }
}

function scheduleTypeLookup(editor, position) {
  clearTimeout(state.typeTimer);
  state.typePending = null;
  const generation = ++state.typeGeneration;
  const line = editor.state.doc.lineAt(position);
  const cursor = { line: line.number, column: position - line.from };
  const block = state.document.blocks.find(
    (item) =>
      item.kind === "ocaml" &&
      cursor.line >= item.lineStart &&
      cursor.line <= item.lineEnd,
  );
  state.cursorPosition = block ? cursor : null;
  state.typeInfo = null;
  if (!block) {
    state.typePending = null;
    refreshInspector();
    return;
  }
  if (state.executionCore) {
    state.typePending = null;
    refreshInspector();
    return;
  }
  refreshInspector();
  const request = {
    generation,
    path: state.path,
    source: state.document.source,
    projectVersion: state.projectVersion,
    retryCount: 0,
    ...cursor,
  };
  state.typeTimer = setTimeout(() => {
    if (request.generation !== state.typeGeneration) return;
    state.typePending = request;
    startTypeLookup();
  }, 100);
}

function definitionRequestAt(editor, position) {
  if (!editor || !state.document) return null;
  const line = editor.state.doc.lineAt(position);
  const block = state.document.blocks.find(
    (item) =>
      item.kind === "ocaml" &&
      line.number >= item.lineStart &&
      line.number <= item.lineEnd,
  );
  if (!block) return null;
  const column = position - line.from;
  const identifier = /[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*/g;
  let match;
  while ((match = identifier.exec(line.text))) {
    if (column >= match.index && column <= match.index + match[0].length) {
      return {
        path: state.path,
        source: state.document.source,
        line: line.number,
        column,
        projectVersion: state.projectVersion,
        token: match[0],
      };
    }
  }
  return null;
}

async function openDefinition(definition) {
  if (!definition) return false;
  if (
    definition.module !== state.module &&
    !(await loadDocument(definition.module, {
      history: "push",
      focus: "main",
    }))
  ) {
    return false;
  }
  state.definitionInfo = definition;
  refreshInspector();
  const editor = state.sourceEditorView;
  if (!editor) return false;
  const line = editor.state.doc.line(
    Math.min(Math.max(definition.line, 1), editor.state.doc.lines),
  );
  const anchor =
    line.from + Math.min(Math.max(definition.column, 0), line.length);
  state.suppressNextCompletionLookup = true;
  editor.dispatch({
    selection: {
      anchor,
      head: Math.min(line.to, anchor + definition.name.length),
    },
    scrollIntoView: true,
  });
  editor.focus();
  return true;
}

async function performDefinitionLookup(request, mode, generation) {
  const controller = new AbortController();
  state.definitionController?.abort();
  state.definitionController = controller;
  try {
    const payload = await api("/api/definition-at", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        path: request.path,
        source: request.source,
        line: request.line,
        column: request.column,
        baseProjectVersion: request.projectVersion,
      }),
    });
    if (
      generation !== state.definitionGeneration ||
      request.path !== state.path ||
      request.source !== state.document?.source
    ) {
      return false;
    }
    state.definitionInfo = payload.definition;
    refreshInspector();
    if (mode === "navigate" && payload.definition) {
      return openDefinition(payload.definition);
    }
    return Boolean(payload.definition);
  } catch (error) {
    if (
      error.name !== "AbortError" &&
      generation === state.definitionGeneration
    ) {
      state.definitionInfo = null;
      refreshInspector();
    }
    return false;
  } finally {
    if (state.definitionController === controller) {
      state.definitionController = null;
    }
  }
}

function requestDefinition(editor, position, mode = "peek") {
  clearTimeout(state.definitionTimer);
  const request = definitionRequestAt(editor, position);
  const generation = ++state.definitionGeneration;
  state.definitionController?.abort();
  state.definitionController = null;
  if (!request) {
    state.definitionInfo = null;
    refreshInspector();
    return false;
  }
  void performDefinitionLookup(request, mode, generation);
  return true;
}

function scheduleDefinitionLookup(editor, position) {
  clearTimeout(state.definitionTimer);
  const request = definitionRequestAt(editor, position);
  const generation = ++state.definitionGeneration;
  state.definitionController?.abort();
  state.definitionController = null;
  state.definitionInfo = null;
  if (!request) return;
  state.definitionTimer = setTimeout(() => {
    if (generation !== state.definitionGeneration) return;
    void performDefinitionLookup(request, "peek", generation);
  }, 120);
}

function completionContextAt(editor, position, { allowEmpty = false } = {}) {
  if (!editor || !state.document) return null;
  const line = editor.state.doc.lineAt(position);
  const block = state.document.blocks.find(
    (item) =>
      item.kind === "ocaml" &&
      line.number >= item.lineStart &&
      line.number <= item.lineEnd,
  );
  if (!block) return null;

  const column = position - line.from;
  const beforeCursor = line.text.slice(0, column);
  const token = beforeCursor.match(
    /([A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*\.?)$/,
  )?.[1] || "";
  if (!token && !allowEmpty) return null;

  const lastDot = token.lastIndexOf(".");
  const context = lastDot < 0 ? "" : token.slice(0, lastDot + 1);
  const query = token.slice(lastDot + 1);
  if (!query && !context && !allowEmpty) return null;

  const from = position - query.length;
  const suffix = token
    ? line.text.slice(column).match(/^[A-Za-z0-9_']*/)?.[0] || ""
    : "";
  const to = position + suffix.length;
  const source = state.document.source;
  const normalizedSource = source.slice(0, from) + source.slice(to);
  const key = JSON.stringify([
    state.path,
    state.projectVersion,
    line.number,
    from - line.from,
    context,
    normalizedSource,
  ]);
  return {
    key,
    path: state.path,
    source,
    line: line.number,
    column,
    from,
    to,
    context,
    query,
    projectVersion: state.projectVersion,
  };
}

function fallbackCompletionItems() {
  const items = [
    ...(state.evaluation?.bindings || []).map((binding) => ({
      name: binding.name,
      kind: "Value",
      type: binding.type || "",
      deprecated: false,
      priority: 0,
    })),
    ...(state.document?.definitions || []).map((definition) => ({
      name: definition.name,
      kind:
        definition.kind === "let"
          ? "Value"
          : definition.kind[0]?.toUpperCase() + definition.kind.slice(1),
      type: "",
      deprecated: false,
      priority: 0,
    })),
  ];
  const unique = new Map();
  for (const item of items) {
    if (item.name && !unique.has(item.name)) unique.set(item.name, item);
  }
  return [...unique.values()];
}

function fuzzyCompletionRank(name, query) {
  if (!query) return 0;
  if (name.startsWith(query)) return 0;
  const lowerName = name.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerName.startsWith(lowerQuery)) return 1;
  const contained = lowerName.indexOf(lowerQuery);
  if (contained >= 0) return 2 + contained / 100;
  let cursor = 0;
  for (const character of lowerName) {
    if (character === lowerQuery[cursor]) cursor += 1;
    if (cursor === lowerQuery.length) return 3;
  }
  return Number.POSITIVE_INFINITY;
}

function filteredCompletionItems(items, query) {
  const unique = new Map();
  for (const [order, item] of items.entries()) {
    if (!item?.name) continue;
    const candidate = {
      ...item,
      priority: item.priority ?? 1,
      order: item.order ?? order,
    };
    const existing = unique.get(item.name);
    if (!existing) {
      unique.set(item.name, candidate);
    } else if (!existing.type && candidate.type) {
      unique.set(item.name, {
        ...candidate,
        priority: Math.min(existing.priority, candidate.priority),
        order: Math.min(existing.order, candidate.order),
      });
    }
  }
  return [...unique.values()]
    .map((item) => ({ item, rank: fuzzyCompletionRank(item.name, query) }))
    .filter(({ item, rank }) => !item.deprecated && Number.isFinite(rank))
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.item.priority - right.item.priority ||
        left.item.order - right.item.order ||
        left.item.name.length - right.item.name.length ||
        left.item.name.localeCompare(right.item.name),
    )
    .slice(0, 14)
    .map(({ item }) => item);
}

function cacheCompletionItems(key, items) {
  state.completionCache.delete(key);
  state.completionCache.set(key, items);
  while (state.completionCache.size > 20) {
    state.completionCache.delete(state.completionCache.keys().next().value);
  }
}

function showCompletion(context, compilerItems, loading) {
  const items = filteredCompletionItems(
    [
      ...(context.context ? [] : fallbackCompletionItems()),
      ...(compilerItems || []),
    ],
    context.query,
  );
  state.completion = {
    ...context,
    items,
    loading,
    selectedIndex: 0,
  };
  refreshInspector();
}

function sameCompletionTarget(left, right) {
  return Boolean(
    left &&
      right &&
      left.path === right.path &&
      left.source === right.source &&
      left.line === right.line &&
      left.column === right.column &&
      left.from === right.from &&
      left.to === right.to &&
      left.context === right.context &&
      left.query === right.query,
  );
}

async function requestCompletionItems(editor, request) {
  state.completionController?.abort();
  const controller = new AbortController();
  const generation = ++state.completionGeneration;
  state.completionController = controller;
  state.completionRequestKey = request.key;
  let retryRequest = null;
  try {
    const payload = await api("/api/complete", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        path: request.path,
        source: request.source,
        line: request.line,
        column: request.column,
        context: request.context,
        baseProjectVersion: request.projectVersion,
      }),
    });
    if (
      payload.projectVersion &&
      payload.projectVersion !== state.projectVersion
    ) {
      const error = new Error("The project changed during completion.");
      error.status = 409;
      throw error;
    }
    if (
      generation !== state.completionGeneration ||
      state.completionRequestKey !== request.key
    ) {
      return;
    }
    cacheCompletionItems(request.key, payload.items || []);
    const current = completionContextAt(
      editor,
      editor.state.selection.main.head,
      { allowEmpty: true },
    );
    if (
      current?.key === request.key &&
      (current.query || current.context)
    ) {
      showCompletion(current, payload.items || [], false);
    }
  } catch (error) {
    if (
      error.name !== "AbortError" &&
      error.status === 409 &&
      (request.retryCount || 0) < 1 &&
      generation === state.completionGeneration
    ) {
      try {
        await refreshProjectIndex();
        const current = completionContextAt(
          editor,
          editor.state.selection.main.head,
          { allowEmpty: true },
        );
        if (
          generation === state.completionGeneration &&
          sameCompletionTarget(request, current)
        ) {
          retryRequest = {
            ...current,
            retryCount: (request.retryCount || 0) + 1,
          };
        }
      } catch {
        // Fall through to the normal empty completion state.
      }
    }
    if (
      error.name !== "AbortError" &&
      !retryRequest &&
      generation === state.completionGeneration
    ) {
      cacheCompletionItems(request.key, []);
      const current = completionContextAt(
        editor,
        editor.state.selection.main.head,
        { allowEmpty: true },
      );
      if (
        current?.key === request.key &&
        (current.query || current.context)
      ) {
        showCompletion(current, [], false);
      }
    }
  } finally {
    if (state.completionController === controller) {
      state.completionController = null;
      state.completionRequestKey = null;
    }
    if (retryRequest) void requestCompletionItems(editor, retryRequest);
  }
}

function scheduleCompletion(editor, position) {
  const context = completionContextAt(editor, position, { allowEmpty: true });
  if (!context) {
    invalidateCompletion();
    refreshInspector();
    return;
  }

  const cached = state.completionCache.get(context.key);
  const visible = Boolean(context.query || context.context);
  if (visible) {
    showCompletion(context, cached || [], cached === undefined);
  } else if (state.completion) {
    state.completion = null;
    refreshInspector();
  }
  if (cached !== undefined || state.completionRequestKey === context.key) {
    return;
  }
  void requestCompletionItems(editor, context);
}

function dismissCompletion() {
  if (!state.completion) return false;
  invalidateCompletion();
  refreshInspector();
  return true;
}

function acceptCompletion(index = state.completion?.selectedIndex ?? 0) {
  const completion = state.completion;
  const editor = state.sourceEditorView;
  const item = completion?.items[index];
  if (!completion || !editor || !item) return false;
  if (
    completion.from < 0 ||
    completion.to > editor.state.doc.length ||
    completion.from > completion.to
  ) {
    return false;
  }
  invalidateCompletion();
  state.suppressNextCompletionLookup = true;
  editor.dispatch({
    changes: {
      from: completion.from,
      to: completion.to,
      insert: item.name,
    },
    selection: { anchor: completion.from + item.name.length },
    scrollIntoView: true,
    userEvent: "input.complete",
  });
  editor.focus();
  refreshInspector();
  return true;
}

function handleCompletionKey(action) {
  if (!state.completion) return false;
  if (action === "dismiss") return dismissCompletion();
  if (action === "accept") return acceptCompletion();
  return false;
}

async function performEvaluation(request, signal) {
  const body = {
    path: request.path,
    source: request.source,
    baseProjectVersion: request.baseProjectVersion,
    requestCodeDigest: request.executionToken?.requestCodeDigest,
  };
  if (state.evaluationEngine !== "browser") {
    return api("/api/evaluate", {
      method: "POST",
      signal,
      body: JSON.stringify(body),
    });
  }
  const planPayload = await api("/api/browser-evaluation-plan", {
    method: "POST",
    signal,
    body: JSON.stringify(body),
  });
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const backend = await import("./oxcaml/backend.js?v=20260803q");
  const removeStatusListener = backend.addBackendStatusListener(({ state: backendState, text }) => {
    const toggle = document.querySelector("#evaluation-engine-toggle");
    if (!toggle) return;
    toggle.dataset.backendState = backendState;
    if (text) toggle.dataset.backendStatus = text;
    else delete toggle.dataset.backendStatus;
  });
  let result;
  try {
    result = await backend.runDoxProject(planPayload.plan, { signal });
  } finally {
    removeStatusListener();
  }
  globalThis.__doxDiagnostics = {
    ...(globalThis.__doxDiagnostics || {}),
    browserEvaluation: {
      path: request.path,
      measuredAt: Date.now(),
      timings: result?.timings || null,
      cache: result?.cache || null,
      traceBytes: typeof result?.trace === "string" ? result.trace.length : 0,
      resultKind: result?.kind || null,
      error: result?.kind === "ok"
        ? null
        : String(result?.message || result?.stderr || result?.stdout || "").slice(0, 800),
      stderr: result?.kind === "ok" ? null : String(result?.stderr || "").slice(0, 1200),
    },
  };
  document.documentElement.dataset.doxBrowserEvaluation = JSON.stringify(
    globalThis.__doxDiagnostics.browserEvaluation,
  );
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  // A failed compilation is reported through the same endpoint as a successful
  // run: the server recompiles and answers with the compiler's own diagnostic,
  // which belongs in the diagnostics panel. Throwing here instead would show a
  // toast carrying a stringified OCaml exception and no location.
  const failure = result?.kind === "ok"
    ? null
    : String(
        result?.message || result?.stderr || result?.stdout ||
          "The browser compiler reported an error.",
      ).trim();
  return api("/api/browser-evaluation-result", {
    method: "POST",
    signal,
    body: JSON.stringify({
      ...body,
      evaluationId: planPayload.plan.evaluationId,
      result: failure === null ? result : { ...result, message: failure },
    }),
  });
}

function scheduleEvaluation(
  source,
  {
    immediate = false,
    plan = buildExecutionPlan(source, state.document.blocks),
    retryCount = 0,
  } = {},
) {
  const session = currentSession();
  if (session?.provisional) {
    session.evaluationQueued = { source, plan };
    state.evaluating = false;
    return;
  }
  const pending = state.pendingEvaluation;
  if (
    pending &&
    !pending.started &&
    !immediate &&
    pending.path === state.path &&
    pending.baseProjectVersion === state.projectVersion &&
    executionInvalidation(pending.plan, plan) === null
  ) {
    pending.source = source;
    pending.plan = plan;
    return;
  }

  if (state.evalFrame !== null) cancelAnimationFrame(state.evalFrame);
  state.evalFrame = null;
  state.evaluationController?.abort();
  state.evaluationController = null;
  const generation = ++state.evalGeneration;
  const request = {
    generation,
    path: state.path,
    source,
    baseProjectVersion: state.projectVersion,
    plan,
    retryCount,
    started: false,
    executionToken: executionPendingToken(state.executionCore),
  };
  state.pendingEvaluation = request;
  state.evaluating = true;
  updateStatusOnly();
  const startEvaluation = async () => {
    if (state.pendingEvaluation !== request) return;
    request.started = true;
    const controller = new AbortController();
    state.evaluationController = controller;
    let retryWithoutExecutionCore = false;
    try {
      const payload = await performEvaluation(request, controller.signal);
      if (
        state.pendingEvaluation !== request ||
        request.generation !== state.evalGeneration ||
        request.path !== state.path ||
        request.source !== state.document.source
      ) {
        return;
      }
      if (request.baseProjectVersion !== state.projectVersion) {
        state.pendingEvaluation = null;
        state.evaluating = false;
        setExecutionCore(null);
        state.executionProblem = null;
        state.evaluationInvalidation ||= { blockFrom: 0, inlineFrom: 0 };
        scheduleEvaluation(state.document.source, {
          immediate: true,
          plan: buildExecutionPlan(state.document.source, state.document.blocks),
          retryCount: request.retryCount + 1,
        });
        return;
      }
      if (
        payload.projectVersion &&
        payload.projectVersion !== state.projectVersion
      ) {
        state.pendingEvaluation = null;
        state.evaluating = false;
        await refreshProjectIndex();
        if (
          request.retryCount < 1 &&
          request.path === state.path &&
          request.source === state.document.source
        ) {
          setExecutionCore(null);
          state.executionProblem = null;
          state.evaluationInvalidation ||= { blockFrom: 0, inlineFrom: 0 };
          scheduleEvaluation(state.document.source, {
            immediate: true,
            plan: buildExecutionPlan(state.document.source, state.document.blocks),
            retryCount: request.retryCount + 1,
          });
        }
        return;
      }
      const previousInvalidation = state.evaluationInvalidation;
      const evaluationSucceeded = Boolean(payload.evaluation?.ok);
      state.document = payload.document;
      state.evaluation = payload.evaluation;
      if (evaluationSucceeded) {
        cacheExecutionArtifact(
          payload.evaluation.executionArtifact,
          request.executionToken || payload.evaluation.executionArtifact,
        );
        if (request.executionToken && state.executionCore) {
          const installed = dispatchExecutionIntent(state.executionCore, {
            kind: "evaluation-succeeded",
            token: request.executionToken,
            artifact: payload.evaluation.executionArtifact,
          });
          retryWithoutExecutionCore = installExecutionTransition(installed);
          if (!installed.decision.startsWith("artifact-installed:")) {
            console.error("Execution artifact was not installed", installed);
          }
        } else {
          installInitialExecutionCore(payload.evaluation);
        }
        setExecutionCore(state.executionCore);
        if (retryWithoutExecutionCore) {
          setExecutionCore(null);
          state.evaluationInvalidation = previousInvalidation || {
            blockFrom: 0,
            inlineFrom: 0,
          };
        } else {
          state.evaluationPlan = request.plan;
          state.evaluationInvalidation = null;
        }
      } else {
        if (request.executionToken && state.executionCore) {
          setExecutionCore(dispatchExecutionIntent(state.executionCore, {
            kind: "evaluation-failed",
            token: request.executionToken,
            diagnostics: (payload.evaluation?.diagnostics || []).map(
              (diagnostic) => diagnostic.message,
            ),
          }).state);
        }
        // The failed result and its diagnostics describe the current source.
        // Runtime data remains stale through executionCore, but the compiler
        // error itself must not inherit the pending edit's faded styling.
        state.evaluationInvalidation = null;
      }
      state.pendingEvaluation = null;
      state.evaluating = false;
      if (retryWithoutExecutionCore && request.retryCount < 1) {
        scheduleEvaluation(state.document.source, {
          immediate: true,
          plan: buildExecutionPlan(state.document.source, state.document.blocks),
          retryCount: request.retryCount + 1,
        });
      }
      if (document.activeElement?.closest(".cm-editor")) {
        setMarkdownEditorEvaluation(state.sourceEditorView, {
          evaluation: state.evaluation,
          blocks: state.document.blocks,
          path: state.path,
        });
        updateStatusOnly();
        refreshInspector();
      } else {
        render();
      }
      if (state.sourceEditorView && state.cursorPosition) {
        scheduleTypeLookup(
          state.sourceEditorView,
          state.sourceEditorView.state.selection.main.head,
        );
      }
      if (evaluationSucceeded) applyDebuggerProjection();
    } catch (error) {
      if (
        state.pendingEvaluation !== request ||
        request.generation !== state.evalGeneration
      ) {
        return;
      }
      if (error.name === "AbortError") return;
      if (error.status === 409 && request.retryCount < 1) {
        state.pendingEvaluation = null;
        state.evaluating = false;
        try {
          await refreshProjectIndex();
          if (
            request.path === state.path &&
            request.source === state.document.source
          ) {
            setExecutionCore(null);
            state.executionProblem = null;
            state.evaluationInvalidation ||= { blockFrom: 0, inlineFrom: 0 };
            scheduleEvaluation(state.document.source, {
              immediate: true,
              plan: buildExecutionPlan(state.document.source, state.document.blocks),
              retryCount: request.retryCount + 1,
            });
          }
        } catch (refreshError) {
          toast(refreshError.message);
        }
        return;
      }
      state.pendingEvaluation = null;
      state.evaluating = false;
      toast(error.message);
      updateStatusOnly();
    } finally {
      if (state.evaluationController === controller) {
        state.evaluationController = null;
      }
    }
  };
  if (immediate) {
    void startEvaluation();
  } else {
    state.evalFrame = requestAnimationFrame(() => {
      state.evalFrame = null;
      void startEvaluation();
    });
  }
}

function updateStatusOnly() {
  const footer = document.querySelector(".statusbar");
  if (!footer) return;
  footer.textContent = state.workspaceError || "";
  footer.classList.toggle("status-error", Boolean(state.workspaceError));
  footer.setAttribute(
    "aria-hidden",
    state.workspaceError ? "false" : "true",
  );
  const engineToggle = document.querySelector("#evaluation-engine-toggle");
  if (engineToggle) syncEvaluationEngineToggle();
}

function scheduleAutosave(session, { immediate = false } = {}) {
  if (state.refactorInFlight || session.provisional) {
    session.autosaveQueued = true;
    return;
  }
  clearTimeout(session.autosaveTimer);
  session.autosaveTimer = setTimeout(
    () => void drainAutosave(session),
    immediate ? 0 : 300,
  );
}

async function drainAutosave(session) {
  if (session.collaboration) {
    try {
      const payload = await api("/api/collaboration/flush", {
        method: "POST",
        body: JSON.stringify({
          updates: session.collaboration
            ? [
                {
                  id: session.collaboration.id,
                  update: encodeCollaborationUpdate(session.collaboration),
                },
              ]
            : [],
        }),
      });
      if (payload.project) installAuthoritativeProject(payload.project);
      for (const mirrored of payload.acknowledgedSources || []) {
        const mirroredSession = Array.from(state.sessions.values()).find(
          (candidate) => candidate.path === mirrored.path,
        );
        if (!mirroredSession) continue;
        mirroredSession.savedVersion = mirrored.digest;
        mirroredSession.savedSource =
          mirroredSession.collaboration?.text.toString() ??
          mirroredSession.document.source;
      }
      if (session === currentSession()) {
        state.savedVersion = session.savedVersion;
        state.savedSource = session.savedSource;
        state.dirty = state.document.source !== session.savedSource;
      }
      return true;
    } catch (error) {
      session.conflict = error.message;
      if (session === currentSession()) {
        state.workspaceError = error.message;
        updateStatusOnly();
      }
      return false;
    }
  }
  clearTimeout(session.autosaveTimer);
  session.autosaveTimer = null;
  if (session.provisional) {
    session.autosaveQueued = true;
    return true;
  }
  if (session.autosaveInFlight) {
    session.autosaveQueued = true;
    return false;
  }
  const source =
    session === currentSession()
      ? state.document.source
      : sessionSource(session);
  if (source === session.savedSource) return true;
  const revision = session.editRevision;
  const expectedDigest = session.savedVersion;
  session.autosaveInFlight = true;
  session.autosaveQueued = false;
  let succeeded = false;
  try {
    const payload = await withProjectMutation(async () => {
      const result = await api("/api/page/source", {
        method: "PUT",
        body: JSON.stringify({
          module: session.persistenceModule || session.module,
          source,
          expectedDigest,
          editRevision: revision,
        }),
      });
      installAuthoritativeProject(result.project);
      return result;
    });
    session.savedVersion = payload.digest;
    session.savedSource = source;
    session.acknowledgedRevision = payload.acknowledgedRevision;
    session.conflict = null;
    const latestSource =
      session === currentSession()
        ? state.document.source
        : sessionSource(session);
    if (latestSource === source) clearRecoveryDraft(session.module);
    else storeRecoveryDraft(session, latestSource);
    if (session === currentSession()) {
      state.savedVersion = session.savedVersion;
      state.savedSource = session.savedSource;
      state.dirty = state.document.source !== session.savedSource;
      state.workspaceError = state.outlineConflict || null;
      updateStatusOnly();
      if (state.evaluationInvalidation) {
        scheduleEvaluation(state.document.source, {
          immediate: true,
          plan: buildExecutionPlan(
            state.document.source,
            state.document.blocks,
          ),
        });
      }
      void loadDependencyContext(session.module);
    }
    succeeded = true;
    return true;
  } catch (error) {
    session.conflict = error.message;
    if (session === currentSession()) {
      state.workspaceError = error.message;
      updateStatusOnly();
    }
    return false;
  } finally {
    session.autosaveInFlight = false;
    const currentSource =
      session === currentSession()
        ? state.document.source
        : sessionSource(session);
    if (
      succeeded &&
      (session.autosaveQueued || currentSource !== session.savedSource)
    ) {
      scheduleAutosave(session, { immediate: true });
    }
  }
}

async function save() {
  const session = currentSession();
  if (!session) return true;
  captureCurrentSession();
  return drainAutosave(session);
}

function mountEmbeddedEditors() {
  const documentParent = document.querySelector("[data-document-editor]");
  if (documentParent) {
    const session = currentSession();
    const mountedModule = state.module;
    const isCurrentDocument = () =>
      state.module === mountedModule &&
      state.sourceEditorView?.doxModule === mountedModule;
    state.sourceEditorView = mountMarkdownEditor(documentParent, {
      doc: state.document.source,
      editorState: session?.editorState || null,
      wikiModules:
        state.project?.pageIndex?.modules ||
        state.project?.documents.map((document) => document.module) ||
        [],
      onWikiNavigate: async (modulePath) => {
        if (!isCurrentDocument()) return;
        if (
          !state.project.documents.some(
            (document) => document.module === modulePath,
          )
        ) {
          state.workspaceError = `Module ${modulePath} does not exist yet. Add it in the module outline.`;
          updateStatusOnly();
          return;
        }
        await loadDocument(modulePath, {
          history: "push",
          focus: "main",
        });
      },
      onSave: save,
      sourceMode: state.sourceMode,
      collaboration: session?.collaboration || null,
      onDefinitionRequest: (position, mode) =>
        isCurrentDocument()
          ? requestDefinition(state.sourceEditorView, position, mode)
          : false,
      onDebugNavigate: (...args) => {
        return isCurrentDocument() ? navigateDebugCall(...args) : false;
      },
      onStateChange: (editorState) => {
        const mountedSession = state.sessions.get(mountedModule);
        if (mountedSession) mountedSession.editorState = editorState;
      },
      onCompletionKey: (...args) =>
        isCurrentDocument() ? handleCompletionKey(...args) : false,
      onChange: (source, edit) => {
        if (isCurrentDocument()) updateSource(source, edit);
      },
      onSelectionChange: (
        position,
        { docChanged = false, input = false } = {},
      ) => {
        if (!isCurrentDocument()) return;
        const line = state.sourceEditorView?.state.doc.lineAt(position).number;
        const block = state.document.blocks.find(
          (item) => line >= item.lineStart && line <= item.lineEnd,
        );
        if (block && block.id !== state.selected) {
          state.selected = block.id;
          state.selectedDefinitionName = null;
        }
        if (state.executionCore && line) {
          const sourceLine = state.sourceEditorView.state.doc.line(line);
          setExecutionCore(dispatchExecutionIntent(state.executionCore, {
            kind: "cursor-moved",
            position: {
              path: state.path,
              line,
              column: position - sourceLine.from,
            },
          }).state);
          applyDebuggerProjection();
          refreshInspector();
        }
        if (state.suppressNextCompletionLookup) {
          state.suppressNextCompletionLookup = false;
        } else if (input || (docChanged && state.completion)) {
          scheduleCompletion(state.sourceEditorView, position);
        } else if (state.completion) {
          invalidateCompletion();
          refreshInspector();
        }
        scheduleTypeLookup(state.sourceEditorView, position);
        scheduleDefinitionLookup(state.sourceEditorView, position);
      },
      onBlur: () => {
        if (!isCurrentDocument()) return;
        if (state.completion) {
          invalidateCompletion();
          refreshInspector();
        }
        if (
          !state.dirty ||
          !state.evaluationInvalidation
        ) {
          return;
        }
        scheduleEvaluation(state.document.source, {
          immediate: true,
          plan: buildExecutionPlan(
            state.document.source,
            state.document.blocks,
          ),
        });
      },
    });
    state.sourceEditorView.doxModule = state.module;
    if (session) {
      session.editorState = state.sourceEditorView.state;
      queueMicrotask(() => {
        state.sourceEditorView?.scrollDOM.scrollTo({
          top: session.scrollTop || 0,
        });
      });
    }
    setMarkdownEditorEvaluation(state.sourceEditorView, {
      evaluation: state.evaluation,
      blocks: state.document.blocks,
      path: state.path,
    });
    renderCompletionPopup();
    applyDebuggerProjection();
    const restoredEditor = state.sourceEditorView;
    const restoredPosition = restoredEditor.state.selection.main.head;
    queueMicrotask(() => {
      if (
        state.sourceEditorView === restoredEditor &&
        state.module === mountedModule
      ) {
        scheduleTypeLookup(restoredEditor, restoredPosition);
      }
    });
    if (state.evaluationInvalidation) {
      setMarkdownEditorResultInvalidation(
        state.sourceEditorView,
        state.evaluationInvalidation,
      );
    }
    return;
  }
  state.sourceEditorView = null;
}

function openSourceLine(line) {
  if (!line) return;
  state.view = "document";
  render();
  const editor = state.sourceEditorView;
  if (!editor) return;
  const sourceLine = editor.state.doc.line(Math.min(line, editor.state.doc.lines));
  editor.dispatch({
    selection: { anchor: sourceLine.from, head: sourceLine.to },
  });
  editor.focus();
}

let executionValueLensAnchor = null;
let executionValueLensHideTimer = null;

function ensureExecutionValueLens() {
  let lens = document.querySelector("#execution-value-lens");
  if (lens) return lens;
  lens = document.createElement("div");
  lens.id = "execution-value-lens";
  lens.className = "execution-value-lens";
  lens.hidden = true;
  lens.setAttribute("role", "tooltip");
  lens.innerHTML = '<code></code><span class="execution-value-lens-note"></span>';
  lens.addEventListener("pointerenter", () => {
    if (executionValueLensHideTimer !== null) {
      clearTimeout(executionValueLensHideTimer);
      executionValueLensHideTimer = null;
    }
  });
  lens.addEventListener("pointerleave", () => hideExecutionValueLens());
  document.body.append(lens);
  return lens;
}

function executionValueCellIsClipped(cell) {
  const content = cell.matches("code") ? cell : cell.querySelector("code");
  return Boolean(
    cell.dataset.executionValueTruncated === "true" ||
      (content && content.scrollWidth > content.clientWidth + 1),
  );
}

function positionExecutionValueLens() {
  const lens = document.querySelector("#execution-value-lens");
  const anchor = executionValueLensAnchor;
  if (!lens || lens.hidden || !anchor?.isConnected) return;
  const anchorRect = anchor.getBoundingClientRect();
  const lensRect = lens.getBoundingClientRect();
  const margin = 12;
  const gap = 8;
  const left = Math.min(
    Math.max(anchorRect.left, margin),
    Math.max(margin, window.innerWidth - lensRect.width - margin),
  );
  let top = anchorRect.bottom + gap;
  if (top + lensRect.height > window.innerHeight - margin) {
    top = Math.max(margin, anchorRect.top - lensRect.height - gap);
  }
  lens.style.left = `${Math.round(left)}px`;
  lens.style.top = `${Math.round(top)}px`;
}

function showExecutionValueLens(anchor, fullText, { recordedPreview = false } = {}) {
  if (!anchor?.isConnected || !fullText) return;
  if (executionValueLensHideTimer !== null) {
    clearTimeout(executionValueLensHideTimer);
    executionValueLensHideTimer = null;
  }
  const lens = ensureExecutionValueLens();
  lens.querySelector("code").textContent = fullText;
  const note = lens.querySelector(".execution-value-lens-note");
  note.textContent = recordedPreview ? "recorded preview" : "";
  note.hidden = !recordedPreview;
  executionValueLensAnchor = anchor;
  lens.hidden = false;
  lens.style.left = "0";
  lens.style.top = "0";
  requestAnimationFrame(positionExecutionValueLens);
}

function hideExecutionValueLens({ immediately = false } = {}) {
  if (executionValueLensHideTimer !== null) {
    clearTimeout(executionValueLensHideTimer);
    executionValueLensHideTimer = null;
  }
  const hide = () => {
    const lens = document.querySelector("#execution-value-lens");
    if (lens) lens.hidden = true;
    executionValueLensAnchor = null;
    executionValueLensHideTimer = null;
  };
  if (immediately) hide();
  else executionValueLensHideTimer = window.setTimeout(hide, 90);
}

function bindExecutionValueLens(inspector) {
  inspector
    ?.querySelectorAll("[data-execution-value-full]")
    .forEach((cell) => {
      cell.addEventListener("pointerenter", () => {
        if (!executionValueCellIsClipped(cell)) return;
        const fullText = cell.dataset.executionValueFull;
        const displayed = (cell.matches("code") ? cell : cell.querySelector("code"))
          ?.textContent.trim();
        showExecutionValueLens(cell, fullText, {
          recordedPreview:
            cell.dataset.executionValueTruncated === "true" &&
            displayed === fullText,
        });
      });
      cell.addEventListener("pointerleave", () => hideExecutionValueLens());
    });
  inspector
    ?.querySelectorAll("[data-execution-core-activation]")
    .forEach((button) => {
      button.addEventListener("focus", () => {
        requestAnimationFrame(() => {
          if (!button.matches(":focus-visible")) return;
          const cells = [...button.querySelectorAll("[data-execution-value-full]")];
          if (!cells.some((cell) => executionValueCellIsClipped(cell))) return;
          const [inputs, outcome] = cells.map(
            (cell) => cell.dataset.executionValueFull,
          );
          showExecutionValueLens(
            button,
            outcome === undefined ? inputs : `${inputs} → ${outcome}`,
          );
        });
      });
      button.addEventListener("blur", () => hideExecutionValueLens());
    });
}

function bindInspectorEvents() {
  const inspector = document.querySelector(".inspector");
  bindExecutionValueLens(inspector);
  inspector
    ?.querySelectorAll("[data-execution-trace-activation]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        hideExecutionValueLens({ immediately: true });
        navigateDebugCall(button.dataset.executionTraceActivation);
      });
    });
  inspector
    ?.querySelectorAll("[data-execution-trace-occurrence]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        hideExecutionValueLens({ immediately: true });
        navigateDebugCall(`occurrence:${button.dataset.executionTraceOccurrence}`);
      });
    });
  inspector
    ?.querySelectorAll("[data-execution-core-activation]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        hideExecutionValueLens({ immediately: true });
        if (!state.executionCore) return;
        const result = dispatchExecutionIntent(state.executionCore, {
          kind: "activation-chosen",
          activationId: button.dataset.executionCoreActivation,
        });
        setExecutionCore(result.state);
        applyDebuggerProjection();
        refreshInspector({ revealExecutionChoice: true });
      });
    });
  inspector
    ?.querySelectorAll("[data-execution-core-occurrence]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        hideExecutionValueLens({ immediately: true });
        if (!state.executionCore) return;
        installExecutionNavigation(
          dispatchExecutionIntent(state.executionCore, {
            kind: "occurrence-chosen",
            occurrenceId: button.dataset.executionCoreOccurrence,
          }),
          { animate: false },
        );
      });
    });
  document
    .querySelector("[data-definition-peek]")
    ?.addEventListener("click", () => openDefinition(state.definitionInfo));
  document.querySelectorAll("[data-module-link]").forEach((button) => {
    button.addEventListener("click", () =>
      loadDocument(button.dataset.moduleLink, {
        history: "push",
        focus: "main",
      }),
    );
  });
  document.querySelectorAll("[data-diagnostic-line]").forEach((diagnostic) => {
    diagnostic.addEventListener("click", () =>
      openSourceLine(Number(diagnostic.dataset.diagnosticLine)),
    );
  });
}

function paneWidthLimits(pane) {
  const viewport = window.innerWidth;
  const other =
    pane === "sidebar"
      ? state.paneWidths.inspector
      : state.paneWidths.sidebar;
  return pane === "sidebar"
    ? { minimum: 160, maximum: Math.max(160, Math.min(420, viewport - other - 410)) }
    : { minimum: 220, maximum: Math.max(220, viewport - other - 360) };
}

function setInspectorExpanded(expanded) {
  if (window.matchMedia("(max-width: 1000px)").matches) expanded = false;
  state.inspectorExpanded = Boolean(expanded);
  document
    .querySelector(".workspace")
    ?.classList.toggle("inspector-expanded", state.inspectorExpanded);
  const separator = document.querySelector('[data-pane-resizer="inspector"]');
  const actualWidth = Math.round(
    document.querySelector(".inspector")?.getBoundingClientRect().width ||
      state.paneWidths.inspector,
  );
  const limits = paneWidthLimits("inspector");
  separator?.setAttribute(
    "aria-valuemax",
    String(Math.max(limits.maximum, actualWidth)),
  );
  separator?.setAttribute("aria-valuenow", String(actualWidth));
  const button = document.querySelector("#inspector-width-toggle");
  if (!button) return;
  const label = state.inspectorExpanded
    ? "Restore context pane width"
    : "Expand context pane";
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(state.inspectorExpanded));
  button.title = `${state.inspectorExpanded ? "Restore context pane" : "Expand context pane"} (Command/Control–Shift–Enter)`;
  button.querySelector("span").textContent = state.inspectorExpanded ? "⤡" : "⤢";
}

function toggleInspectorExpanded() {
  if (state.view !== "document") return false;
  setInspectorExpanded(!state.inspectorExpanded);
  return true;
}

function collapseInspectorForResize() {
  if (!state.inspectorExpanded) return;
  const expandedWidth = document
    .querySelector(".inspector")
    ?.getBoundingClientRect().width;
  setInspectorExpanded(false);
  if (expandedWidth) setPaneWidth("inspector", expandedWidth);
}

function setPaneWidth(pane, width, { persist = false } = {}) {
  const limits = paneWidthLimits(pane);
  const next = Math.round(
    Math.min(limits.maximum, Math.max(limits.minimum, width)),
  );
  state.paneWidths[pane] = next;
  document
    .querySelector(".workspace")
    ?.style.setProperty(`--${pane}-width`, `${next}px`);
  const separator = document.querySelector(
    `[data-pane-resizer="${pane}"]`,
  );
  separator?.setAttribute("aria-valuemin", String(limits.minimum));
  separator?.setAttribute("aria-valuemax", String(limits.maximum));
  separator?.setAttribute("aria-valuenow", String(next));
  if (persist) savePaneWidths();
}

function bindPaneResizers() {
  document.querySelectorAll("[data-pane-resizer]").forEach((separator) => {
    const pane = separator.dataset.paneResizer;
    setPaneWidth(pane, state.paneWidths[pane]);
    separator.addEventListener("pointerdown", (event) => {
      if (window.matchMedia("(max-width: 1000px)").matches) return;
      if (pane === "inspector") collapseInspectorForResize();
      const startX = event.clientX;
      const startWidth = state.paneWidths[pane];
      separator.setPointerCapture(event.pointerId);
      document.body.classList.add("resizing-panes");
      const move = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        setPaneWidth(
          pane,
          startWidth + (pane === "sidebar" ? delta : -delta),
        );
      };
      const finish = () => {
        separator.removeEventListener("pointermove", move);
        separator.removeEventListener("pointerup", finish);
        separator.removeEventListener("pointercancel", finish);
        document.body.classList.remove("resizing-panes");
        savePaneWidths();
      };
      separator.addEventListener("pointermove", move);
      separator.addEventListener("pointerup", finish);
      separator.addEventListener("pointercancel", finish);
      event.preventDefault();
    });
    separator.addEventListener("dblclick", () => {
      if (pane === "inspector") collapseInspectorForResize();
      setPaneWidth(pane, pane === "sidebar" ? 160 : 340, {
        persist: true,
      });
    });
    separator.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (pane === "inspector") collapseInspectorForResize();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const delta = direction * (event.shiftKey ? 32 : 12);
      setPaneWidth(
        pane,
        state.paneWidths[pane] + (pane === "sidebar" ? delta : -delta),
        { persist: true },
      );
      event.preventDefault();
    });
  });
}

function clampPaneWidths() {
  if (window.matchMedia("(max-width: 1000px)").matches) {
    setInspectorExpanded(false);
    return;
  }
  setPaneWidth("sidebar", state.paneWidths.sidebar);
  setPaneWidth("inspector", state.paneWidths.inspector);
  setPaneWidth("sidebar", state.paneWidths.sidebar);
  if (state.inspectorExpanded) setInspectorExpanded(true);
}

function setSourceMode(mode) {
  state.sourceMode = mode;
  localStorage.setItem("dox:v2:editor-mode", mode);
  setMarkdownEditorMode(state.sourceEditorView, mode);
  document
    .querySelector(".workspace")
    ?.classList.toggle("source-context", mode === "source");
  document
    .querySelector(".document-shell")
    ?.classList.toggle("source-mode", mode === "source");
  const editor = document.querySelector("[data-document-editor]");
  editor?.setAttribute(
    "aria-label",
    mode === "source"
      ? "Raw Markdown source editor"
      : "Editable Markdown and OCaml document",
  );
  const button = document.querySelector("#source-mode-button");
  if (button) {
    const next = nextSourceMode(mode);
    button.textContent = sourceModeName[next];
    button.setAttribute("aria-label", `Switch to ${sourceModeName[next]} view`);
    button.classList.toggle("active", mode !== "literate");
  }
}

function setFilesExpanded(expanded) {
  const workspace = document.querySelector(".workspace");
  const button = document.querySelector("#files-toggle");
  const mobile = window.matchMedia("(max-width: 1000px)").matches;
  const next = Boolean(expanded && mobile);
  workspace?.classList.toggle("show-files", next);
  const label = next ? "Hide project files" : "Show project files";
  button?.setAttribute("aria-expanded", String(next));
  button?.setAttribute("aria-label", label);
  if (button) button.title = label;
  const main = document.querySelector(".main");
  const inspector = document.querySelector(".inspector");
  if (main) main.inert = next;
  if (inspector) inspector.inert = next;
  if (next) state.outlineView?.focus();
  else button?.focus();
}

function bindEvents() {
  mountOutlineEditor();
  bindPaneResizers();
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      render();
    });
  });
  document.querySelectorAll("[data-path]").forEach((button) => {
    button.addEventListener("click", async () => {
      const path = button.dataset.path;
      if (path === state.path) {
        state.view = "document";
        render();
      } else {
        const modulePath = state.project.documents.find(
          (document) => document.path === path,
        )?.module;
        if (!modulePath || !(await loadDocument(modulePath))) return;
        state.view = "document";
        render();
      }
    });
  });
  document.querySelectorAll("[data-definition]").forEach((button) => {
    button.addEventListener("click", () => {
      const definition = state.document.definitions.find((item) => item.name === button.dataset.definition);
      if (!definition) return;
      state.selected = definition.blockId;
      state.selectedDefinitionName = definition.name;
      openSourceLine(definition.line);
    });
  });
  document.querySelector("#save-button")?.addEventListener("click", save);
  document
    .querySelector("#source-mode-button")
    ?.addEventListener("click", () =>
      setSourceMode(nextSourceMode()),
    );
  const evaluationEngineToggle = document.querySelector(
    "#evaluation-engine-toggle",
  );
  if (evaluationEngineToggle && state.executionEngineLocked) {
    evaluationEngineToggle.hidden = true;
    evaluationEngineToggle.disabled = true;
    evaluationEngineToggle.title =
      "This workspace runs OxCaml in your browser only";
  } else if (evaluationEngineToggle) {
    evaluationEngineToggle.onclick = (event) => {
      state.evaluationEngine =
        state.evaluationEngine === "browser" ? "server" : "browser";
      localStorage.setItem("dox:v1:evaluation-engine", state.evaluationEngine);
      const button = event.currentTarget;
      const browser = state.evaluationEngine === "browser";
      button.setAttribute("aria-pressed", String(browser));
      button.title = `Run OxCaml ${browser ? "in this browser" : "on the local Dox server"}`;
      button.lastChild.textContent = browser ? "Browser" : "Server";
      state.evaluationController?.abort();
      if (state.document) {
        scheduleEvaluation(state.document.source, { immediate: true });
      }
    };
  }
  document
    .querySelector("#inspector-width-toggle")
    ?.addEventListener("click", toggleInspectorExpanded);
  document.querySelector(".document-shell")?.addEventListener("pointerdown", () => {
    if (state.inspectorExpanded) setInspectorExpanded(false);
  });
  document.querySelector("#files-toggle")?.addEventListener("click", () => {
    const workspace = document.querySelector(".workspace");
    setFilesExpanded(!workspace?.classList.contains("show-files"));
  });
  document
    .querySelector("#files-backdrop")
    ?.addEventListener("click", () => setFilesExpanded(false));
  document.querySelectorAll("[data-project-path]").forEach((card) => {
    const open = async () => {
      const path = card.dataset.projectPath;
      if (path === state.path) {
        state.view = "document";
        render();
        return;
      }
      const modulePath = state.project.documents.find(
        (document) => document.path === path,
      )?.module;
      if (modulePath && (await loadDocument(modulePath))) {
        state.view = "document";
        render();
      }
    };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
  bindInspectorEvents();
  mountEmbeddedEditors();
}

function refreshInspector({ revealExecutionChoice = false } = {}) {
  const inspector = document.querySelector(".inspector");
  if (inspector) {
    const html = renderInspector();
    if (
      inspector.dataset.rendered === "true" &&
      state.inspectorHtml === html
    ) {
      renderCompletionPopup();
      if (revealExecutionChoice) {
        inspector
          .querySelector('[data-execution-core-activation][aria-current="true"]')
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      return;
    }
    const scrollTop = inspector.scrollTop;
    const inspectorBounds = inspector.getBoundingClientRect();
    const anchorRow = document
      .elementFromPoint(
        inspectorBounds.left + 10,
        inspectorBounds.top + Math.min(48, inspector.clientHeight - 1),
      )
      ?.closest(".execution-occurrence");
    const scrollAnchor = anchorRow && inspector.contains(anchorRow)
      ? {
          activation: anchorRow.querySelector(
            "[data-execution-core-activation]",
          )?.dataset.executionCoreActivation,
          occurrence: anchorRow.querySelector(
            "[data-execution-core-occurrence]",
          )?.dataset.executionCoreOccurrence,
          offset: anchorRow.getBoundingClientRect().top - inspectorBounds.top,
        }
      : null;
    hideExecutionValueLens({ immediately: true });
    inspector.innerHTML = html;
    inspector.dataset.rendered = "true";
    state.inspectorHtml = html;
    inspector.scrollTop = scrollTop;
    if (scrollAnchor?.activation) {
      const row = Array.from(
        inspector.querySelectorAll(".execution-occurrence"),
      ).find((candidate) => {
        const activation = candidate.querySelector(
          "[data-execution-core-activation]",
        )?.dataset.executionCoreActivation;
        const occurrence = candidate.querySelector(
          "[data-execution-core-occurrence]",
        )?.dataset.executionCoreOccurrence;
        return (
          activation === scrollAnchor.activation &&
          occurrence === scrollAnchor.occurrence
        );
      });
      if (row) {
        inspector.scrollTop +=
          row.getBoundingClientRect().top -
          inspectorBounds.top -
          scrollAnchor.offset;
      }
    }
    if (revealExecutionChoice) {
      inspector
        .querySelector('[data-execution-core-activation][aria-current="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  renderCompletionPopup();
  bindInspectorEvents();
}

initialize();

window.addEventListener("resize", scheduleCompletionPopupPosition);
window.addEventListener("resize", clampPaneWidths);
window.addEventListener("resize", () => hideExecutionValueLens({ immediately: true }));
document.addEventListener("scroll", scheduleCompletionPopupPosition, true);
document.addEventListener(
  "scroll",
  (event) => {
    if (event.target.closest?.(".execution-value-lens")) return;
    hideExecutionValueLens({ immediately: true });
  },
  true,
);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  hideExecutionValueLens({ immediately: true });
  if (document.querySelector(".workspace.show-files")) {
    setFilesExpanded(false);
    event.preventDefault();
    event.stopPropagation();
  }
}, true);
document.addEventListener(
  "keydown",
  (event) => {
    if (
      event.key === "Enter" &&
      event.shiftKey &&
      (event.metaKey || event.ctrlKey) &&
      toggleInspectorExpanded()
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  true,
);

window.addEventListener("popstate", (event) => {
  state.navigationGeneration += 1;
  state.navigationController?.abort();
  state.navigationController = null;
  clearPendingNavigation();
  state.outlineNavigationRun = false;
  if (Number.isFinite(event.state?.outlineSelection)) {
    const length = state.outlineView?.state.doc.length ?? state.outlineText.length;
    state.outlineSelection = Math.min(
      Math.max(event.state.outlineSelection, 0),
      length,
    );
    syncOutlineEditor({ moveSelection: true });
  }
  const modulePath =
    event.state?.module ||
    decodeURIComponent(window.location.pathname.match(/^\/page\/(.+)$/)?.[1] || "");
  if (modulePath && modulePath !== state.module) {
    void loadDocument(modulePath, {
      force: true,
      history: "none",
      focus: "main",
    });
  }
});

window.addEventListener("pagehide", () => {
  captureCurrentSession();
  for (const session of state.sessions.values()) {
    if (session.document?.source !== session.savedSource) {
      void drainAutosave(session);
    }
  }
});
