import {
  mountMarkdownEditor,
  mountModuleOutlineEditor,
  updateModuleOutlineEditor,
  setMarkdownEditorEvaluation,
  setMarkdownEditorResultInvalidation,
  replaceEditorStateDocument,
} from "./editor.bundle.js?v=20260729b";

const app = document.querySelector("#app");

const state = {
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
  traceContext: null,
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
  showBuild: false,
  typeInfo: null,
  cursorPosition: null,
  completion: null,
  completionCache: new Map(),
  completionGeneration: 0,
  completionController: null,
  completionRequestKey: null,
  suppressNextCompletionLookup: false,
  selectedTraceId: null,
  typeGeneration: 0,
  typeTimer: null,
  typeController: null,
  typePending: null,
  suppressNextSelectionLookup: false,
  hoveredObservationSite: null,
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
  outlineCommitTimer: null,
  outlineCommitQueued: false,
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

const recoveryKey = (modulePath) => `doclang:v2:draft:${modulePath}`;

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
      `doclang:v2:conflict:${modulePath}:${Date.now()}`;
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
      ...(state.sessionToken ? { "X-Doclang-Token": state.sessionToken } : {}),
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

async function initialize() {
  try {
    const session = await api("/api/session");
    state.sessionToken = session.token;
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

function captureCurrentSession() {
  if (!state.module || !state.document) return;
  const session = currentSession() || { module: state.module };
  session.module = state.module;
  session.path = state.path;
  session.document = state.document;
  session.savedVersion = state.savedVersion;
  session.savedSource = state.savedSource;
  session.evaluation = state.evaluation;
  session.evaluationPlan = state.evaluationPlan;
  session.evaluationInvalidation = state.evaluationInvalidation;
  session.traceContext = state.traceContext;
  session.selected = state.selected;
  session.selectedTraceId = state.selectedTraceId;
  session.editorState = state.sourceEditorView?.state || session.editorState;
  session.scrollTop =
    state.sourceEditorView?.scrollDOM.scrollTop ?? session.scrollTop ?? 0;
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
  state.traceContext = session.traceContext || null;
  state.selected = session.selected || session.document.blocks[0]?.id || null;
  state.selectedTraceId = session.selectedTraceId || null;
  state.dirty = session.document.source !== session.savedSource;
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
    preserveTrace = false,
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
    restoreSession(cached);
    state.view = "document";
    state.showBuild = false;
    if (!preserveTrace) state.traceContext = cached.traceContext || null;
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
          preserveTrace,
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
    if (!preserveTrace) state.traceContext = null;
    state.evaluating = true;
    state.selected = payload.document.blocks[0]?.id || null;
    state.selectedDefinitionName = null;
    state.selectedTraceId = null;
    state.showBuild = false;
    state.typeInfo = null;
    state.cursorPosition = null;
    state.hoveredObservationSite = null;
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
      traceContext: preserveTrace ? state.traceContext : null,
      selected: payload.document.blocks[0]?.id || null,
      selectedTraceId: null,
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
            preserveTrace,
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

function renderShell() {
  const existingSidebar = app.querySelector(".sidebar");
  app.innerHTML = `
    <div class="workspace ${state.view === "document" ? "document-context" : ""}">
      <header class="topbar">
        <div class="brand"><span class="brand-mark">D</span><span>Doclang</span></div>
        <div class="view-title">${escapeHtml(state.module || "")}</div>
        <div class="top-actions">
          <button class="button pane-toggle files-toggle" id="files-toggle" aria-label="Show project files">Files</button>
          <button class="button" id="artifact-button" ${!state.document ? "disabled" : ""}>Build</button>
        </div>
      </header>
      <div class="body-grid">
        <aside class="sidebar">${renderSidebar()}</aside>
        <main class="main" id="main-pane">${renderMain()}</main>
        <aside class="inspector">${renderInspector()}</aside>
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
  bindEvents();
}

function renderSidebar() {
  if (!state.project?.documents.length) {
    return `<div class="pane-heading"><p class="pane-label">Modules</p></div><div class="module-outline-host" data-module-outline></div>`;
  }
  return `
    <div class="pane-heading"><p class="pane-label">Modules</p></div>
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

function scheduleOutlineCommit() {
  clearTimeout(state.outlineCommitTimer);
  state.outlineCommitTimer = null;
  if (
    state.outlineDraftError ||
    state.outlineConflict ||
    state.outlineText === state.outlineCommittedText
  ) {
    return;
  }
  const cursorLine =
    state.outlineView?.state.doc.lineAt(state.outlineSelection).number || 1;
  const cursorText =
    state.outlineView?.state.doc.line(cursorLine).text || "";
  if (!cursorText.trim()) return;
  const activeRow = state.outlineDraftRows.find(
    (row) => row.sourceLine === cursorLine,
  );
  if (activeRow?.changed) {
    return;
  }
  const generation = state.outlineDraftGeneration;
  state.outlineCommitTimer = setTimeout(() => {
    if (generation === state.outlineDraftGeneration) {
      void commitOutline({ reason: "idle" });
    }
  }, 900);
}

function commitOutline(options = {}) {
  if (state.outlineCommitPromise) {
    state.outlineCommitQueued = true;
    return state.outlineCommitPromise;
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
  clearTimeout(state.outlineCommitTimer);
  state.outlineCommitTimer = null;
  if (state.outlineCommitting) {
    state.outlineCommitQueued = true;
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
  if (
    !removed.length &&
    !added.length &&
    state.outlineText !== state.outlineCommittedText
  ) {
    if (!submittedDraft.split("\n").some((line) => !line.trim())) {
      installProjectSnapshot(state.project, { forceOutline: true });
    }
    return true;
  }
  state.outlineCommitting = true;
  state.outlineSubmittedGeneration = submittedGeneration;
  state.outlineCommitQueued = false;
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
    if (openedModule) {
      const position = outlinePositionForModule(
        newerDraft !== null
          ? state.outlineDraftRows
          : state.outlineBase.committedRowsWithOrigins,
        openedModule,
      );
      if (position !== null) state.outlineSelection = position;
    }
    render();
    syncOutlineEditor({ moveSelection: Boolean(openedModule) });
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
    const queued = state.outlineCommitQueued;
    state.outlineCommitQueued = false;
    if (queued && state.outlineDraftGeneration > submittedGeneration) {
      scheduleOutlineCommit();
    }
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
  clearTimeout(state.outlineCommitTimer);
  state.outlineCommitTimer = null;
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
    onChange: (source, update) => {
      state.outlineText = source;
      state.outlineSelection = update.state.selection.main.head;
      state.workspaceError = state.outlineConflict || null;
      state.outlineDraftGeneration += 1;
      state.outlineFailedGeneration = null;
      const carriedRows = carryOutlineRowsThroughUpdate(
        state.outlineDraftRows,
        update,
      );
      try {
        const draft = preserveBlankOutlineOrigins(
          source,
          parseOutlineDraft(source, {
            previousRows: state.outlineDraftRows,
            update,
          }),
          state.outlineDraftRows,
          update,
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
      scheduleOutlineCommit();
    },
    onSelectionChange: (selection) => {
      state.outlineSelection = selection.head;
    },
    onNavigate: (selection, update, kind) => {
      if (!selection.empty || update.view.composing) return;
      const line = update.state.doc.lineAt(selection.head);
      scheduleOutlineCommit();
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
    return `<div class="empty-state"><h2>The project has no live documents yet.</h2><p>Create a file ending in <code>.live.md</code>.</p></div>`;
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
    <article class="document-shell">
      <div class="literate-document-editor" data-document-editor aria-label="Editable Markdown and OCaml document"></div>
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

function selectedBlock() {
  return state.document?.blocks.find((block) => block.id === state.selected);
}

function traceOccurrences() {
  const occurrences = new Map();
  const events = state.traceContext?.traces?.length
    ? state.traceContext.traces
    : state.evaluation?.traces || [];
  for (const event of events) {
    const occurrence = occurrences.get(event.occurrenceId) || {
      occurrenceId: event.occurrenceId,
      children: [],
      parameters: [],
    };
    if (event.phase === "enter") {
      Object.assign(occurrence, event, { enterSequence: event.sequence });
    } else if (event.phase === "parameter") {
      occurrence.parameters.push({
        name: event.label,
        type: event.type,
        value: event.detail,
        sequence: event.sequence,
      });
    } else {
      occurrence.outcome = event.phase;
      occurrence.detail = event.detail;
      occurrence.endSequence = event.sequence;
      occurrence.type = event.type || occurrence.type;
    }
    occurrences.set(event.occurrenceId, occurrence);
  }
  const roots = [];
  for (const occurrence of occurrences.values()) {
    const parent = occurrence.parentId
      ? occurrences.get(occurrence.parentId)
      : null;
    occurrence.parent = parent;
    if (parent) parent.children.push(occurrence);
    else roots.push(occurrence);
  }
  const bySequence = (left, right) =>
    (left.enterSequence ?? Number.MAX_SAFE_INTEGER) -
    (right.enterSequence ?? Number.MAX_SAFE_INTEGER);
  roots.sort(bySequence);
  for (const occurrence of occurrences.values()) {
    occurrence.children.sort(bySequence);
    occurrence.parameters.sort(
      (left, right) => (left.sequence ?? 0) - (right.sequence ?? 0),
    );
  }
  return { roots, occurrences };
}

function sourceTextForTrace(trace) {
  if (!state.document || trace.path !== state.path) return "";
  const lines = state.document.source.split("\n");
  const start = lines[trace.line - 1] || "";
  if (trace.line === trace.endLine) {
    return start.slice(trace.column, trace.endColumn);
  }
  const middle = lines.slice(trace.line, trace.endLine - 1);
  const end = (lines[trace.endLine - 1] || "").slice(0, trace.endColumn);
  return [start.slice(trace.column), ...middle, end].join("\n");
}

function traceLabel(trace) {
  if (trace.kind !== "expression") return trace.label;
  const source = sourceTextForTrace(trace).trim();
  if (source.startsWith("@(") && source.endsWith(")")) {
    return source.slice(2, -1).trim();
  }
  return source || trace.label;
}

function flattenTraceNodes(nodes, depth = 0) {
  return nodes.flatMap((trace) => [
    { trace, depth },
    ...flattenTraceNodes(trace.children, depth + 1),
  ]);
}

function traceParameterSummary(trace) {
  if (trace.kind !== "function" || !trace.parameters?.length) return "";
  return trace.parameters
    .map((parameter) => `${parameter.name}=${parameter.value}`)
    .join(" ");
}

function renderTraceNodes(nodes) {
  return `<ol class="trace-list">${flattenTraceNodes(nodes)
    .map(({ trace, depth }) => {
      const selected = trace.occurrenceId === state.selectedTraceId;
      const outcome = trace.outcome || "running";
      const detail = trace.detail
        ? `<span class="trace-result">${escapeHtml(trace.detail)}</span>`
        : "";
      return `<li class="trace-node">
        <button class="trace-row ${selected ? "selected" : ""} ${outcome === "raise" ? "raised" : ""}" style="--trace-indent: ${Math.min(depth, 5) * 6}px" data-trace-occurrence="${escapeHtml(trace.occurrenceId)}">
          <span class="trace-kind">${trace.kind === "function" ? "ƒ" : trace.kind === "expression" ? "@" : "·"}</span>
          <span class="trace-label">${escapeHtml(traceLabel(trace))}${traceParameterSummary(trace) ? `<span class="trace-arguments"> ${escapeHtml(traceParameterSummary(trace))}</span>` : ""}</span>
          ${detail}
        </button>
      </li>`;
    })
    .join("")}</ol>`;
}

function enclosingFunctionCall(trace) {
  let current = trace;
  while (current && current.kind !== "function") current = current.parent;
  return current || null;
}

function observationsInCall(call) {
  if (!call) return [];
  const observations = [];
  const visit = (trace) => {
    if (trace.kind === "function") return;
    if (trace.kind === "expression" || trace.kind === "binding") {
      observations.push(trace);
    }
    trace.children.forEach(visit);
  };
  call.children.forEach(visit);
  return observations;
}

function renderValueRows(rows, className = "") {
  if (!rows.length) return "";
  return `<div class="trace-values ${className}">${rows
    .map(
      ({ label, value, type }) =>
        `<div class="trace-value-row">
          <span>${escapeHtml(label)}</span>
          <code title="${escapeHtml(type || "")}">${escapeHtml(value || "…")}</code>
        </div>`,
    )
    .join("")}</div>`;
}

function renderTraceFocus(traceTree, selectedTrace, typeInfo) {
  if (!traceTree.roots.length) return "";
  if (!selectedTrace && typeInfo) {
    return `<section class="trace-focus">
      <div class="trace-focus-head">
        <strong>${escapeHtml(typeInfo.expression)}</strong>
        <span>cursor</span>
      </div>
      <code class="trace-focus-type">${escapeHtml(typeInfo.type)}</code>
    </section>`;
  }
  if (!selectedTrace) {
    return `<section class="trace-focus trace-focus-empty">
      <span>Select a call or recorded value.</span>
    </section>`;
  }

  const call = enclosingFunctionCall(selectedTrace);
  const focusedCall = selectedTrace.kind === "function" ? selectedTrace : call;
  const parameters = (focusedCall?.parameters || []).map((parameter) => ({
    label: parameter.name,
    value: parameter.value,
    type: parameter.type,
  }));
  const observations =
    selectedTrace.kind === "function"
      ? observationsInCall(selectedTrace).map((observation) => ({
          label: `@ ${traceLabel(observation)}`,
          value: observation.detail,
          type: observation.type,
        }))
      : [];
  const result = selectedTrace.detail
    ? `${selectedTrace.outcome === "raise" ? "raised" : "→"} ${selectedTrace.detail}`
    : "";
  const context =
    selectedTrace.kind !== "function" && call
      ? `in ${traceLabel(call)}${traceParameterSummary(call) ? ` · ${traceParameterSummary(call)}` : ""}`
      : selectedTrace.kind;

  return `<section class="trace-focus">
    <div class="trace-focus-head">
      <strong>${escapeHtml(traceLabel(selectedTrace))}</strong>
      <span>${escapeHtml(context)}</span>
    </div>
    <div class="trace-focus-summary">
      ${selectedTrace.type ? `<code class="trace-focus-type">${escapeHtml(selectedTrace.type)}</code>` : "<span></span>"}
      ${result ? `<code class="trace-focus-result ${selectedTrace.outcome === "raise" ? "raised" : ""}">${escapeHtml(result)}</code>` : ""}
    </div>
    ${
      selectedTrace.kind === "function"
        ? `${renderValueRows(parameters, "trace-parameters")}${renderValueRows(observations, "trace-observations")}`
        : call
          ? renderValueRows(parameters, "trace-parameters")
          : ""
    }
  </section>`;
}

function renderCompletion() {
  const completion = state.completion;
  if (!completion) return "";
  const scope = completion.context || "Current scope";
  const rows = completion.items.length
    ? completion.items
        .map(
          (item, index) => `
            <button
              class="completion-row${index === completion.selectedIndex ? " selected" : ""}"
              data-completion-index="${index}"
              type="button"
            >
              <span class="completion-name">${escapeHtml(item.name)}</span>
              <span class="completion-kind">${escapeHtml(item.kind.toLowerCase())}</span>
              ${item.type ? `<code class="completion-type">${escapeHtml(item.type)}</code>` : ""}
            </button>`,
        )
        .join("")
    : `<p class="completion-empty">${completion.loading ? "Loading compiler completions…" : "No matching identifiers."}</p>`;
  return `<section class="completion-section" aria-label="OCaml completions">
    <div class="completion-head">
      <h3>${escapeHtml(scope)}</h3>
      ${completion.loading ? '<span class="completion-loading">updating</span>' : ""}
    </div>
    <div class="completion-list">${rows}</div>
    <p class="completion-hint">↑↓ select · Tab or Enter insert · Esc close</p>
  </section>`;
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
  if (state.completion) {
    return `${renderCompletion()}${diagnosticsHtml}`;
  }
  const typeInfo = state.typeInfo;
  const traceTree = traceOccurrences();
  const selectedTrace = traceTree.occurrences.get(state.selectedTraceId);
  return `
    ${
      typeInfo && !traceTree.roots.length
        ? `<section class="cursor-type">
            <h2 class="inspector-title"><code>${escapeHtml(typeInfo.expression)}</code></h2>
            <div class="type-card" data-source-line="${typeInfo.startLine}" data-source-column="${typeInfo.startColumn}">${escapeHtml(typeInfo.type)}</div>
          </section>`
        : ""
    }
    ${renderTraceFocus(traceTree, selectedTrace, typeInfo)}
    ${
      traceTree.roots.length
        ? `<section class="inspect-section trace-section">
            <h3>Execution</h3>
            ${renderTraceNodes(traceTree.roots)}
          </section>`
        : ""
    }
    ${diagnosticsHtml}
    ${renderDependencyContext()}
    ${
      state.showBuild
        ? `<section class="inspect-section build-section">
            <h3>Artifact</h3>
            <form class="artifact-form" id="artifact-form">
              <input name="entry" value="main" aria-label="OCaml entry value" />
              <input name="name" value="${escapeHtml(state.document.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app")}" aria-label="Artifact name" />
              <button class="button" type="submit">Compile entry</button>
            </form>
          </section>`
        : ""
    }
    ${
      !typeInfo &&
      !diagnostics.length &&
      !state.showBuild &&
      !traceTree.roots.length
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

function cancelPendingEvaluation() {
  if (state.evalFrame !== null) cancelAnimationFrame(state.evalFrame);
  state.evalFrame = null;
  state.pendingEvaluation = null;
  state.evalGeneration += 1;
  state.evaluationController?.abort();
  state.evaluationController = null;
  state.evaluating = false;
}

function updateSource(source, { evaluate = true } = {}) {
  invalidateTypeLookup();
  const draft = preserveUnchangedBlockIdentity(
    parseDraftBlocks(source),
    state.document.blocks,
  );
  const nextPlan = buildExecutionPlan(source, draft.blocks);
  const invalidation =
    state.evaluation && state.evaluationPlan
      ? executionInvalidation(state.evaluationPlan, nextPlan)
      : { blockFrom: 0, inlineFrom: 0 };
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
    storeRecoveryDraft(session, source);
    scheduleAutosave(session);
  }
  state.evaluationInvalidation = invalidation;
  if (invalidation) {
    state.traceContext = null;
    state.selectedTraceId = null;
    state.hoveredObservationSite = null;
  } else {
    cancelPendingEvaluation();
    state.evaluationPlan = nextPlan;
  }
  if (state.sourceEditorView && state.evaluation) {
    setMarkdownEditorResultInvalidation(
      state.sourceEditorView,
      invalidation,
    );
  }
  updateStatusOnly();
  refreshInspector();
  if (evaluate && invalidation) {
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
  refreshInspector();
  if (!block) {
    state.typePending = null;
    return;
  }

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
  const completion = state.completion;
  if (!completion) return false;
  if (action === "dismiss") return dismissCompletion();
  if (action === "accept") return acceptCompletion();
  if (!completion.items.length) return false;
  const delta = action === "previous" ? -1 : 1;
  completion.selectedIndex =
    (completion.selectedIndex + delta + completion.items.length) %
    completion.items.length;
  refreshInspector();
  document
    .querySelector(".completion-row.selected")
    ?.scrollIntoView({ block: "nearest" });
  return true;
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
      state.document = payload.document;
      state.evaluation = payload.evaluation;
      state.evaluationPlan = request.plan;
      state.evaluationInvalidation = null;
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

async function buildArtifact(entry, name) {
  try {
    if (state.dirty && !(await save())) return;
    const manifest = await api("/api/artifact", {
      method: "POST",
      body: JSON.stringify({
        path: state.path,
        entry,
        name,
        projectVersion: state.projectVersion,
        documentVersion: state.savedVersion,
      }),
    });
    await refreshProjectIndex();
    state.showBuild = false;
    refreshInspector();
    toast(`Built ${manifest.name} from project version ${manifest.projectVersion.slice(0, 8)}.`);
  } catch (error) {
    toast(error.message);
  }
}

function mountEmbeddedEditors() {
  const documentParent = document.querySelector("[data-document-editor]");
  if (documentParent) {
    const session = currentSession();
    state.sourceEditorView = mountMarkdownEditor(documentParent, {
      doc: state.document.source,
      editorState: session?.editorState || null,
      wikiModules:
        state.project?.pageIndex?.modules ||
        state.project?.documents.map((document) => document.module) ||
        [],
      onWikiNavigate: async (modulePath) => {
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
      onStateChange: (editorState) => {
        const active = currentSession();
        if (active) active.editorState = editorState;
      },
      onCompletionKey: handleCompletionKey,
      onChange: (source) => {
        updateSource(source);
      },
      onSelectionChange: (position) => {
        if (state.suppressNextSelectionLookup) {
          state.suppressNextSelectionLookup = false;
          return;
        }
        const line = state.sourceEditorView?.state.doc.lineAt(position).number;
        const block = state.document.blocks.find(
          (item) => line >= item.lineStart && line <= item.lineEnd,
        );
        if (block && block.id !== state.selected) {
          state.selected = block.id;
          state.selectedDefinitionName = null;
        }
        state.selectedTraceId = null;
        if (state.suppressNextCompletionLookup) {
          state.suppressNextCompletionLookup = false;
        } else {
          scheduleCompletion(state.sourceEditorView, position);
        }
        scheduleTypeLookup(state.sourceEditorView, position);
      },
      onBlur: () => {
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
    if (state.evaluationInvalidation) {
      setMarkdownEditorResultInvalidation(
        state.sourceEditorView,
        state.evaluationInvalidation,
      );
    }
    bindSourceObservationEvents(documentParent);
    return;
  }
  state.sourceEditorView = null;
}

function clearSourceTraceHover() {
  document
    .querySelectorAll(".trace-source-hover")
    .forEach((row) => row.classList.remove("trace-source-hover"));
}

function applySourceTraceHover() {
  clearSourceTraceHover();
  const site = state.hoveredObservationSite;
  if (!site) return;
  for (const trace of traceOccurrences().occurrences.values()) {
    if (
      trace.path === site.path &&
      trace.line === site.line &&
      trace.column === site.column
    ) {
      document
        .querySelector(
          `[data-trace-occurrence="${CSS.escape(trace.occurrenceId)}"]`,
        )
        ?.classList.add("trace-source-hover");
    }
  }
}

function bindSourceObservationEvents(documentParent) {
  documentParent.onpointerover = (event) => {
    const marker = event.target.closest("[data-observation-line]");
    if (!marker || !documentParent.contains(marker)) return;
    state.hoveredObservationSite = {
      path: state.path,
      line: Number(marker.dataset.observationLine),
      column: Number(marker.dataset.observationColumn),
    };
    applySourceTraceHover();
  };
  documentParent.onpointerout = (event) => {
    const marker = event.target.closest("[data-observation-line]");
    if (!marker || marker.contains(event.relatedTarget)) return;
    state.hoveredObservationSite = null;
    clearSourceTraceHover();
  };
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
  state.showBuild = false;
  render();
  const editor = state.sourceEditorView;
  if (!editor) return;
  const sourceLine = editor.state.doc.line(Math.min(line, editor.state.doc.lines));
  editor.dispatch({
    selection: { anchor: sourceLine.from, head: sourceLine.to },
  });
  editor.focus();
}

function selectSourceSpan(trace) {
  const editor = state.sourceEditorView;
  if (!editor) return;
  const startLine = editor.state.doc.line(
    Math.min(Math.max(trace.line, 1), editor.state.doc.lines),
  );
  const endLine = editor.state.doc.line(
    Math.min(Math.max(trace.endLine, 1), editor.state.doc.lines),
  );
  const anchor = startLine.from + Math.min(trace.column, startLine.length);
  let head = endLine.from + Math.min(trace.endColumn, endLine.length);
  if (
    startLine.number === endLine.number &&
    head <= anchor + 1 &&
    (trace.kind === "function" || trace.kind === "binding")
  ) {
    const markerAndName = startLine.text
      .slice(trace.column)
      .match(/^@[a-zA-Z_][a-zA-Z0-9_']*/)?.[0];
    if (markerAndName) head = anchor + markerAndName.length;
  }
  state.suppressNextSelectionLookup = true;
  editor.dispatch({
    selection: { anchor, head },
    scrollIntoView: true,
  });
  state.suppressNextSelectionLookup = false;
}

async function openTrace(trace) {
  if (!trace) return;
  invalidateTypeLookup();
  state.selectedTraceId = trace.occurrenceId;
  if (trace.path !== state.path) {
    const context = state.evaluation?.traces?.length
      ? state.evaluation
      : state.traceContext;
    const modulePath = state.project.documents.find(
      (document) => document.path === trace.path,
    )?.module;
    if (
      modulePath &&
      (await loadDocument(modulePath, { preserveTrace: true }))
    ) {
      state.traceContext = context;
      state.selectedTraceId = trace.occurrenceId;
      refreshInspector();
      selectSourceSpan(trace);
    }
    return;
  }
  refreshInspector();
  selectSourceSpan(trace);
}

function bindInspectorEvents() {
  document.querySelectorAll("[data-module-link]").forEach((button) => {
    button.addEventListener("click", () =>
      loadDocument(button.dataset.moduleLink, {
        history: "push",
        focus: "main",
      }),
    );
  });
  document.querySelectorAll("[data-completion-index]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () =>
      acceptCompletion(Number(button.dataset.completionIndex)),
    );
  });
  document.querySelectorAll("[data-diagnostic-line]").forEach((diagnostic) => {
    diagnostic.addEventListener("click", () =>
      openSourceLine(Number(diagnostic.dataset.diagnosticLine)),
    );
  });
  const traces = traceOccurrences().occurrences;
  const clearTraceHover = () => {
    document
      .querySelectorAll(".trace-descendant-hover")
      .forEach((row) => row.classList.remove("trace-descendant-hover"));
  };
  document.querySelectorAll("[data-trace-occurrence]").forEach((button) => {
    const trace = traces.get(button.dataset.traceOccurrence);
    button.addEventListener("click", () =>
      openTrace(trace),
    );
    if (trace?.kind === "function") {
      button.addEventListener("pointerenter", () => {
        clearTraceHover();
        const descendants = [...trace.children];
        while (descendants.length) {
          const descendant = descendants.shift();
          document
            .querySelector(
              `[data-trace-occurrence="${CSS.escape(descendant.occurrenceId)}"]`,
            )
            ?.classList.add("trace-descendant-hover");
          descendants.push(...descendant.children);
        }
      });
      button.addEventListener("pointerleave", clearTraceHover);
    }
  });
  applySourceTraceHover();
}

function bindEvents() {
  mountOutlineEditor();
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      state.showBuild = false;
      render();
    });
  });
  document.querySelectorAll("[data-path]").forEach((button) => {
    button.addEventListener("click", async () => {
      const path = button.dataset.path;
      if (path === state.path) {
        state.view = "document";
        state.showBuild = false;
        render();
      } else {
        const modulePath = state.project.documents.find(
          (document) => document.path === path,
        )?.module;
        if (!modulePath || !(await loadDocument(modulePath))) return;
        state.view = "document";
        state.showBuild = false;
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
  document.querySelector("#artifact-button")?.addEventListener("click", () => {
    state.showBuild = !state.showBuild;
    refreshInspector();
    if (state.showBuild) document.querySelector("#artifact-form input")?.focus();
  });
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
        state.showBuild = false;
        render();
        return;
      }
      const modulePath = state.project.documents.find(
        (document) => document.path === path,
      )?.module;
      if (modulePath && (await loadDocument(modulePath))) {
        state.view = "document";
        state.showBuild = false;
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
  bindArtifactForm();
}

function refreshInspector() {
  const inspector = document.querySelector(".inspector");
  if (inspector) {
    const scrollTop = inspector.scrollTop;
    const focusedTrace =
      document.activeElement?.dataset?.traceOccurrence || null;
    inspector.innerHTML = renderInspector();
    inspector.scrollTop = scrollTop;
    if (focusedTrace) {
      inspector
        .querySelector(`[data-trace-occurrence="${CSS.escape(focusedTrace)}"]`)
        ?.focus({ preventScroll: true });
    }
  }
  bindInspectorEvents();
  bindArtifactForm();
}

function bindArtifactForm() {
  document.querySelector("#artifact-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    buildArtifact(data.get("entry"), data.get("name"));
  });
}

initialize();

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
