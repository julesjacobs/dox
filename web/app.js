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
} from "./editor.bundle.js?v=20260801b";
import {
  executionCallLinkAt,
  executionActivationInactiveRanges,
  executionActiveRanges,
  executionCursorCoverageIsConsistent,
  executionFocusRangeAtPosition,
  executionFunctionSourceRange,
  executionNeverRunRanges,
  executionRangesWithFocus,
  executionIdentifierRange,
  executionTraceIdentifierRange,
  executionSnapshotKey,
} from "./execution-lens.js";
import {
  executionSessionCall,
  executionSessionCallForEvent,
  executionSessionChooseFocusedExecution,
  executionSessionFocusExecutions,
  executionSessionFocusValue,
  executionSessionFocusedEvents,
  executionSessionFocusRange,
  executionSessionEvent,
  executionSessionMatches,
  executionSessionReconcileFocus,
  executionSessionSelectEvent,
  executionSessionSelectCall,
  executionSessionSelectSite,
  pendingExecutionSession,
  readyExecutionSession,
} from "./execution-session.js";
import {
  createExecutionRecency,
  noteExecutionChoice,
  preferredExecutionChoice,
} from "./execution-preference.js";
import {
  createExecutionDraftMapping,
  mapExecutionDraftEvent,
  mapExecutionDraftSites,
  projectExecutionDraftEvents,
} from "./execution-draft.js";
import {
  executionTimelineEvents,
  executionTimelinePosition,
  executionTimelineSpan,
} from "./execution-timeline.js";
import {
  buildExecutionRecord,
  executionCallBindings,
} from "./execution-record.js";
import {
  executionCursorProbe,
  executionSiteAt,
  executionSourceTextForSite,
} from "./execution-cursor.js";

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
  projectMutationTail: Promise.resolve(),
  sessionToken: null,
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
  sourceEditorView: null,
  sourceMode:
    localStorage.getItem("dox:v2:editor-mode") === "source"
      ? "source"
      : "literate",
  paneWidths: { sidebar: 160, inspector: 340 },
  typeInfo: null,
  cursorPosition: null,
  definitionInfo: null,
  definitionGeneration: 0,
  definitionController: null,
  definitionTimer: null,
  completion: null,
  completionCache: new Map(),
  completionGeneration: 0,
  completionController: null,
  completionRequestKey: null,
  completionPositionFrame: null,
  suppressNextCompletionLookup: false,
  debugger: null,
  debuggerPreview: null,
  executionRecency: createExecutionRecency(),
  executionRevealGeneration: 0,
  executionTimelineScrubbing: false,
  executionTimelineCleanup: null,
  traceFocusGeneration: 0,
  preserveTraceFocusForSelection: false,
  executionSitesCache: new Map(),
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

function debuggerSnapshot({
  path = state.path,
  source = state.document?.source,
  projectVersion = state.projectVersion,
} = {}) {
  if (!path || typeof source !== "string" || !projectVersion) return null;
  return { path, source, projectVersion };
}

function debuggerMatchesSnapshot(debuggerState, snapshot) {
  return Boolean(
    executionSessionMatches(debuggerState, snapshot) &&
      !debuggerState.stale &&
      !debuggerState.provisional,
  );
}

function debuggerOwnsSnapshot(debuggerState, snapshot) {
  return Boolean(
    debuggerState &&
      snapshot &&
      debuggerState.projectVersion === snapshot.projectVersion &&
      debuggerState.sources?.[snapshot.path] === snapshot.source,
  );
}

function debuggerUsableForSnapshot(debuggerState, snapshot) {
  return Boolean(
    executionSessionMatches(debuggerState, snapshot) &&
      !debuggerState.stale &&
      debuggerState.status === "ready" &&
      debuggerState.sources?.[snapshot.path] === snapshot.source,
  );
}

function currentExecutionSiteIndex() {
  return state.debugger?.siteIndexes?.[state.path] || null;
}

function currentExecutionSites() {
  return currentExecutionSiteIndex()?.sites || [];
}

function clearExecutionDocumentState() {
  state.executionTimelineScrubbing = false;
}

function resetExecutionNavigation() {
  clearExecutionDocumentState();
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
  session.debugger = debuggerUsableForSnapshot(
    state.debugger,
    debuggerSnapshot(),
  )
    ? state.debugger
    : null;
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

function restoreSession(session, { preserveDebugger = false } = {}) {
  state.module = session.module;
  state.path = session.path;
  state.document = session.document;
  state.savedVersion = session.savedVersion;
  state.savedSource = session.savedSource;
  state.evaluation = session.evaluation || null;
  state.evaluationPlan = session.evaluationPlan || null;
  state.evaluationInvalidation = session.evaluationInvalidation || null;
  if (!preserveDebugger) {
    const snapshot = debuggerSnapshot({
      path: session.path,
      source: session.document.source,
    });
    state.debugger = debuggerUsableForSnapshot(session.debugger, snapshot)
      ? session.debugger
      : null;
  }
  state.selected = session.selected || session.document.blocks[0]?.id || null;
  state.dirty = session.document.source !== session.savedSource;
  if (preserveDebugger) clearExecutionDocumentState();
  else resetExecutionNavigation(session);
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
    preserveDebugger = false,
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
  captureCurrentSession();
  if (!preserveDebugger && modulePath !== state.module) {
    state.debugger = null;
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
    restoreSession(cached, { preserveDebugger });
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
    } else if (!preserveDebugger) {
      queueMicrotask(() => void startDebugger({ background: true }));
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
          preserveDebugger,
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
    const recovery = recoveredDraft(payload.module, diskVersion);
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
    state.path = payload.document.path;
    state.document = payload.document;
    state.savedVersion = diskVersion;
    state.savedSource = diskSource;
    state.evaluation = null;
    state.evaluationPlan = null;
    state.evaluationInvalidation = null;
    if (preserveDebugger) clearExecutionDocumentState();
    else resetExecutionNavigation();
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
      debugger: null,
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
    state.provisionalNavigation = null;
    updateRoute(payload.module, history);
    clearPendingNavigation();
    if (focus === "outline") state.outlineFocusTransfer = true;
    render();
    void loadDependencyContext(payload.module);
    scheduleEvaluation(payload.document.source, { immediate: true });
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
    await state.projectRefreshPromise;
    if (forceOutline) {
      installProjectSnapshot(state.project, {
        forceOutline: true,
        installEpoch: state.projectInstallEpoch,
      });
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
  return state.project;
}

async function revalidateCachedSession(
  session,
  provisional = null,
  refreshRetry = 0,
) {
  const modulePath = session.module;
  const digest = session.savedVersion;
  const revision = session.editRevision;
  const source = session.editorState?.doc.toString() || session.document.source;
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
        : session.editorState?.doc.toString() || session.document.source;
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
          : session.editorState?.doc.toString() || session.document.source;
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
  if (state.evaluation?.ok) return { label: "Ready", className: "status-ok" };
  if (state.evaluation) {
    return { label: "Needs attention", className: "status-error" };
  }
  return { label: "Not evaluated", className: "" };
}

function currentExecutionTimelineEvents() {
  return state.debugger?.events || [];
}

function executionCallForEvent(event) {
  return executionSessionCallForEvent(state.debugger, event);
}

function currentExecutionTimelineEvent() {
  return executionSessionEvent(state.debugger);
}

function currentDebugCall() {
  return executionSessionCall(state.debugger);
}

function displayedDebuggerState() {
  return state.debuggerPreview || state.debugger;
}

function executionRecencyNamespace(debuggerState) {
  return debuggerState?.evaluationId || executionSnapshotKey(debuggerState);
}

function preferredChoiceForSession(debuggerState, choices) {
  return preferredExecutionChoice(choices, state.executionRecency, {
    currentEventIndex: debuggerState?.focus?.eventIndex,
    namespace: executionRecencyNamespace(debuggerState),
  });
}

function preferFocusedExecution(debuggerState) {
  const choice = preferredChoiceForSession(
    debuggerState,
    executionSessionFocusExecutions(debuggerState),
  );
  return choice
    ? executionSessionChooseFocusedExecution(debuggerState, choice.eventIndex, {
        preserveAuthoritativeSelection: true,
      })
    : debuggerState;
}

function noteFocusedExecution(debuggerState = state.debugger) {
  const choice = executionSessionFocusExecutions(debuggerState).find(
    (candidate) => candidate.eventIndex === debuggerState?.focus?.eventIndex,
  );
  if (choice) {
    noteExecutionChoice(state.executionRecency, choice, {
      namespace: executionRecencyNamespace(debuggerState),
    });
  }
}

function setDebuggerPreview(preview) {
  const next = preview?.status === "ready" ? preview : null;
  if (state.debuggerPreview === next) return;
  state.debuggerPreview = next;
  applyDebuggerProjection();
}

function executionEventDescription(event) {
  if (!event) return "";
  if (event.phase === "return") {
    return `${event.label} returned ${displayDebugValue(event.detail, event.type)}`;
  }
  if (event.phase === "raise") {
    return `${event.label} raised ${displayDebugValue(event.detail, event.type)}`;
  }
  return event.kind === "function"
    ? `${event.label}${event.detail ? ` ${event.detail}` : ""}`
    : event.label;
}

function executionTimelineCallDepth(call) {
  let depth = 0;
  for (let current = call?.parent; current?.kind === "function"; current = current.parent) {
    depth += 1;
  }
  return depth;
}

function renderExecutionTimelineMatches(events) {
  const matches = executionSessionFocusExecutions(state.debugger).map(
    ({ eventIndex }) => eventIndex,
  );
  const selectedIndex = state.debugger?.focus?.eventIndex ?? -1;
  return matches
    .filter((index) => index >= 0 && index < events.length)
    .map((index) => {
      const position = executionTimelinePosition(index, events.length);
      return `<span
        class="execution-timeline-match${index === selectedIndex ? " selected" : ""}"
        data-execution-match="${index}"
        style="left:${position.toFixed(3)}%"
      ></span>`;
    })
    .join("");
}

function renderExecutionTimeline() {
  if (state.view !== "document") return "";
  const debuggerState = state.debugger;
  const events = currentExecutionTimelineEvents();
  if (!debuggerState || !events.length) {
    const label =
      debuggerState?.status === "loading" || state.evaluating
        ? "Preparing execution…"
        : state.evaluation?.ok
          ? "Execution unavailable"
          : state.evaluation?.diagnostics?.length
            ? "Fix errors to inspect execution"
            : "Execution appears after the document compiles";
    return `<section class="execution-timeline unavailable" aria-label="Execution timeline">
      <div class="execution-timeline-meta">
        <strong data-execution-mode-label>Execution</strong>
        <span>${escapeHtml(label)}</span>
      </div>
      <div class="execution-timeline-empty" aria-hidden="true"><span></span></div>
    </section>`;
  }

  const hasOccurrence = Number.isFinite(debuggerState.focus?.eventIndex);
  const index = Math.min(
    Math.max(debuggerState.focus?.eventIndex ?? 0, 0),
    events.length - 1,
  );
  const cursorExecutionCount =
    executionSessionFocusExecutions(debuggerState).length;
  const event = hasOccurrence ? events[index] : null;
  const call = executionCallForEvent(event);
  const selectedCallId = call?.id || null;
  const activePath = new Set(
    call ? debugCallBreadcrumb(call).map((ancestor) => ancestor.id) : [],
  );
  const allCalls = [...debuggerState.model.calls.values()].sort(
    (left, right) => left.enterSequence - right.enterSequence,
  );
  const stride = Math.max(1, Math.ceil(allCalls.length / 480));
  const spans = allCalls
    .filter(
      (candidate, candidateIndex) =>
        candidateIndex % stride === 0 ||
        candidate.id === selectedCallId ||
        activePath.has(candidate.id),
    )
    .map((candidate) => {
      const span = executionTimelineSpan(candidate, events);
      if (!span) return "";
      const left = executionTimelinePosition(span.start, events.length);
      const right = executionTimelinePosition(span.end, events.length);
      const width = Math.max(0.28, right - left);
      const depth = Math.min(executionTimelineCallDepth(candidate), 3);
      const classes = [
        "execution-timeline-span",
        candidate.id === selectedCallId ? "selected" : "",
        activePath.has(candidate.id) ? "on-path" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<span
        class="${classes}"
        data-timeline-call="${escapeHtml(candidate.id)}"
        style="--timeline-left:${left.toFixed(3)}%;--timeline-width:${width.toFixed(3)}%;--timeline-depth:${depth}"
        title="${escapeHtml(candidate.label)}"
      ></span>`;
    })
    .join("");
  const playhead = executionTimelinePosition(index, events.length);
  const moduleName =
    event &&
    (state.project?.documents.find((document) => document.path === event.path)
      ?.module || event.path);
  const breadcrumb = call
    ? debugCallBreadcrumb(call)
        .map((ancestor) =>
          ancestor.kind === "root" ? "Program" : ancestor.label,
        )
        .join(" › ")
    : hasOccurrence
      ? "Program"
      : "Selected code";
  return `<section class="execution-timeline${debuggerState.stale || debuggerState.provisional ? " stale" : ""}" data-execution-timeline aria-label="Execution timeline">
    <div class="execution-timeline-meta">
      <strong data-execution-mode-label>Execution</strong>
      <span><b data-execution-index>${hasOccurrence ? index + 1 : "–"}</b> of ${events.length}<i data-execution-here>${cursorExecutionCount ? ` · ${cursorExecutionCount} here` : ""}</i></span>
    </div>
    <div class="execution-timeline-content">
      <div class="execution-timeline-head">
        <span class="execution-timeline-stack" data-execution-stack>${escapeHtml(breadcrumb)}</span>
        <span class="execution-timeline-location" data-execution-location>${event ? `${escapeHtml(executionEventDescription(event))} · ${escapeHtml(moduleName)}:${event.line}` : "No execution reached the selected code"}</span>
      </div>
      <div class="execution-timeline-track">
        <div class="execution-timeline-spans" aria-hidden="true">${spans}</div>
        <div class="execution-timeline-rail" aria-hidden="true"></div>
        <div class="execution-timeline-matches" data-execution-matches aria-hidden="true">${renderExecutionTimelineMatches(events)}</div>
        <div class="execution-timeline-playhead" data-execution-playhead style="left:${playhead.toFixed(3)}%;${hasOccurrence ? "" : "opacity:0"}" aria-hidden="true"></div>
        <input
          type="range"
          min="0"
          max="${events.length - 1}"
          step="1"
        value="${index}"
        data-execution-scrubber
        ${debuggerState.stale ? "disabled" : ""}
        aria-label="Execution event"
          aria-valuetext="${escapeHtml(event ? `${index + 1} of ${events.length}: ${executionEventDescription(event)}` : "No execution selected")}"
        />
      </div>
    </div>
  </section>`;
}

function refreshExecutionTimeline() {
  const current = document.querySelector(".execution-timeline");
  if (!current || state.view !== "document") return;
  clearExecutionTimelineInteraction();
  const template = document.createElement("template");
  template.innerHTML = renderExecutionTimeline().trim();
  const next = template.content.firstElementChild;
  if (!next) return;
  current.replaceWith(next);
  bindExecutionTimelineEvents();
}

function updateExecutionTimelineDom(events = currentExecutionTimelineEvents()) {
  if (!events.length) return;
  const hasOccurrence = Number.isFinite(state.debugger?.focus?.eventIndex);
  const index = Math.min(
    Math.max(state.debugger?.focus?.eventIndex ?? 0, 0),
    events.length - 1,
  );
  const event = hasOccurrence ? events[index] : null;
  const call = executionCallForEvent(event);
  const playhead = executionTimelinePosition(index, events.length);
  const moduleName =
    event &&
    (state.project?.documents.find((document) => document.path === event.path)
      ?.module || event.path);
  const breadcrumb = call
    ? debugCallBreadcrumb(call)
        .map((ancestor) =>
          ancestor.kind === "root" ? "Program" : ancestor.label,
        )
        .join(" › ")
    : hasOccurrence
      ? "Program"
      : "Selected code";
  const indexNode = document.querySelector("[data-execution-index]");
  const stackNode = document.querySelector("[data-execution-stack]");
  const locationNode = document.querySelector("[data-execution-location]");
  const playheadNode = document.querySelector("[data-execution-playhead]");
  const hereNode = document.querySelector("[data-execution-here]");
  const scrubber = document.querySelector("[data-execution-scrubber]");
  if (indexNode) indexNode.textContent = hasOccurrence ? String(index + 1) : "–";
  if (hereNode) {
    const count = executionSessionFocusExecutions(state.debugger).length;
    hereNode.textContent = count
      ? ` · ${count} here`
      : "";
  }
  if (stackNode) stackNode.textContent = breadcrumb;
  if (locationNode) {
    locationNode.textContent = event
      ? `${executionEventDescription(event)} · ${moduleName}:${event.line}`
      : "No execution reached the selected code";
  }
  if (playheadNode) {
    playheadNode.style.left = `${playhead.toFixed(3)}%`;
    playheadNode.style.opacity = hasOccurrence ? "" : "0";
  }
  if (scrubber) {
    scrubber.value = String(index);
    scrubber.setAttribute(
      "aria-valuetext",
      event
        ? `${index + 1} of ${events.length}: ${executionEventDescription(event)}`
        : "No execution selected",
    );
  }
  const activePath = new Set(
    call ? debugCallBreadcrumb(call).map((ancestor) => ancestor.id) : [],
  );
  document.querySelectorAll("[data-timeline-call]").forEach((span) => {
    span.classList.toggle(
      "selected",
      span.dataset.timelineCall === call?.id,
    );
    span.classList.toggle(
      "on-path",
      activePath.has(span.dataset.timelineCall),
    );
  });
  document.querySelectorAll("[data-execution-match]").forEach((marker) => {
    marker.classList.toggle(
      "selected",
      Number(marker.dataset.executionMatch) === index,
    );
  });
}

function updateExecutionTimelineMatchesDom(
  events = currentExecutionTimelineEvents(),
) {
  const container = document.querySelector("[data-execution-matches]");
  if (container) {
    container.innerHTML = renderExecutionTimelineMatches(events);
  }
  const hereNode = document.querySelector("[data-execution-here]");
  if (hereNode) {
    const count = executionSessionFocusExecutions(state.debugger).length;
    hereNode.textContent = count
      ? ` · ${count} here`
      : "";
  }
}

function installTraceFocus(next, { refresh = true } = {}) {
  if (!next) return false;
  state.debuggerPreview = null;
  if (next === state.debugger) {
    noteFocusedExecution(next);
    return false;
  }
  state.debugger = next;
  noteFocusedExecution(next);
  state.traceFocusGeneration += 1;
  const session = currentSession();
  if (session) session.debugger = state.debugger;
  updateExecutionTimelineDom();
  applyDebuggerProjection();
  if (refresh) refreshInspector();
  return true;
}

function selectTraceSite(cursor, site) {
  if (!state.debugger) return false;
  const position = cursor
    ? { path: state.path, line: cursor.line, column: cursor.column }
    : null;
  const next = preferFocusedExecution(
    executionSessionSelectSite(state.debugger, position, site),
  );
  if (
    state.debugger.provisional &&
    !executionSessionFocusExecutions(next).length
  ) {
    applyDebuggerProjection();
    return false;
  }
  installTraceFocus(next);
  return executionSessionFocusExecutions(state.debugger).length > 0;
}

async function revealExecutionEvent(
  event,
  {
    allowDocumentChange = false,
    history = "replace",
    animate = false,
    moveCursor = false,
    focusGeneration = state.traceFocusGeneration,
  } = {},
) {
  if (!event) return;
  const generation = ++state.executionRevealGeneration;
  if (event.path !== state.path) {
    if (!allowDocumentChange) return;
    const modulePath = state.project?.documents.find(
      (document) => document.path === event.path,
    )?.module;
    if (
      !modulePath ||
      !(await loadDocument(modulePath, {
        preserveDebugger: true,
        history,
        focus: "none",
      })) ||
      generation !== state.executionRevealGeneration ||
      focusGeneration !== state.traceFocusGeneration ||
      !state.debugger
    ) {
      return;
    }
    const sources = {
      ...state.debugger.sources,
      [state.path]: state.document.source,
    };
    state.debugger = {
      ...state.debugger,
      sources,
      model: buildDebugCallModel(state.debugger, sources),
    };
    const session = currentSession();
    if (session) session.debugger = state.debugger;
    void loadExecutionSites(debuggerSnapshot());
  }
  if (
    generation !== state.executionRevealGeneration ||
    focusGeneration !== state.traceFocusGeneration ||
    event.path !== state.path ||
    !state.sourceEditorView
  ) {
    return;
  }
  const view = state.sourceEditorView;
  if (moveCursor) {
    const line = view.state.doc.line(
      Math.min(Math.max(event.line, 1), view.state.doc.lines),
    );
    state.preserveTraceFocusForSelection = true;
    view.dispatch({
      selection: {
        anchor: line.from + Math.min(event.column || 0, line.length),
      },
    });
    queueMicrotask(() => {
      state.preserveTraceFocusForSelection = false;
    });
  }
  scrollMarkdownEditorTo(
    view,
    { line: event.line, column: event.column || 0 },
    { animate },
  );
  applyDebuggerProjection();
  refreshInspector();
}

function selectTraceEvent(
  index,
  { revealSource = true, allowDocumentChange = false } = {},
) {
  const events = currentExecutionTimelineEvents();
  if (!events.length) return;
  if (state.debugger?.stale) return;
  const previousCallId = currentDebugCall()?.id || null;
  installTraceFocus(executionSessionSelectEvent(state.debugger, index), {
    refresh: !state.executionTimelineScrubbing,
  });
  const event = currentExecutionTimelineEvent();
  const call = currentDebugCall();
  if (
    state.sourceEditorView &&
    event.path === state.path
  ) {
    if (previousCallId !== call?.id) {
      setMarkdownEditorDebugProjection(
        state.sourceEditorView,
        focusedProjectionForDebugCall(call),
      );
    }
  }
  if (revealSource) {
    void revealExecutionEvent(event, {
      allowDocumentChange,
      moveCursor: !state.executionTimelineScrubbing,
      focusGeneration: state.traceFocusGeneration,
    });
  }
}

function clearExecutionTimelineInteraction() {
  state.executionTimelineCleanup?.();
  state.executionTimelineCleanup = null;
  state.executionTimelineScrubbing = false;
  document
    .querySelector(".main")
    ?.classList.remove("timeline-following");
  document
    .querySelector("[data-execution-timeline]")
    ?.classList.remove("scrubbing");
  state.sourceEditorView?.dom.classList.remove(
    "cm-timeline-scrubbing",
  );
}

function disposeMountedEditors() {
  clearExecutionTimelineInteraction();
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

function renderShell() {
  disposeMountedEditors();
  const existingSidebar = app.querySelector(".sidebar");
  app.innerHTML = `
    <div
      class="workspace ${state.view === "document" ? "document-context" : ""} ${state.sourceMode === "source" ? "source-context" : ""}"
      style="--sidebar-width: ${state.paneWidths.sidebar}px; --inspector-width: ${state.paneWidths.inspector}px"
    >
      <div class="body-grid">
        <aside class="sidebar">${renderSidebar()}</aside>
        <div class="pane-resizer pane-resizer-left" data-pane-resizer="sidebar" role="separator" aria-label="Resize module pane" aria-orientation="vertical" tabindex="0"></div>
        <main class="main" id="main-pane">
          <div class="main-actions">
            <button class="button pane-toggle files-toggle" id="files-toggle" aria-label="Show project files">Files</button>
            <button class="button secondary-action ${state.sourceMode === "source" ? "active" : ""}" id="source-mode-button" aria-pressed="${state.sourceMode === "source"}">${state.sourceMode === "source" ? "Document" : "Source"}</button>
          </div>
          ${renderMain()}
        </main>
        <div class="pane-resizer pane-resizer-right" data-pane-resizer="inspector" role="separator" aria-label="Resize context pane" aria-orientation="vertical" tabindex="0"></div>
        <aside class="inspector">${renderInspector()}</aside>
      </div>
      ${renderExecutionTimeline()}
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
  bindEvents();
}

function renderSidebar() {
  if (!state.project?.documents.length) {
    return `<div class="sidebar-brand">Dox</div><div class="module-outline-host" data-module-outline></div>`;
  }
  return `
    <div class="sidebar-brand">Dox</div>
    <div class="module-outline-host" data-module-outline aria-label="Editable module outline"></div>
  `;
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
  const modules = rows.flatMap((row) =>
    row.targetModule ? [row.targetModule] : [],
  );
  if (new Set(modules).size !== modules.length) {
    throw new Error("The outline contains a duplicate page module.");
  }
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
      const draft =
        session.editorState?.doc.toString() || session.document.source;
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
        editorState: replaceEditorStateDocument(session.editorState, source),
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
    session.module = modulePath;
    session.path = payload.document.path;
    session.document = changedDuringRefactor
      ? {
          ...payload.document,
          source,
          blocks: parseDraftBlocks(source),
        }
      : payload.document;
    session.editorState = editorState;
    session.savedSource = savedSource;
    session.savedVersion = payload.digest || payload.document.version;
    session.evaluation = null;
    session.evaluationPlan = null;
    session.evaluationInvalidation = null;
    session.conflict = null;
    session.autosaveQueued = changedDuringRefactor;
    if (changedDuringRefactor) {
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
      const source =
        session.editorState?.doc.toString() || session.document.source;
      return source !== session.savedSource;
    });
    if (!dirty.length) {
      return new Map(
        Array.from(state.sessions.entries()).map(([modulePath, session]) => [
          modulePath,
          {
            source:
              session.editorState?.doc.toString() ||
              session.document.source,
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
  const previous = outlineModules(
    state.outlineBase?.committedRowsWithOrigins || [],
  );
  const next = draft.modules;
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  const removed = previous.filter((modulePath) => !nextSet.has(modulePath));
  const added = next.filter((modulePath) => !previousSet.has(modulePath));
  const renames = draft.rows
    .filter(
      (row) =>
        row.originTarget &&
        row.targetModule &&
        row.originTarget !== row.targetModule,
    )
    .map((row) => ({
      before: row.originTarget,
      after: row.targetModule,
    }));
  const renamedFrom = new Set(renames.map(({ before }) => before));
  const renamedTo = new Set(renames.map(({ after }) => after));
  const deleted = removed.filter((modulePath) => !renamedFrom.has(modulePath));
  const created = added.filter((modulePath) => !renamedTo.has(modulePath));
  const orderChanged =
    previous.length !== next.length ||
    previous.some((modulePath, index) => modulePath !== next[index]);
  if (
    !removed.length &&
    !added.length &&
    !orderChanged &&
    state.outlineText !== state.outlineCommittedText
  ) {
    if (!submittedDraft.split("\n").some((line) => !line.trim())) {
      installProjectSnapshot(state.project, { forceOutline: true });
    }
    return true;
  }
  state.outlineCommitting = true;
  state.outlineSubmittedGeneration = submittedGeneration;
  const controller = new AbortController();
  state.outlineCommitController = controller;
  let authoritativeProject = null;
  let appliedMapping = [];
  let releaseProjectMutation = null;
  try {
    if (deleted.length) {
      throw new Error(
        "Removing a module requires an explicit delete confirmation.",
      );
    }
    if (renames.length || created.length) {
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
        const projectVersion = state.outlineBase.projectVersion;
        const preview = await api("/api/refactor/preview", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({ projectVersion, renames }),
        });
        const payload = await api("/api/refactor/apply", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            projectVersion,
            previewId: preview.previewId,
            renames,
          }),
        });
        appliedMapping = payload.mapping || [];
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
      if (created.length) {
        const payload = await api("/api/pages", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            modules: created,
            baseProjectVersion: authoritativeProject.version,
          }),
        });
        authoritativeProject = payload.project;
      }
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
    const structuralOrderChange = renames.length > 0 || created.length > 0;
    if (shouldPersistOrder || structuralOrderChange) {
      releaseProjectMutation ??= await acquireProjectMutation();
      const payload = await api("/api/page-order", {
        method: "PUT",
        signal: controller.signal,
        body: JSON.stringify({
          modules: next,
          baseOrder: structuralOrderChange ? [] : authoritativeOrder,
          baseProjectVersion: authoritativeProject.version,
        }),
      });
      authoritativeProject = payload.project;
    }

    const draftAdvanced = state.outlineDraftGeneration > submittedGeneration;
    const retainsInsertionRow = submittedDraft
      .split("\n")
      .some((line) => !line.trim());
    const retainsActiveDraft = draft.rows.some(
      (row) => row.changed && row.sourceLine === submittedCursorLine,
    );
    const newerDraft = draftAdvanced
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
    if (!state.outlineConflict) state.workspaceError = null;
    invalidateDependencyContext({ clear: true });
    const openedModule = appliedMapping.reduce(
      (modulePath, mapping) =>
        modulePath === mapping.before ? mapping.after : modulePath,
      openModule,
    );
    const cursorModule = appliedMapping.reduce(
      (modulePath, mapping) =>
        modulePath === mapping.before ? mapping.after : modulePath,
      submittedCursorRow?.targetModule ||
        submittedCursorRow?.originTarget ||
        null,
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
    render();
    syncOutlineEditor({
      moveSelection: cursorPosition !== null || Boolean(openedModule),
    });
    if (state.module) void loadDependencyContext(state.module);
    return true;
  } catch (error) {
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
    for (const session of state.sessions.values()) {
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
  if (state.outlineText !== state.outlineCommittedText) {
    const committed = await commitOutline({
      reason: "navigate",
      openModule: modulePath,
    });
    if (!committed) return;
  }
  if (!state.project?.pageIndex?.modules?.includes(modulePath)) {
    if (state.outlineConflict || state.outlineDraftError) return;
    await withProjectMutation(async () => {
      const payload = await api("/api/pages", {
        method: "POST",
        body: JSON.stringify({
          modules: [modulePath],
          baseProjectVersion: state.projectVersion,
        }),
      });
      installAuthoritativeProject(payload.project, { forceOutline: true });
    });
    render();
  }
  if (modulePath === state.module) {
    queueMicrotask(() => state.outlineView?.focus());
    return;
  }
  await loadDocument(modulePath, {
    history: outlineHistoryMode(kind),
    focus: "outline",
  });
}

function cancelOutlineDraft() {
  state.outlineConflict = null;
  state.outlineDraftError = null;
  installProjectSnapshot(state.project, { forceOutline: true });
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
    onChange: (source, update, { moveOrigins = null } = {}) => {
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
        const carriedByLine = new Map(
          carriedRows.map((row) => [row.sourceLine, row]),
        );
        state.outlineLineMap = source.split("\n").map((text, index) => {
          const sourceLine = index + 1;
          return {
            ...(carriedByLine.get(sourceLine) || {}),
            text,
            sourceLine,
            invalid: !line || line === sourceLine,
            error: error.message,
          };
        });
      }
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
      const line =
        state.outlineView?.state.doc.lineAt(state.outlineSelection).number || 1;
      const row = outlineRowAtLine(line);
      const openModule =
        reason === "enter" || reason === "mod-enter"
          ? row?.targetModule || row?.originTarget || null
          : null;
      if (openModule) {
        void openOutlineModule(row, "explicit").catch((error) => {
          state.workspaceError = error.message;
          updateStatusOnly();
        });
      } else {
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
    return `<div class="empty-state"><h2>The project has no live documents yet.</h2><p>Create a file ending in <code>.ml.md</code>.</p></div>`;
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
              <article class="project-card" data-project-path="${escapeHtml(document.path)}" tabindex="0">
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

const sourceFunctionRange = executionFunctionSourceRange;

function buildDebugCallModel(debuggerPayload, sources) {
  return buildExecutionRecord(debuggerPayload.callEvents || [], {
    rootLabel: (path) =>
      state.project?.documents.find((document) => document.path === path)
        ?.module || path,
    rangeFor: (occurrence) =>
      sources[occurrence.path]
        ? sourceFunctionRange(sources[occurrence.path], occurrence)
        : { start: occurrence.line, end: occurrence.line + 120 },
  });
}

function findIdentifierSpan(source, lineNumber, name, preferredColumn = 0) {
  const line = source.split("\n")[lineNumber - 1] || "";
  const range = executionIdentifierRange(
    line,
    name,
    preferredColumn,
  );
  if (!range) return null;
  return {
    line: lineNumber,
    ...range,
  };
}

function findTracedIdentifierSpan(source, binding, fallbackLine) {
  const lineNumber = binding.line || fallbackLine;
  const line = source.split("\n")[lineNumber - 1] || "";
  const range = executionTraceIdentifierRange(
    line,
    binding.name,
    binding.column,
    binding.endColumn,
  );
  return range ? { line: lineNumber, ...range } : null;
}

function debugResultType(type = "") {
  const pieces = type.split(/\s*->\s*/);
  return pieces[pieces.length - 1]?.trim() || type;
}

function displayDebugValue(value, type = "") {
  if (!/^<value(?:\s|>)/.test(value || "")) return value ?? "";
  const resultType = debugResultType(type);
  return resultType ? `${resultType} value` : "value";
}

function singleLineDebugValue(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function abbreviatedDebugValue(value, limit) {
  const text = singleLineDebugValue(value);
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  if (limit < 7) return `${characters.slice(0, Math.max(1, limit - 1)).join("")}…`;
  const tail = Math.min(6, Math.floor((limit - 1) / 3));
  const head = limit - tail - 1;
  return `${characters.slice(0, head).join("")}…${characters.slice(-tail).join("")}`;
}

function debugExecutionChoice(choice) {
  const { call, event, outcomeEvent } = choice;
  const expression =
    call.kind === "root" &&
    event?.kind !== "binding" &&
    Boolean(state.debugger?.focus?.site);
  const fullLabel = expression
    ? executionSourceTextForSite(
        state.document?.source || "",
        state.debugger.focus.site,
      ) || event.label || "expression"
    : call.kind === "root"
      ? "Program"
      : call.label || "function";
  const fullArguments = (call.parameters || []).map((parameter) =>
    singleLineDebugValue(displayDebugValue(parameter.value, parameter.type)),
  );
  const fullResult = expression
    ? singleLineDebugValue(
        displayDebugValue(
          outcomeEvent?.detail,
          outcomeEvent?.type || event?.type,
        ),
      )
    : call.kind === "root" || call.value === undefined
      ? ""
      : singleLineDebugValue(
          displayDebugValue(call.value, call.returnType || call.type),
        );
  const label = abbreviatedDebugValue(fullLabel, expression ? 180 : 120);
  const result = abbreviatedDebugValue(fullResult, 360);
  const visibleArguments =
    fullArguments.length > 8
      ? [...fullArguments.slice(0, 7), `…+${fullArguments.length - 7}`]
      : fullArguments;
  const arguments_ = visibleArguments.map((argument) =>
    abbreviatedDebugValue(argument, 360),
  );
  return {
    label,
    expression,
    arguments_,
    result,
    raised: expression
      ? outcomeEvent?.phase === "raise"
      : call.outcome === "raise",
    title:
      call.kind === "root"
        ? expression
          ? `${fullLabel} ${outcomeEvent?.phase === "raise" ? "!" : "→"} ${fullResult || "…"}`
          : fullLabel
        : `${fullLabel}(${fullArguments.join(", ")}) ${call.outcome === "raise" ? "!" : "→"} ${fullResult || "…"}`,
  };
}

function debugFocusedExpression(debuggerState = state.debugger) {
  const focused = executionSessionFocusValue(debuggerState);
  if (!focused) return null;
  const source = debuggerState?.sources?.[state.path] || state.document?.source || "";
  const expression =
    focused.kind === "parameter" || focused.kind === "binding"
      ? focused.label
      : executionSourceTextForSite(source, debuggerState?.focus?.site) ||
        focused.label ||
        "expression";
  const fullValue = singleLineDebugValue(
    displayDebugValue(focused.value, focused.type),
  );
  const value = abbreviatedDebugValue(fullValue, 720);
  return {
    expression,
    value,
    fullValue,
    type: singleLineDebugValue(focused.type),
    raised: focused.outcome === "raise",
    title: `${expression} ${focused.outcome === "raise" ? "!" : "→"} ${fullValue}${focused.type ? ` : ${focused.type}` : ""}`,
  };
}

function debugValueAtEditorPosition(offset) {
  const editor = state.sourceEditorView;
  const debuggerState = state.debugger;
  if (
    !editor ||
    debuggerState?.status !== "ready" ||
    debuggerState.stale ||
    !Number.isFinite(offset)
  ) {
    return null;
  }
  const line = editor.state.doc.lineAt(
    Math.min(Math.max(offset, 0), editor.state.doc.length),
  );
  const position = {
    path: state.path,
    line: line.number,
    column: offset - line.from,
  };
  const site = executionSiteAt(currentExecutionSites(), position, {
    ...executionCursorProbe(line.text, position.column),
    line: line.text,
  });
  if (!site || site.kind === "syntax") return null;
  const hovered = executionSessionSelectSite(debuggerState, position, site);
  const related = executionSessionFocusExecutions(hovered);
  const choice = preferredChoiceForSession(
    hovered,
    related,
  );
  if (!choice) return null;
  const focused = {
    ...hovered,
    focus: {
      ...hovered.focus,
      eventIndex: choice.eventIndex,
    },
  };
  const summary = debugFocusedExpression(focused);
  const range = hovered.focus?.range;
  return summary && range?.path === state.path
    ? {
        ...summary,
        line: range.line,
        column: range.column,
        endColumn: range.endColumn,
        previewSession: focused,
      }
    : null;
}

function sourceIndent(lines, line) {
  const spaces = (lines[line - 1] || "").match(/^ */)?.[0].length || 0;
  return Math.max(0, spaces - 4) + 2;
}

function projectionForDebugCall(call, debuggerState = state.debugger) {
  if (!call || call.path !== state.path) return null;
  const source = state.document?.source || "";
  const lines = source.split("\n");
  if (call.kind === "root") {
    const focusedEvents = debuggerState?.focus?.site
      ? executionSessionFocusedEvents(debuggerState)
      : [];
    const projectedCall = focusedEvents.length
      ? { ...call, ownOccurrences: focusedEvents }
      : call;
    const links = [];
    const annotations = [];
    const occupied = new Set();
    const callsiteGroups = new Map();
    for (const child of call.children || []) {
      if (!child.callsiteKey || child.callsiteLine < 1) continue;
      if (!callsiteGroups.has(child.callsiteKey)) {
        callsiteGroups.set(child.callsiteKey, []);
      }
      callsiteGroups.get(child.callsiteKey).push(child);
    }
    for (const children of callsiteGroups.values()) {
      const child = children[0];
      const callsiteLine = child.callsiteLine;
      if (!callsiteLine || child.callsitePath !== call.path) continue;
      const inlineResult = state.evaluation?.inlineResults?.some(
        (result) =>
          result.path === call.path &&
          result.line === callsiteLine &&
          (child.callsiteColumn || 0) >= result.columnStart &&
          (child.callsiteColumn || 0) <= result.columnEnd,
      );
      if (
        !inlineResult &&
        children.length === 1 &&
        child.value !== undefined
      ) {
        const returnedValue = displayDebugValue(
          child.value,
          child.returnType || child.type,
        );
        const annotationValue =
          child.outcome === "raise"
            ? `! ${returnedValue}`
            : `→ ${returnedValue}`;
        annotations.push({
          line: callsiteLine,
          indent: sourceIndent(lines, callsiteLine),
          items: [
            {
              kind: child.outcome === "raise" ? "raise" : "return",
              value: annotationValue,
              fullValue: annotationValue,
              type: debugResultType(child.returnType || child.type),
            },
          ],
        });
      }
      const span = findIdentifierSpan(
        source,
        callsiteLine,
        child.label,
        child.callsiteColumn || 0,
      );
      const key = span && `${span.line}:${span.column}:${span.endColumn}`;
      if (!span || occupied.has(key)) continue;
      occupied.add(key);
      links.push({
        ...span,
        callId: child.id,
        label: child.label,
        kind: "child",
      });
    }
    return {
      activationRange: null,
      activationInactiveRanges: [],
      activeRanges: executionActiveRanges({
        source,
        call: projectedCall,
        sites: currentExecutionSites(),
      }),
      inactiveRanges: executionNeverRunRanges({
        source,
        path: state.path,
        events: debuggerState?.events || [],
        sites: currentExecutionSites(),
      }),
      activity: [],
      annotations,
      links,
    };
  }
  const range = sourceFunctionRange(source, call);
  call.range = range;
  const executed = call.executedLines || new Set([call.line]);

  const annotations = new Map();
  const addAnnotation = (line, item) => {
    if (!annotations.has(line)) annotations.set(line, []);
    if (
      !annotations
        .get(line)
        .some(
          (existing) =>
            existing.kind === item.kind &&
            existing.name === item.name &&
            existing.callId === item.callId &&
            existing.column === item.column &&
            existing.endColumn === item.endColumn,
        )
    ) {
      annotations.get(line).push(item);
    }
  };
  for (const binding of executionCallBindings(call)) {
    if (binding.value === "<function>") continue;
    const fullValue = displayDebugValue(binding.value, binding.type);
    const span = findTracedIdentifierSpan(source, binding, call.line);
    addAnnotation(binding.line || call.line, {
      ...binding,
      line: binding.line || call.line,
      kind: "value",
      value: fullValue,
      fullValue,
      column: span?.column,
      endColumn: span?.endColumn,
    });
  }

  const links = [];
  const parentSpan = findIdentifierSpan(
    source,
    call.line,
    call.label,
    call.column,
  );
  if (parentSpan && call.parent) {
    links.push({
      ...parentSpan,
      callId: call.parent.id,
      label: call.parent.label,
      kind: "parent",
    });
  }
  const occupiedChildLinks = new Set();
  const childGroups = new Map();
  for (const child of call.children || []) {
    const key = child.callsiteKey || `${child.id}`;
    if (!childGroups.has(key)) childGroups.set(key, []);
    childGroups.get(key).push(child);
  }
  for (const children of childGroups.values()) {
    const child = children[0];
    const line = child.callsiteLine;
    if (!line || child.callsitePath !== call.path) continue;
    const span = findIdentifierSpan(
      source,
      line,
      child.label,
      child.callsiteColumn || 0,
    );
    if (span) {
      const key = `${span.line}:${span.column}:${span.endColumn}`;
      if (occupiedChildLinks.has(key)) continue;
      occupiedChildLinks.add(key);
      links.push({
        ...span,
        callId: child.id,
        label: child.label,
        kind: "child",
      });
    }
  }
  const lastExecuted = Math.max(call.line, ...executed);
  const returnLine = Math.min(
    Math.max(lastExecuted, range.start),
    range.end,
  );
  const returnedValue = displayDebugValue(
    call.value,
    call.returnType || call.type,
  );
  if (call.value !== undefined) {
    const annotationValue =
      call.outcome === "raise"
        ? `! ${returnedValue}`
        : `→ ${returnedValue}`;
    addAnnotation(returnLine, {
      kind: call.outcome === "raise" ? "raise" : "return",
      value: annotationValue,
      fullValue: annotationValue,
      type: debugResultType(call.returnType || call.type),
    });
  }
  const additionalRanges = [...annotations.entries()].flatMap(
    ([line, items]) =>
      items
        .filter(
          (item) =>
            item.kind === "value" &&
            Number.isFinite(item.column) &&
            Number.isFinite(item.endColumn),
        )
        .map((item) => ({
          startLine: line,
          startColumn: item.column,
          endLine: line,
          endColumn: item.endColumn,
        })),
  );
  const sites = currentExecutionSites();
  const inactiveRanges = executionNeverRunRanges({
    source,
    path: state.path,
    events: debuggerState?.events || [],
    sites,
  });
  return {
    activationRange: {
      startLine: range.start,
      endLine: range.end,
      startColumn: range.startColumn,
      endColumn: range.endColumn,
    },
    activationInactiveRanges: executionActivationInactiveRanges({
      source,
      call,
      sites,
      excludeRanges: inactiveRanges,
    }),
    activeRanges: executionActiveRanges({
      source,
      call,
      sites,
      additionalRanges,
    }),
    inactiveRanges,
    activity: [],
    annotations: [...annotations.entries()]
      .sort(([left], [right]) => left - right)
      .map(([line, items]) => ({
        line,
        indent: sourceIndent(lines, line),
        items,
      })),
    links,
  };
}

function focusedProjectionForDebugCall(
  call,
  debuggerState = state.debugger,
) {
  const projection = projectionForDebugCall(call, debuggerState);
  if (!projection) return null;
  const position = state.cursorPosition
    ? { path: state.path, ...state.cursorPosition }
    : null;
  const executionCount = executionSessionFocusExecutions(
    debuggerState,
  ).length;
  const cursorFocus = executionFocusRangeAtPosition(
    executionSessionFocusRange(debuggerState),
    position,
    executionCount,
  );
  const activeRanges = executionRangesWithFocus(
    projection.activeRanges,
    cursorFocus,
    position,
    executionCount,
  );
  const focused = {
    ...projection,
    activeRanges,
    cursorFocus:
      cursorFocus?.path === state.path ? cursorFocus : null,
    cursorAnchor:
      position?.path === state.path ? position : null,
    cursorValue:
      cursorFocus?.path === state.path
        ? debugFocusedExpression(debuggerState)
        : null,
  };
  if (position) {
    console.assert(
      executionCursorCoverageIsConsistent({
        activeRanges,
        inactiveRanges: projection.inactiveRanges,
        activationInactiveRanges: projection.activationInactiveRanges,
        position,
        executionCount,
      }),
      "Execution coverage is inconsistent at the source cursor",
      { position, executionCount, callId: call.id },
    );
  }
  return focused;
}

function applyDebuggerProjection() {
  const editor = state.sourceEditorView;
  if (!editor) return;
  const active = Boolean(state.debugger);
  const debuggerReady = Boolean(
    state.debugger?.status === "ready" &&
      !state.debugger.stale &&
      state.debugger.sources?.[state.path] === state.document?.source,
  );
  editor.dom.classList.toggle(
    "cm-execution-lens",
    active,
  );
  editor.dom.classList.toggle(
    "cm-execution-lens-loading",
    active && !debuggerReady,
  );
  editor.dom.classList.toggle(
    "cm-execution-lens-provisional",
    Boolean(state.debugger?.provisional),
  );
  if (!active) {
    delete editor.dom.dataset.executionLensCall;
    setMarkdownEditorDebugProjection(editor, null);
    return;
  }
  if (!debuggerReady) {
    delete editor.dom.dataset.executionLensCall;
    setMarkdownEditorDebugProjection(editor, null);
    return;
  }
  const debuggerState = displayedDebuggerState();
  const call = executionSessionCall(debuggerState);
  if (!call) {
    delete editor.dom.dataset.executionLensCall;
    const inactiveRanges = executionNeverRunRanges({
      source: state.document?.source || "",
      path: state.path,
      events: debuggerState?.events || [],
      sites: currentExecutionSites(),
    });
    const position = state.cursorPosition
      ? { path: state.path, ...state.cursorPosition }
      : null;
    if (position && state.debugger?.focus?.site) {
      console.assert(
        executionCursorCoverageIsConsistent({
          activeRanges: [],
          inactiveRanges,
          position,
          executionCount: 0,
        }),
        "Unreached source cursor is not globally faded",
        { position, site: state.debugger.focus.site },
      );
    }
    setMarkdownEditorDebugProjection(editor, {
      activeRanges: [],
      inactiveRanges,
      annotations: [],
      links: [],
      activity: [],
      cursorFocus: null,
    });
    return;
  }
  editor.dom.dataset.executionLensCall = call.id;
  setMarkdownEditorDebugProjection(
    editor,
    focusedProjectionForDebugCall(call, debuggerState),
  );
}

function debugCallLinkAtPosition(position) {
  const editor = state.sourceEditorView;
  const call = currentDebugCall();
  if (!editor || !call || !Number.isFinite(position)) return null;
  const sourceLine = editor.state.doc.lineAt(
    Math.min(Math.max(position, 0), editor.state.doc.length),
  );
  const column = position - sourceLine.from;
  return executionCallLinkAt(
    projectionForDebugCall(call)?.links,
    sourceLine.number,
    column,
  );
}

function navigateDebugCall(callId, position) {
  const resolved = callId || debugCallLinkAtPosition(position);
  if (!resolved) return false;
  void showDebugCall(resolved, { scroll: true });
  return true;
}

function debugCallBreadcrumb(call) {
  const calls = [];
  for (let current = call; current; current = current.parent) {
    calls.push(current);
  }
  return calls.reverse();
}

function renderDebugger() {
  if (!state.debugger) {
    if (!state.evaluating) return "";
    return `<section class="debugger-panel debugger-loading" aria-live="polite">
      <span class="debugger-pulse"></span>
      <span>Preparing execution…</span>
    </section>`;
  }
  if (state.debugger.status === "loading") {
    return `<section class="debugger-panel debugger-loading" aria-live="polite">
      <span class="debugger-pulse"></span>
      <span>Reconstructing calls…</span>
    </section>`;
  }
  const debuggerState = state.debugger;
  if (debuggerState.status === "error") {
    return `<button type="button" class="debugger-stale" data-debug-start title="${escapeHtml(debuggerState.error || "")}">Execution unavailable · retry</button>`;
  }
  const siteIndex = currentExecutionSiteIndex();
  if (siteIndex?.status === "loading" && !debuggerState.focus?.site) {
    return `<section class="debugger-panel debugger-loading" aria-live="polite">
      <span class="debugger-pulse"></span>
      <span>Reading code…</span>
    </section>`;
  }
  if (siteIndex?.status === "error" && !debuggerState.focus?.site) {
    return `<section class="debugger-panel">
      <button type="button" class="debugger-stale" data-debug-sites-retry title="${escapeHtml(siteIndex.error || "")}">Could not read code · retry</button>
    </section>`;
  }
  const executions = executionSessionFocusExecutions(debuggerState);
  const site = debuggerState.focus?.site || null;
  const countLabel = `${executions.length} execution${executions.length === 1 ? "" : "s"}`;
  const choices = executions
    .map((choice) => {
      const summary = debugExecutionChoice(choice);
      const selected = choice.eventIndex === debuggerState.focus?.eventIndex;
      if (choice.call.kind === "root") {
        if (summary.expression) {
          return `<button
            type="button"
            class="execution-choice${selected ? " selected" : ""}"
            data-execution-choice="${choice.eventIndex}"
            ${selected ? 'aria-current="true"' : ""}
            title="${escapeHtml(summary.title)}"
          >
            <code class="execution-choice-expression">${highlightedOcaml(summary.label, "expression")}</code>
            <span class="execution-choice-arrow ${summary.raised ? "raised" : ""}">${summary.raised ? "!" : "→"}</span>
            <code class="execution-choice-result ${summary.raised ? "raised" : ""}">${highlightedOcaml(summary.result || "…")}</code>
          </button>`;
        }
        return `<button
          type="button"
          class="execution-choice${selected ? " selected" : ""}"
          data-execution-choice="${choice.eventIndex}"
          ${selected ? 'aria-current="true"' : ""}
          title="${escapeHtml(summary.title)}"
        ><strong>${escapeHtml(summary.label)}</strong></button>`;
      }
      return `<button
        type="button"
        class="execution-choice${selected ? " selected" : ""}"
        data-execution-choice="${choice.eventIndex}"
        ${selected ? 'aria-current="true"' : ""}
        title="${escapeHtml(summary.title)}"
      >
        <span class="execution-choice-call">
          <strong>${escapeHtml(summary.label)}</strong><span>(</span><code>${highlightedOcaml(summary.arguments_.join(", "))}</code><span>)</span>
        </span>
        <span class="execution-choice-arrow ${summary.raised ? "raised" : ""}">${summary.raised ? "!" : "→"}</span>
        <code class="execution-choice-result ${summary.raised ? "raised" : ""}">${highlightedOcaml(summary.result || "…")}</code>
      </button>`;
    })
    .join("");
  return `<section class="debugger-panel ${debuggerState.stale || debuggerState.provisional ? "stale" : ""}">
    <div class="debugger-head">
      <div class="execution-choice-heading">
        <strong>${site ? countLabel : "Executions"}</strong>
        ${site ? `<span>line ${site.startLine}</span>` : ""}
      </div>
    </div>
    ${
      debuggerState.truncated
        ? '<p class="debugger-note">Trace capture reached its limit; later executions are not shown.</p>'
        : ""
    }
    ${
      choices
        ? `<div class="execution-choices" role="list" aria-label="Executions through the cursor">${choices}</div>`
        : `<p class="debugger-note">${site ? "No execution reached this position." : "Place the cursor in executed OCaml code."}</p>`
    }
  </section>`;
}

function highlightedOcaml(value, context = "value") {
  const source = String(value ?? "");
  const matcher =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|-?\b\d+(?:\.\d+)?\b|\b[A-Z][A-Za-z0-9_']*\b|[\[\]{}(),;:=|*+\-/<>@^]+|\b(?:true|false)\b)/g;
  let result = "";
  let offset = 0;
  for (const match of source.matchAll(matcher)) {
    result += escapeHtml(source.slice(offset, match.index));
    const token = match[0];
    let kind = "punctuation";
    if (token.startsWith('"') || token.startsWith("'")) kind = "string";
    else if (/^-?\d/.test(token)) kind = "number";
    else if (/^(?:true|false|[A-Z])/.test(token)) kind = "constructor";
    result += `<span class="ocaml-${context}-${kind}">${escapeHtml(token)}</span>`;
    offset = match.index + token.length;
  }
  return result + escapeHtml(source.slice(offset));
}

function renderInspector() {
  if (!state.document || state.view !== "document") return "";
  const diagnostics = (state.evaluation?.diagnostics || []).filter(
    (diagnostic) =>
      !diagnostic.line ||
      !state.cursorPosition ||
      diagnostic.line === state.cursorPosition.line,
  );
  const diagnosticsHtml = diagnostics.length
      ? `<section class="inspect-section"><h3>Diagnostics</h3>${diagnostics.map((diagnostic) => `<button class="diagnostic" data-diagnostic-line="${diagnostic.line || ""}">${diagnostic.line ? `Line ${diagnostic.line} · ` : ""}${escapeHtml(diagnostic.message)}</button>`).join("")}</section>`
      : "";
  if (state.debugger || state.evaluating || state.evaluation?.ok) {
    return renderDebugger();
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

function executionLayoutChanged(previous, next) {
  if (!previous || !next) return false;
  const samePosition = (left, right) =>
    left.lineStart === right.lineStart &&
    left.lineEnd === right.lineEnd &&
    left.line === right.line &&
    left.columnStart === right.columnStart &&
    left.columnEnd === right.columnEnd;
  return (
    previous.blocks.some((block, index) =>
      next.blocks[index] ? !samePosition(block, next.blocks[index]) : true,
    ) ||
    previous.inline.some((item, index) =>
      next.inline[index] ? !samePosition(item, next.inline[index]) : true,
    )
  );
}

function remapExecutionLine(line, previous, next) {
  if (!Number.isFinite(line)) return line;
  const blockIndex = previous.blocks.findIndex(
    (block) => line >= block.lineStart && line <= block.lineEnd,
  );
  if (blockIndex >= 0 && next.blocks[blockIndex]) {
    return line + next.blocks[blockIndex].lineStart - previous.blocks[blockIndex].lineStart;
  }
  const inlineIndex = previous.inline.findIndex((item) => item.line === line);
  return inlineIndex >= 0 && next.inline[inlineIndex]
    ? next.inline[inlineIndex].line
    : line;
}

function remapExecutionEvents(events, path, previous, next) {
  return (events || []).map((event) => {
    if (event.path !== path) return event;
    return {
      ...event,
      line: remapExecutionLine(event.line, previous, next),
      endLine: remapExecutionLine(event.endLine, previous, next),
    };
  });
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

function cancelPendingEvaluation() {
  if (state.evalFrame !== null) cancelAnimationFrame(state.evalFrame);
  state.evalFrame = null;
  state.pendingEvaluation = null;
  state.evalGeneration += 1;
  state.evaluationController?.abort();
  state.evaluationController = null;
  state.evaluating = false;
}

function projectDebuggerThroughEdit({
  previousSource,
  source,
  changes,
  provisional,
  invalidation,
  previousPlan,
  nextPlan,
}) {
  const debuggerState = state.debugger;
  state.debuggerPreview = null;
  if (
    !debuggerState ||
    debuggerState.status !== "ready" ||
    debuggerState.sources?.[state.path] !== previousSource ||
    !changes?.mapPos
  ) {
    return false;
  }
  const draft = {
    path: state.path,
    previousSource,
    source,
    changes,
  };
  const draftMapping = createExecutionDraftMapping(draft);
  const projectionPlan = debuggerState.draftPlan || previousPlan;
  const callEvents = projectExecutionDraftEvents(
    debuggerState.callEvents || [],
    draft,
    { invalidation, plan: projectionPlan, mapping: draftMapping },
  );
  const sources = {
    ...debuggerState.sources,
    [state.path]: source,
  };
  const siteIndex = debuggerState.siteIndexes?.[state.path];
  const siteIndexes = {
    ...debuggerState.siteIndexes,
    [state.path]: siteIndex
      ? {
          ...siteIndex,
          source,
          sites: mapExecutionDraftSites(siteIndex.sites || [], draft, {
            mapping: draftMapping,
          }),
        }
      : siteIndex,
  };
  const events = executionTimelineEvents(
    callEvents,
    state.project?.documents.map((document) => document.path) || [],
  );
  let next = {
    ...debuggerState,
    source,
    sources,
    callEvents,
    events,
    model: buildDebugCallModel({ callEvents }, sources),
    siteIndexes,
    status: "ready",
    stale: false,
    provisional,
    draftPlan: nextPlan,
  };
  next = preferFocusedExecution(
    executionSessionReconcileFocus(next, debuggerState, {
      mapAuthoritativeSelection: (anchor) =>
        mapExecutionDraftEvent(anchor, draft, { mapping: draftMapping }),
    }),
  );
  state.debugger = next;
  const session = currentSession();
  if (session) session.debugger = next;
  state.sourceEditorView?.dom.classList.toggle(
    "cm-execution-lens-provisional",
    next.provisional,
  );
  applyDebuggerProjection();
  refreshExecutionTimeline();
  return true;
}

function updateSource(
  source,
  { evaluate = true, changes = null, previousSource = null } = {},
) {
  invalidateTypeLookup();
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
    ((state.evaluation && !state.evaluation.ok) || state.debugger?.provisional
      ? { blockFrom: 0, inlineFrom: 0 }
      : null);
  const layoutChanged =
    !invalidation && executionLayoutChanged(previousPlan, nextPlan);
  const debuggerPreviousSource = previousSource ?? state.document.source;
  state.document = {
    ...state.document,
    source,
    blocks: draft.blocks,
    definitions: state.document.definitions.filter((definition) =>
      draft.preservedIds.has(definition.blockId),
    ),
    issues: [],
  };
  projectDebuggerThroughEdit({
    previousSource: debuggerPreviousSource,
    source,
    changes,
    provisional: Boolean(effectiveInvalidation),
    invalidation: effectiveInvalidation,
    previousPlan,
    nextPlan,
  });
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
    storeRecoveryDraft(session, source);
    scheduleAutosave(session);
  }
  state.evaluationInvalidation = effectiveInvalidation;
  if (effectiveInvalidation) {
    applyDebuggerProjection();
  } else {
    cancelPendingEvaluation();
    if (layoutChanged && state.evaluation?.traces) {
      state.evaluation = {
        ...state.evaluation,
        traces: remapExecutionEvents(
          state.evaluation.traces,
          state.path,
          previousPlan,
          nextPlan,
        ),
      };
    }
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
  if (evaluate && effectiveInvalidation) {
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

function scheduleTypeLookup(
  editor,
  position,
  { preserveTraceFocus = false } = {},
) {
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
  if (state.debugger && preserveTraceFocus) {
    refreshInspector();
    return;
  }
  if (state.debugger?.stale) {
    refreshInspector();
    return;
  }
  if (!block) {
    state.typePending = null;
    if (state.debugger) selectTraceSite(null, null);
    else refreshInspector();
    return;
  }

  if (state.debugger) {
    const siteIndex = currentExecutionSiteIndex();
    if (siteIndex?.status !== "ready") {
      applyDebuggerProjection();
      refreshInspector();
      return;
    }
    const probe = executionCursorProbe(line.text, cursor.column);
    const staticRange = executionSiteAt(
      currentExecutionSites(),
      { path: state.path, line: cursor.line, column: probe.column },
      {
        purpose: probe.purpose,
        events: state.debugger.events,
        line: line.text,
      },
    );
    selectTraceSite(state.cursorPosition, staticRange);
    state.typePending = null;
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

function scheduleEvaluation(
  source,
  {
    immediate = false,
    plan = buildExecutionPlan(source, state.document.blocks),
    retryCount = 0,
  } = {},
) {
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
  };
  state.pendingEvaluation = request;
  state.evaluating = true;
  updateStatusOnly();
  const startEvaluation = async () => {
    if (state.pendingEvaluation !== request) return;
    request.started = true;
    const controller = new AbortController();
    state.evaluationController = controller;
    try {
      const payload = await api("/api/evaluate", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          path: request.path,
          source: request.source,
          baseProjectVersion: request.baseProjectVersion,
        }),
      });
      if (
        state.pendingEvaluation !== request ||
        request.generation !== state.evalGeneration ||
        request.path !== state.path ||
        request.source !== state.document.source ||
        request.baseProjectVersion !== state.projectVersion
      ) {
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
          scheduleEvaluation(state.document.source, {
            immediate: true,
            plan: request.plan,
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
        state.evaluationPlan = request.plan;
        state.evaluationInvalidation = null;
      } else {
        state.evaluationInvalidation = previousInvalidation || {
          blockFrom: 0,
          inlineFrom: 0,
        };
      }
      state.pendingEvaluation = null;
      state.evaluating = false;
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
      if (
        evaluationSucceeded &&
        (!state.debugger ||
          state.debugger.provisional ||
          state.debugger.sources?.[state.path] !== state.document.source)
      ) {
        void startDebugger({ background: true });
      }
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
            scheduleEvaluation(state.document.source, {
              immediate: true,
              plan: request.plan,
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
}

function scheduleAutosave(session, { immediate = false } = {}) {
  if (state.refactorInFlight) {
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
  clearTimeout(session.autosaveTimer);
  session.autosaveTimer = null;
  if (session.autosaveInFlight) {
    session.autosaveQueued = true;
    return false;
  }
  const source =
    session === currentSession()
      ? state.document.source
      : session.editorState?.doc.toString() || session.document.source;
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
          module: session.module,
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
        : session.editorState?.doc.toString() || session.document.source;
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
        : session.editorState?.doc.toString() || session.document.source;
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
      onDefinitionRequest: (position, mode) =>
        isCurrentDocument()
          ? requestDefinition(state.sourceEditorView, position, mode)
          : false,
      onDebugNavigate: (...args) => {
        return isCurrentDocument() ? navigateDebugCall(...args) : false;
      },
      onDebugValueRequest: (position) =>
        isCurrentDocument()
          ? debugValueAtEditorPosition(position)
          : null,
      onDebugPreviewChange: (previewSession) => {
        if (isCurrentDocument()) setDebuggerPreview(previewSession);
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
        if (state.suppressNextCompletionLookup) {
          state.suppressNextCompletionLookup = false;
        } else if (input || (docChanged && state.completion)) {
          scheduleCompletion(state.sourceEditorView, position);
        } else if (state.completion) {
          invalidateCompletion();
          refreshInspector();
        }
        const preserveTraceFocus = state.preserveTraceFocusForSelection;
        state.preserveTraceFocusForSelection = false;
        scheduleTypeLookup(state.sourceEditorView, position, {
          preserveTraceFocus,
        });
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
    const selectedCall = currentDebugCall();
    setMarkdownEditorDebugProjection(
      state.sourceEditorView,
      state.debugger
        ? focusedProjectionForDebugCall(selectedCall)
        : null,
    );
    state.sourceEditorView.dom.classList.toggle(
      "cm-execution-lens",
      Boolean(state.debugger),
    );
    state.sourceEditorView.dom.classList.toggle(
      "cm-execution-lens-stale",
      Boolean(state.debugger?.stale),
    );
    state.sourceEditorView.dom.classList.toggle(
      "cm-execution-lens-provisional",
      Boolean(state.debugger?.provisional),
    );
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

async function createDocument() {
  const modulePath = window.prompt("New module", "NewPage");
  if (!modulePath) return;
  try {
    const payload = await withProjectMutation(async () => {
      const result = await api("/api/page", {
        method: "POST",
        body: JSON.stringify({
          module: modulePath,
          baseProjectVersion: state.projectVersion,
        }),
      });
      installAuthoritativeProject(result.project, { forceOutline: true });
      return result;
    });
    await loadDocument(modulePath, { force: true });
  } catch (error) {
    state.workspaceError = error.message;
    updateStatusOnly();
  }
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

async function showDebugCall(
  callId,
  { scroll = false } = {},
) {
  const debuggerState = state.debugger;
  if (debuggerState?.status !== "ready" || debuggerState.stale) return;
  const call =
    debuggerState.model.calls.get(callId) ||
    debuggerState.model.roots.get(callId);
  if (!call) return;
  const next = executionSessionSelectCall(debuggerState, callId);
  installTraceFocus(next);
  state.sourceEditorView?.dom.classList.add("cm-execution-lens");
  const inspector = document.querySelector(".inspector");
  if (inspector) inspector.scrollTop = 0;
  if (scroll && call.kind !== "root") {
    await revealExecutionEvent(executionSessionEvent(state.debugger), {
      allowDocumentChange: true,
      history: "push",
      animate: true,
      moveCursor: true,
      focusGeneration: state.traceFocusGeneration,
    });
  }
}

function installDebuggerPayload(payload, snapshot) {
  if (
    executionSnapshotKey(snapshot) !==
    executionSnapshotKey(debuggerSnapshot())
  ) {
    return false;
  }
  const pending = executionSessionMatches(state.debugger, snapshot)
    ? state.debugger
    : pendingExecutionSession(snapshot);
  const sources = { [snapshot.path]: snapshot.source };
  const model = buildDebugCallModel(payload.debugger, sources);
  const events = executionTimelineEvents(
    payload.debugger.callEvents || [],
    state.project?.documents.map((document) => document.path) || [],
  );
  state.debugger = preferFocusedExecution(
    readyExecutionSession(pending, {
      payload: payload.debugger,
      model,
      events,
    }),
  );
  state.debuggerPreview = null;
  const cachedSites = state.executionSitesCache.get(
    executionSnapshotKey(snapshot),
  )?.sites;
  state.debugger.siteIndexes = {
    ...state.debugger.siteIndexes,
    [snapshot.path]: cachedSites
      ? { status: "ready", source: snapshot.source, sites: cachedSites }
      : { status: "loading", source: snapshot.source, sites: [] },
  };
  state.sourceEditorView?.dom.classList.remove(
    "cm-execution-lens-stale",
  );
  state.sourceEditorView?.dom.classList.remove(
    "cm-execution-lens-provisional",
  );
  applyDebuggerProjection();
  const session = currentSession();
  if (session) session.debugger = state.debugger;
  refreshExecutionTimeline();
  if (state.sourceEditorView) {
    scheduleTypeLookup(
      state.sourceEditorView,
      state.sourceEditorView.state.selection.main.head,
    );
  } else {
    applyDebuggerProjection();
  }
  return true;
}

async function loadExecutionSites(
  snapshot = debuggerSnapshot(),
  { attempt = 0 } = {},
) {
  if (!snapshot) return [];
  const key = executionSnapshotKey(snapshot);
  const cached = state.executionSitesCache.get(key);
  if (cached?.sites) {
    if (debuggerOwnsSnapshot(state.debugger, snapshot)) {
      state.debugger = {
        ...state.debugger,
        siteIndexes: {
          ...state.debugger.siteIndexes,
          [snapshot.path]: {
            status: "ready",
            source: snapshot.source,
            sites: cached.sites,
          },
        },
      };
    }
    return cached.sites;
  }
  if (cached?.promise) return cached.promise;

  if (debuggerOwnsSnapshot(state.debugger, snapshot)) {
    state.debugger = {
      ...state.debugger,
      siteIndexes: {
        ...state.debugger.siteIndexes,
        [snapshot.path]: {
          status: "loading",
          source: snapshot.source,
          sites: [],
        },
      },
    };
    if (snapshot.path === state.path) {
      refreshInspector();
    }
  }
  const promise = api("/api/execution-sites", {
    method: "POST",
    body: JSON.stringify({
      path: snapshot.path,
      source: snapshot.source,
      baseProjectVersion: snapshot.projectVersion,
    }),
  })
    .then((payload) => {
      const sites = payload.sites || [];
      state.executionSitesCache.set(key, { sites });
      while (state.executionSitesCache.size > 8) {
        state.executionSitesCache.delete(
          state.executionSitesCache.keys().next().value,
        );
      }
      if (debuggerOwnsSnapshot(state.debugger, snapshot)) {
        state.debugger = {
          ...state.debugger,
          siteIndexes: {
            ...state.debugger.siteIndexes,
            [snapshot.path]: {
              status: "ready",
              source: snapshot.source,
              sites,
            },
          },
        };
        const session = currentSession();
        if (session) session.debugger = state.debugger;
        if (
          snapshot.path === state.path &&
          state.sourceEditorView
        ) {
          scheduleTypeLookup(
            state.sourceEditorView,
            state.sourceEditorView.state.selection.main.head,
          );
        }
      }
      return sites;
    })
    .catch((error) => {
      state.executionSitesCache.delete(key);
      if (attempt < 2 && debuggerOwnsSnapshot(state.debugger, snapshot)) {
        state.debugger = {
          ...state.debugger,
          siteIndexes: {
            ...state.debugger.siteIndexes,
            [snapshot.path]: {
              status: "loading",
              source: snapshot.source,
              sites: [],
            },
          },
        };
        window.setTimeout(() => {
          if (debuggerOwnsSnapshot(state.debugger, snapshot)) {
            void loadExecutionSites(snapshot, { attempt: attempt + 1 });
          }
        }, 40 * (attempt + 1));
        return [];
      }
      if (debuggerOwnsSnapshot(state.debugger, snapshot)) {
        state.debugger = {
          ...state.debugger,
          siteIndexes: {
            ...state.debugger.siteIndexes,
            [snapshot.path]: {
              status: "error",
              source: snapshot.source,
              sites: [],
              error: error.message,
            },
          },
        };
        if (snapshot.path === state.path) {
          refreshInspector();
        }
      }
      return [];
    });
  state.executionSitesCache.set(key, { promise });
  return promise;
}

async function startDebugger({
  background = false,
  snapshot = debuggerSnapshot(),
} = {}) {
  if (!state.document || !snapshot) return;
  if (
    debuggerMatchesSnapshot(state.debugger, snapshot) &&
    state.debugger.status === "ready"
  ) {
    applyDebuggerProjection();
    const siteIndex = state.debugger.siteIndexes?.[snapshot.path];
    if (!siteIndex || siteIndex.status === "error") {
      void loadExecutionSites(snapshot);
    }
    return;
  }
  if (!state.evaluation?.ok || state.evaluationInvalidation) {
    if (!background && state.evaluationInvalidation) {
      toast("Execution is updating for the current OCaml source.");
    }
    return;
  }
  state.debugger = pendingExecutionSession(snapshot, {
    previous: state.debugger,
  });
  if (!background) refreshInspector();
  installDebuggerPayload(
    {
      debugger: {
        callEvents: state.evaluation.traces || [],
        truncated: Boolean(state.evaluation.traceTruncated),
        durationMs: state.evaluation.durationMs,
        evaluationId: state.evaluation.evaluationId,
      },
    },
    snapshot,
  );
  void loadExecutionSites(snapshot);
  refreshInspector({ revealExecutionChoice: true });
}

function bindInspectorEvents() {
  const inspector = document.querySelector(".inspector");
  inspector?.querySelectorAll("[data-debug-start]").forEach((button) => {
    button.addEventListener("click", () => void startDebugger());
  });
  inspector
    ?.querySelector("[data-debug-sites-retry]")
    ?.addEventListener("click", () =>
      void loadExecutionSites(debuggerSnapshot()),
    );
  inspector?.querySelectorAll("[data-debug-call]").forEach((button) => {
    button.addEventListener("click", () =>
      void showDebugCall(button.dataset.debugCall, { scroll: true }),
    );
  });
  inspector?.querySelectorAll("[data-execution-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const eventIndex = Number(button.dataset.executionChoice);
      if (!Number.isFinite(eventIndex)) return;
      selectTraceEvent(eventIndex, { revealSource: false });
      document
        .querySelector(`[data-execution-choice="${eventIndex}"]`)
        ?.focus({ preventScroll: true });
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
    : { minimum: 220, maximum: Math.max(220, Math.min(520, viewport - other - 410)) };
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
      setPaneWidth(pane, pane === "sidebar" ? 160 : 340, {
        persist: true,
      });
    });
    separator.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
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
  if (window.matchMedia("(max-width: 1000px)").matches) return;
  setPaneWidth("sidebar", state.paneWidths.sidebar);
  setPaneWidth("inspector", state.paneWidths.inspector);
  setPaneWidth("sidebar", state.paneWidths.sidebar);
}

function bindExecutionTimelineEvents() {
  const scrubber = document.querySelector("[data-execution-scrubber]");
  if (
    !scrubber ||
    scrubber.disabled ||
    scrubber.dataset.bound === "true"
  ) return;
  clearExecutionTimelineInteraction();
  scrubber.dataset.bound = "true";
  const main = document.querySelector(".main");
  const timeline = scrubber.closest("[data-execution-timeline]");
  let pointerId = null;

  const follow = (allowDocumentChange = false) => {
    selectTraceEvent(scrubber.value, {
      revealSource: true,
      allowDocumentChange,
    });
  };
  const seekToPointer = (event) => {
    if (pointerId !== null && event.pointerId !== pointerId) return;
    const bounds = scrubber.getBoundingClientRect();
    const ratio = Math.min(
      Math.max((event.clientX - bounds.left) / bounds.width, 0),
      1,
    );
    scrubber.value = String(
      Math.round(ratio * Number(scrubber.max || 0)),
    );
    follow(false);
  };
  const move = (event) => {
    if (pointerId === null) return;
    seekToPointer(event);
  };
  const cleanup = () => {
    pointerId = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    state.executionTimelineScrubbing = false;
    main?.classList.remove("timeline-following");
    timeline?.classList.remove("scrubbing");
    state.sourceEditorView?.dom.classList.remove(
      "cm-timeline-scrubbing",
    );
  };
  const finish = (event) => {
    if (
      pointerId !== null &&
      Number.isFinite(event?.pointerId) &&
      event.pointerId !== pointerId
    ) {
      return;
    }
    cleanup();
    if (state.executionTimelineCleanup === cleanup) {
      state.executionTimelineCleanup = null;
    }
    follow(true);
  };
  state.executionTimelineCleanup = cleanup;

  scrubber.addEventListener("pointerdown", (event) => {
    if (pointerId !== null) return;
    pointerId = event.pointerId;
    state.executionTimelineScrubbing = true;
    main?.classList.add("timeline-following");
    timeline?.classList.add("scrubbing");
    state.sourceEditorView?.dom.classList.add("cm-timeline-scrubbing");
    scrubber.focus({ preventScroll: true });
    seekToPointer(event);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    event.preventDefault();
  });
  scrubber.addEventListener("pointercancel", finish);
  scrubber.addEventListener("input", () => follow(false));
  scrubber.addEventListener("change", () => {
    if (!state.executionTimelineScrubbing) follow(true);
  });
  scrubber.addEventListener("keydown", (event) => {
    const current = Number(scrubber.value);
    const maximum = Number(scrubber.max);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? maximum
          : event.key === "PageUp"
            ? current - 10
            : event.key === "PageDown"
              ? current + 10
              : event.key === "ArrowLeft" || event.key === "ArrowDown"
                ? current - 1
                : event.key === "ArrowRight" || event.key === "ArrowUp"
                  ? current + 1
                  : null;
    if (next === null) return;
    event.preventDefault();
    selectTraceEvent(next, {
      revealSource: true,
      allowDocumentChange: true,
    });
  });
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
    button.textContent = mode === "source" ? "Document" : "Source";
    button.classList.toggle("active", mode === "source");
    button.setAttribute("aria-pressed", String(mode === "source"));
  }
}

function bindEvents() {
  mountOutlineEditor();
  bindPaneResizers();
  bindExecutionTimelineEvents();
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
      setSourceMode(state.sourceMode === "source" ? "literate" : "source"),
    );
  document.querySelector("#new-document")?.addEventListener("click", createDocument);
  document.querySelector("#files-toggle")?.addEventListener("click", () => {
    const workspace = document.querySelector(".workspace");
    workspace?.classList.toggle("show-files");
  });
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
      if (event.key === "Enter") open();
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
          .querySelector('[data-execution-choice][aria-current="true"]')
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      return;
    }
    const scrollTop = inspector.scrollTop;
    inspector.innerHTML = html;
    inspector.dataset.rendered = "true";
    state.inspectorHtml = html;
    inspector.scrollTop = scrollTop;
    if (revealExecutionChoice) {
      inspector
        .querySelector('[data-execution-choice][aria-current="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  renderCompletionPopup();
  bindInspectorEvents();
}

initialize();

window.addEventListener("resize", scheduleCompletionPopupPosition);
window.addEventListener("resize", clampPaneWidths);
document.addEventListener("scroll", scheduleCompletionPopupPosition, true);

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
