import {
  mountMarkdownEditor,
  setMarkdownEditorEvaluation,
  setMarkdownEditorResultInvalidation,
} from "./editor.bundle.js?v=20260727ab";

const app = document.querySelector("#app");

const state = {
  project: null,
  projectVersion: null,
  sessionToken: null,
  path: null,
  document: null,
  savedVersion: null,
  savedSource: null,
  evaluation: null,
  evaluationPlan: null,
  evaluationInvalidation: null,
  traceContext: null,
  changes: [],
  view: "document",
  selected: null,
  selectedDefinitionName: null,
  dirty: false,
  evaluating: false,
  saving: false,
  evalGeneration: 0,
  loadGeneration: 0,
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
};

const escapeHtml = (value = "") =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

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
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
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
    const [project, changes] = await Promise.all([
      api("/api/project"),
      api("/api/changes"),
    ]);
    state.project = project;
    state.projectVersion = project.version;
    state.changes = changes;
    state.path = project.documents[0]?.path || null;
    if (state.path) await loadDocument(state.path, { force: true });
    else render();
  } catch (error) {
    app.innerHTML = `<div class="empty-state"><h2>Could not open the project</h2><p>${escapeHtml(error.message)}</p></div>`;
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
  path,
  { force = false, preserveTrace = false } = {},
) {
  if (state.saving) {
    toast("Wait for the current save to finish before navigating.");
    return false;
  }
  if (!force && path === state.path) return true;
  if (
    !force &&
    state.dirty &&
    !window.confirm("Discard the unsaved changes in this document?")
  ) {
    return false;
  }
  invalidateEvaluation();
  const generation = state.loadGeneration;
  const controller = new AbortController();
  state.requestController = controller;
  try {
    const payload = await api(`/api/document?path=${encodeURIComponent(path)}`, {
      signal: controller.signal,
    });
    if (generation !== state.loadGeneration) return false;
    state.path = path;
    state.document = payload.document;
    state.project = payload.project;
    state.savedVersion = payload.document.version;
    state.savedSource = payload.document.source;
    state.projectVersion = payload.projectVersion;
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
    state.dirty = false;
    render();
    scheduleEvaluation(payload.document.source, { immediate: true });
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    toast(error.message);
    return false;
  }
}

function currentProjectDocument() {
  return state.project?.documents.find((document) => document.path === state.path);
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
  const status = evaluationStatus();

  app.innerHTML = `
    <div class="workspace ${state.view === "document" ? "document-context" : ""}">
      <header class="topbar">
        <div class="brand"><span class="brand-mark">D</span><span>Doclang</span></div>
        <div></div>
        <div class="top-actions">
          <button class="button pane-toggle files-toggle" id="files-toggle" aria-label="Show project files">Files</button>
          ${
            state.view === "document"
              ? `<button class="button secondary-action" data-view="changes">History</button>
                 <button class="button" id="artifact-button" ${!state.document ? "disabled" : ""}>Build</button>`
              : '<button class="button secondary-action" data-view="document">Document</button>'
          }
          <button class="button primary" id="save-button" ${!state.dirty ? "disabled" : ""}>Save</button>
        </div>
      </header>
      <div class="body-grid">
        <aside class="sidebar">${renderSidebar()}</aside>
        <main class="main" id="main-pane">${renderMain()}</main>
        <aside class="inspector">${renderInspector()}</aside>
      </div>
      <footer class="statusbar" aria-live="polite">
        <div class="status-left">
          <span class="${status.className}">${escapeHtml(status.label)}</span>
          ${state.dirty ? '<span class="dirty">Unsaved change</span>' : ""}
        </div>
      </footer>
    </div>
  `;
  bindEvents();
}

function renderSidebar() {
  if (!state.project?.documents.length) {
    return `<div class="pane-heading"><p class="pane-label">Documents</p><div><button class="mini-button" data-view="project">Overview</button><button class="mini-button" id="new-document">New</button></div></div><div class="empty-state">Create a <code>.live.md</code> file to begin.</div>`;
  }
  const titleCounts = state.project.documents.reduce((counts, document) => {
    counts.set(document.title, (counts.get(document.title) || 0) + 1);
    return counts;
  }, new Map());
  return `
    <div class="pane-heading"><p class="pane-label">Documents</p><div><button class="mini-button" data-view="project">Overview</button><button class="mini-button" id="new-document">New</button></div></div>
    ${state.project.documents
      .map(
        (document) => `
          <div>
            <button class="file-button ${document.path === state.path ? "active" : ""}" data-path="${escapeHtml(document.path)}">
              <span>
                <span class="file-title">${escapeHtml(document.title)}</span>
                ${titleCounts.get(document.title) > 1 ? `<span class="file-path">${escapeHtml(document.path)}</span>` : ""}
              </span>
            </button>
            ${
              document.path === state.path && document.outline?.length
                ? `<details class="outline-details"><summary>Symbols</summary><div class="outline">${document.outline
                    .map(
                      (entity) =>
                        `<button data-definition="${escapeHtml(entity.name)}">${escapeHtml(entity.name)}</button>`,
                    )
                    .join("")}</div></details>`
                : ""
            }
          </div>`,
      )
      .join("")}
  `;
}

function renderMain() {
  if (!state.document && state.view !== "project" && state.view !== "changes") {
    return `<div class="empty-state"><h2>The project has no live documents yet.</h2><p>Create a file ending in <code>.live.md</code>.</p></div>`;
  }
  if (state.view === "changes") return renderChanges();
  if (state.view === "project") return renderProject();
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
                ${
                  document.imports?.length
                    ? `<div class="project-imports"><span>imports</span>${document.imports.map((path) => `<code>${escapeHtml(path)}</code>`).join("")}</div>`
                    : ""
                }
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

function chips(values) {
  return values?.length
    ? values.map((value) => `<span class="dependency">${escapeHtml(value)}</span>`).join("")
    : '<span class="entity-kind">None</span>';
}

function renderChanges() {
  return `
    <section class="changes-view">
      <div class="page-heading">
        <h1>Change sets</h1>
        <p>Direct source edits and inferred downstream impact stay separate.</p>
      </div>
      ${
        state.changes.length
          ? state.changes
              .map(
                (change) => `
                  <article class="change-card">
                    <div class="change-head">
                      <span class="change-path">${escapeHtml(change.path)}</span>
                      <span class="change-time">${escapeHtml(change.principal)} · ${escapeHtml(change.timestamp)}</span>
                    </div>
                    <div class="change-columns">
                      <div class="change-column"><strong>Direct edits</strong>${chips(change.directEntities)}</div>
                      <div class="change-column"><strong>Inferred impact</strong>${chips([...(change.affectedEntities || []), ...(change.affectedDocuments || [])])}</div>
                    </div>
                    ${
                      change.changedBlocks?.length
                        ? `<div class="change-blocks">${change.changedBlocks
                            .map(
                              (block) =>
                                `<span class="change-block ${escapeHtml(block.change)}">${escapeHtml(block.kind)} · ${escapeHtml(block.id)}</span>`,
                            )
                            .join("")}</div>`
                        : ""
                    }
                    ${
                      change.sourceDiff
                        ? `<details class="source-diff">
                            <summary>Exact source changes</summary>
                            <div class="diff-lines">${change.sourceDiff
                              .map(
                                (line) =>
                                  `<div class="diff-line ${line.kind}"><span class="diff-number">${line.beforeLine ?? ""}</span><span class="diff-number">${line.afterLine ?? ""}</span><span class="diff-marker">${line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span><code>${escapeHtml(line.text)}</code></div>`,
                              )
                              .join("")}</div>
                          </details>`
                        : ""
                    }
                  </article>`,
              )
              .join("")
          : '<div class="empty-state"><h2>No saved changes yet</h2><p>Your first edit will appear here as a versioned change set.</p></div>'
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
  if (evaluate && invalidation) {
    scheduleEvaluation(source, { plan: nextPlan });
  }
}

async function startTypeLookup() {
  if (state.typeController || !state.typePending) return;
  const request = state.typePending;
  state.typePending = null;
  const controller = new AbortController();
  state.typeController = controller;
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
    const cursor = state.cursorPosition;
    if (
      request.generation !== state.typeGeneration ||
      state.view !== "document" ||
      request.path !== state.path ||
      request.source !== state.document?.source ||
      request.projectVersion !== state.projectVersion ||
      cursor?.line !== request.line ||
      cursor?.column !== request.column
    ) {
      return;
    }
    state.typeInfo = payload.info;
    refreshInspector();
  } catch (error) {
    if (
      error.name !== "AbortError" &&
      request.generation === state.typeGeneration
    ) {
      state.typeInfo = null;
      refreshInspector();
    }
  } finally {
    if (state.typeController === controller) state.typeController = null;
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

async function requestCompletionItems(editor, request) {
  state.completionController?.abort();
  const controller = new AbortController();
  const generation = ++state.completionGeneration;
  state.completionController = controller;
  state.completionRequestKey = request.key;
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
  const status = document.querySelector(".status-left span:first-child");
  if (status) {
    const next = evaluationStatus();
    status.textContent = next.label;
    status.classList.remove("status-ok", "status-error");
    if (next.className) status.classList.add(next.className);
  }
  const saveButton = document.querySelector("#save-button");
  if (saveButton) saveButton.disabled = !state.dirty || state.saving;
}

async function save() {
  if (!state.dirty) return true;
  if (state.saving) return false;
  const path = state.path;
  const source = state.document.source;
  const baseVersion = state.savedVersion;
  const baseProjectVersion = state.projectVersion;
  state.saving = true;
  updateStatusOnly();
  invalidateEvaluation();
  try {
    const payload = await api("/api/document", {
      method: "PUT",
      body: JSON.stringify({
        path,
        source,
        baseVersion,
        baseProjectVersion,
      }),
    });
    state.changes.unshift(payload.change);
    state.project = payload.project;
    state.projectVersion = payload.project.version;
    const sameDocument = state.path === path;
    const sameDraft = sameDocument && state.document.source === source;
    if (sameDraft) {
      state.document = payload.document;
      state.savedVersion = payload.document.version;
      state.savedSource = payload.document.source;
      state.evaluation = payload.evaluation;
      state.evaluationPlan = buildExecutionPlan(
        payload.document.source,
        payload.document.blocks,
      );
      state.evaluationInvalidation = null;
      state.dirty = false;
      toast("Saved as a versioned change set.");
    } else if (sameDocument) {
      state.savedVersion = payload.document.version;
      state.savedSource = source;
      state.dirty = state.document.source !== state.savedSource;
      scheduleEvaluation(state.document.source, { immediate: true });
      toast("Saved the earlier revision; newer edits remain unsaved.");
    } else {
      toast(`Saved ${path}; the current document was left unchanged.`);
    }
    render();
    return sameDraft;
  } catch (error) {
    toast(error.message);
    return false;
  } finally {
    state.saving = false;
    updateStatusOnly();
  }
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
    state.project = await api("/api/project");
    state.projectVersion = state.project.version;
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
    state.sourceEditorView = mountMarkdownEditor(documentParent, {
      doc: state.document.source,
      onSave: save,
      onCompletionKey: handleCompletionKey,
      onChange: (source) => {
        if (!documentParent.isConnected) return;
        updateSource(source);
      },
      onSelectionChange: (position) => {
        if (!documentParent.isConnected) return;
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
          !documentParent.isConnected ||
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
  if (
    state.dirty &&
    !window.confirm("Discard the current unsaved changes and create a document?")
  ) {
    return;
  }
  const requested = window.prompt("New document path", "new.live.md");
  if (!requested) return;
  const path = requested.endsWith(".live.md") ? requested : `${requested}.live.md`;
  const title =
    path
      .split("/")
      .at(-1)
      .replace(/\.live\.md$/, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Untitled";
  const source = `# ${title}\n\nStart writing here.\n\n    let () = Doc.text ~id:"main-view" "Hello from OCaml"\n`;
  try {
    const payload = await api("/api/document", {
      method: "POST",
      body: JSON.stringify({
        path,
        source,
        baseProjectVersion: state.projectVersion,
      }),
    });
    state.project = payload.project;
    state.projectVersion = payload.project.version;
    state.changes.unshift(payload.change);
    await loadDocument(path, { force: true });
    toast("Created a new live document.");
  } catch (error) {
    toast(error.message);
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
    if (await loadDocument(trace.path, { preserveTrace: true })) {
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
      } else if (await loadDocument(path)) {
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
      if (await loadDocument(path)) {
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

window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});
