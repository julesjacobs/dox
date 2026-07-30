import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import {
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkup,
  markdown,
} from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  StringStream,
  bracketMatching,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import { oCaml } from "@codemirror/legacy-modes/mode/mllike";
import {
  Annotation,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  keymap,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  indentOutlineSubtree,
  moveOutlineSibling,
  moveOutlineSubtree,
  outdentOutlineSubtree,
  outlineDepth,
  outlineSubtreeEnd,
} from "./outline-tree.mjs";

const colors = {
  ink: "#202824",
  muted: "#7b847f",
  green: "#285f4e",
  amber: "#b86a35",
  blue: "#4b6974",
  plum: "#7f596b",
};

const setEditorMode = StateEffect.define();
const setDebugPosition = StateEffect.define();
const setDebugProjection = StateEffect.define();

class DebugAnnotationsWidget extends WidgetType {
  constructor(items, indent = 0) {
    super();
    this.items = items;
    this.indent = indent;
  }

  eq(other) {
    return (
      this.indent === other.indent &&
      JSON.stringify(this.items) === JSON.stringify(other.items)
    );
  }

  toDOM() {
    const row = document.createElement("span");
    row.className = "cm-debug-annotations";
    this.items.forEach((item, index) => {
      if (index > 0) {
        const separator = document.createElement("span");
        separator.className = "cm-debug-annotation-separator";
        separator.textContent = "·";
        row.append(separator);
      }
      const value = document.createElement(
        item.kind === "call" ? "button" : "span",
      );
      value.className = `cm-debug-annotation cm-debug-annotation-${item.kind || "value"}`;
      if (item.callId) {
        value.dataset.debugCall = item.callId;
        value.type = "button";
        value.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
      }
      if (item.name) {
        const name = document.createElement("span");
        name.className = "cm-debug-annotation-name";
        name.textContent = item.name;
        const nameSeparator = document.createElement("span");
        nameSeparator.className = "cm-debug-annotation-name-separator";
        nameSeparator.textContent = ["call", "return", "raise"].includes(
          item.kind,
        )
          ? "\u00a0"
          : "\u00a0=\u00a0";
        value.append(name, nameSeparator);
      }
      const code = document.createElement("code");
      code.textContent = item.value;
      code.title = [item.type, item.fullValue]
        .filter(Boolean)
        .join("\n");
      value.append(code);
      if (item.occurrenceTotal > 1) {
        const occurrence = document.createElement("span");
        occurrence.className = "cm-debug-annotation-occurrence";
        occurrence.textContent = `${item.occurrenceIndex} of ${item.occurrenceTotal}`;
        value.append(occurrence);
      }
      if (item.kind !== "call") {
        value.tabIndex = 0;
        value.title = item.type
          ? `${item.name || "value"}: ${item.type}`
          : "Expand value";
        value.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        value.addEventListener("click", () => {
          value.classList.toggle("expanded");
        });
        value.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          value.classList.toggle("expanded");
        });
      }
      row.append(value);
    });
    return row;
  }

  ignoreEvent() {
    return false;
  }
}

function debugProjectionDecorations(state, projection) {
  if (!projection) return Decoration.none;
  const decorations = [];
  for (const number of projection.dimLines || []) {
    if (number < 1 || number > state.doc.lines) continue;
    decorations.push(
      Decoration.line({ class: "cm-debug-not-run" }).range(
        state.doc.line(number).from,
      ),
    );
  }
  for (const group of projection.annotations || []) {
    if (group.line < 1 || group.line > state.doc.lines) continue;
    decorations.push(
      Decoration.widget({
        widget: new DebugAnnotationsWidget(group.items, group.indent),
        side: 1,
      }).range(state.doc.line(group.line).to),
    );
  }
  for (const link of projection.links || []) {
    if (link.line < 1 || link.line > state.doc.lines) continue;
    const line = state.doc.line(link.line);
    const from = line.from + Math.min(Math.max(link.column, 0), line.length);
    const to =
      line.from +
      Math.min(Math.max(link.endColumn, link.column + 1), line.length);
    if (to <= from) continue;
    decorations.push(
      Decoration.mark({
        class: `cm-debug-call-link cm-debug-call-link-${link.kind}`,
        attributes: {
          "data-debug-call": link.callId,
          title:
            link.kind === "parent"
              ? "Return to the caller"
              : `Open this call to ${link.label}`,
        },
      }).range(from, to),
    );
  }
  return Decoration.set(decorations, true);
}

const debugProjectionField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setDebugProjection)) {
        value = debugProjectionDecorations(transaction.state, effect.value);
      }
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const debugPositionField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setDebugPosition)) continue;
      const position = effect.value;
      if (!position) {
        value = Decoration.none;
        continue;
      }
      const line = transaction.state.doc.line(
        Math.min(Math.max(position.line, 1), transaction.state.doc.lines),
      );
      const from =
        line.from + Math.min(Math.max(position.column || 0, 0), line.length);
      const to = Math.min(line.to, from + 1);
      const decorations = [
        Decoration.line({ class: "cm-debug-line" }).range(line.from),
      ];
      if (to > from) {
        decorations.push(
          Decoration.mark({ class: "cm-debug-position" }).range(from, to),
        );
      }
      value = Decoration.set(decorations, true);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const editorModeField = StateField.define({
  create() {
    return "literate";
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setEditorMode)) value = effect.value;
    }
    return value;
  },
  provide: (field) =>
    EditorView.editorAttributes.from(field, (mode) => ({
      class: mode === "source" ? "cm-raw-source" : "cm-literate-source",
    })),
});

const embeddedTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: colors.ink,
    fontSize: "17px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "visible",
    fontFamily: "Iowan Old Style, Charter, Palatino Linotype, Palatino, Georgia, serif",
    lineHeight: "1.64",
  },
  ".cm-content": {
    padding: "0",
    caretColor: colors.green,
  },
  ".cm-line": {
    padding: "0 10px",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: colors.green,
    borderLeftWidth: "1.5px",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgba(19, 95, 75, 0.16)",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-debug-line": {
    backgroundColor: "rgba(214, 163, 72, 0.105)",
    boxShadow: "inset 2px 0 #c08b3e",
  },
  ".cm-debug-position": {
    backgroundColor: "rgba(214, 163, 72, 0.28)",
    borderRadius: "2px",
  },
  ".cm-debug-not-run": {
    opacity: "0.28",
    filter: "grayscale(0.5)",
  },
  ".cm-debug-annotations": {
    position: "absolute",
    zIndex: "2",
    display: "inline-flex",
    alignItems: "baseline",
    gap: "5px",
    boxSizing: "border-box",
    width: "max-content",
    minWidth: "0",
    marginLeft: "1.25ch",
    padding: "0",
    overflow: "visible",
    color: "#76817b",
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace",
    fontSize: "0.77em",
    lineHeight: "1.62",
    pointerEvents: "auto",
    whiteSpace: "nowrap",
  },
  ".cm-debug-annotations:has(.cm-debug-annotation.expanded)": {
    zIndex: "5",
    overflow: "visible",
    borderRadius: "3px",
    backgroundColor: "rgba(250, 249, 245, 0.97)",
    boxShadow: "0 2px 10px rgba(32, 40, 36, 0.08)",
  },
  ".cm-debug-annotation": {
    display: "inline-flex",
    alignItems: "baseline",
    minWidth: "0",
    maxWidth: "42ch",
    border: "0",
    borderRadius: "3px",
    padding: "0",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    whiteSpace: "nowrap",
  },
  ".cm-debug-annotation-name": {
    flex: "0 0 auto",
    color: "#9a7a4d",
  },
  ".cm-debug-annotation-name-separator": {
    flex: "0 0 auto",
    whiteSpace: "pre",
  },
  ".cm-debug-annotation code": {
    display: "inline-block",
    overflow: "hidden",
    minWidth: "0",
    maxWidth: "32ch",
    color: "#53635b",
    font: "inherit",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-debug-annotation.expanded": {
    maxWidth: "none",
    whiteSpace: "normal",
  },
  ".cm-debug-annotation.expanded code": {
    overflow: "visible",
    whiteSpace: "pre-wrap",
  },
  ".cm-debug-annotation-return .cm-debug-annotation-name": {
    color: "#557263",
  },
  ".cm-debug-annotation-raise .cm-debug-annotation-name, .cm-debug-annotation-raise code": {
    color: "#9a4f45",
  },
  ".cm-debug-annotation-call": {
    cursor: "pointer",
  },
  ".cm-debug-annotation-call:hover": {
    color: colors.green,
  },
  ".cm-debug-annotation-call .cm-debug-annotation-name": {
    color: "#536e62",
  },
  ".cm-debug-annotation-occurrence": {
    flex: "0 0 auto",
    marginLeft: "6px",
    color: "#99a19d",
    fontSize: "0.82em",
  },
  ".cm-debug-annotation-separator": {
    color: "#b3b8b5",
  },
  ".cm-debug-call-link": {
    borderRadius: "3px",
    cursor: "pointer",
    textDecoration: "underline",
    textDecorationColor: "rgba(77, 111, 95, 0.34)",
    textDecorationThickness: "1px",
    textUnderlineOffset: "3px",
  },
  ".cm-debug-call-link:hover": {
    backgroundColor: "rgba(40, 95, 78, 0.1)",
    textDecorationColor: "rgba(40, 95, 78, 0.7)",
  },
  ".cm-debug-call-link-parent": {
    textDecorationColor: "rgba(182, 128, 60, 0.42)",
  },
  "&.cm-focused .cm-activeLine": {
    backgroundColor: "rgba(255, 255, 255, 0.28)",
  },
  ".cm-matchingBracket": {
    borderBottom: "1px solid rgba(19, 95, 75, 0.55)",
    backgroundColor: "rgba(19, 95, 75, 0.08)",
    color: "inherit",
  },
  ".cm-nonmatchingBracket": {
    borderBottom: "1px solid rgba(167, 67, 52, 0.7)",
    backgroundColor: "rgba(167, 67, 52, 0.08)",
    color: "#8f3f35",
  },
  "&.cm-raw-source": {
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace",
    fontSize: "13px",
    lineHeight: "1.66",
  },
  "&.cm-raw-source .cm-content": {
    padding: "20px 22px 72px",
  },
  "&.cm-raw-source .cm-block-results, &.cm-raw-source .cm-inline-result": {
    display: "none",
  },
  ".cm-md-heading": {
    position: "relative",
    fontWeight: "680",
    letterSpacing: "-0.025em",
    lineHeight: "1.15",
    paddingTop: "0.48em",
    paddingBottom: "0.18em",
  },
  ".cm-md-heading-1": {
    fontSize: "2.65em",
    letterSpacing: "-0.043em",
    lineHeight: "1.02",
    paddingTop: "0.16em",
    paddingBottom: "0.24em",
  },
  ".cm-md-heading-2": { fontSize: "1.52em" },
  ".cm-md-heading-3": { fontSize: "1.22em" },
  ".cm-md-marker": {
    position: "absolute",
    right: "calc(100% - 3px)",
    top: "50%",
    transform: "translateY(-50%)",
    color: "#aeb6b1",
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace",
    fontSize: "10px",
    fontWeight: "550",
    lineHeight: "1",
    letterSpacing: "-0.08em",
    whiteSpace: "nowrap",
    opacity: "0",
    transition: "opacity 100ms ease",
  },
  ".cm-md-marker.cm-md-marker-visible": {
    opacity: "1",
  },
  ".cm-md-heading-anchor": {
    display: "inline-block",
    width: "0",
    height: "1.375em",
    overflow: "hidden",
    fontSize: "inherit",
    lineHeight: "inherit",
    verticalAlign: "baseline",
    pointerEvents: "none",
  },
  ".cm-md-list": {
    paddingLeft: "1.25em",
    textIndent: "-1.25em",
  },
  ".cm-md-list-marker": {
    color: "#858f89",
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace",
    fontSize: "0.72em",
    fontWeight: "600",
  },
  ".cm-md-inline-shell": {
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace",
    fontSize: "0.82em",
  },
  ".cm-md-inline-code": {
    borderRadius: "4px",
    padding: "1px 4px",
    backgroundColor: "rgba(40, 95, 78, 0.07)",
    color: "#315b4e",
  },
  ".cm-md-inline-marker": {
    display: "inline",
    color: "#9ca7a1",
    opacity: "0",
    pointerEvents: "none",
    transition: "opacity 100ms ease",
  },
  ".cm-md-inline-marker.cm-md-inline-marker-visible": {
    opacity: "1",
  },
  ".cm-wiki-link": {
    borderBottom: "1px solid rgba(40, 95, 78, 0.3)",
    color: "#285f4e",
    cursor: "text",
  },
  ".cm-wiki-missing": {
    borderBottom: "1px wavy rgba(169, 68, 54, 0.7)",
    color: "#7f5148",
  },
  ".cm-wiki-marker": {
    visibility: "hidden",
    color: "#9ca7a1",
  },
  ".cm-wiki-marker.cm-wiki-marker-visible": {
    visibility: "visible",
  },
  ".cm-md-list-1": { paddingLeft: "2.4em" },
  ".cm-md-list-2": { paddingLeft: "3.6em" },
  ".cm-md-list-3": { paddingLeft: "4.8em" },
  ".cm-lintRange-error": {
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3'%3E%3Cpath d='M0 2.5 L1.5 1 L3 2.5 L4.5 1 L6 2.5' fill='none' stroke='%23b94b3c' stroke-width='1'/%3E%3C/svg%3E\")",
  },
  ".cm-lintRange-warning": {
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3'%3E%3Cpath d='M0 2.5 L1.5 1 L3 2.5 L4.5 1 L6 2.5' fill='none' stroke='%23c47b32' stroke-width='1'/%3E%3C/svg%3E\")",
  },
  ".cm-tooltip-lint": {
    maxWidth: "min(520px, 80vw)",
    border: "1px solid #dcc7c1",
    borderRadius: "8px",
    backgroundColor: "#fdfcf8",
    boxShadow: "0 12px 34px rgba(60, 50, 42, 0.11)",
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace",
    fontSize: "11px",
    lineHeight: "1.45",
  },
  ".cm-md-indented-code": {
    color: "#34443d",
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace",
    fontSize: "0.77em",
    lineHeight: "1.62",
  },
  ".cm-ocaml-keyword": { color: "#785a3a", fontWeight: "600" },
  ".cm-ocaml-definition, .cm-ocaml-module-definition": {
    color: colors.green,
    fontWeight: "620",
  },
  ".cm-ocaml-type-definition, .cm-ocaml-constructor-definition": {
    color: colors.blue,
    fontWeight: "620",
  },
  ".cm-ocaml-variable": { color: "#29362f" },
  ".cm-ocaml-parameter": { color: "#4c6b60" },
  ".cm-ocaml-property": { color: "#397063" },
  ".cm-ocaml-module, .cm-ocaml-constructor, .cm-ocaml-builtin": {
    color: colors.blue,
  },
  ".cm-ocaml-type": { color: "#536b82" },
  ".cm-ocaml-label, .cm-ocaml-variant": { color: "#745d80" },
  ".cm-ocaml-string": { color: "#9a5d36" },
  ".cm-ocaml-number, .cm-ocaml-bool": { color: colors.plum },
  ".cm-ocaml-comment": {
    color: "#87918b",
    fontStyle: "italic",
  },
  ".cm-ocaml-operator": {
    color: "#65716b",
    fontWeight: "520",
  },
  ".cm-ocaml-observation": {
    borderRadius: "2px",
    color: colors.amber,
    fontWeight: "720",
  },
  ".cm-ocaml-observation:hover": {
    backgroundColor: "rgba(198, 107, 43, 0.1)",
  },
  ".cm-literate-editor": {
    paddingBottom: "20px",
  },
  ".cm-block-results": {
    boxSizing: "border-box",
    margin: "6px 10px 14px 40px",
    color: "#53615a",
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace",
    fontSize: "11.5px",
    lineHeight: "1.48",
  },
  ".cm-result-invalidated": {
    opacity: "0.48",
    filter: "saturate(0.55)",
    transition: "opacity 120ms ease, filter 120ms ease",
  },
  ".cm-block-result-row": {
    display: "grid",
    gridTemplateColumns: "10px minmax(0, 1fr)",
    gap: "8px",
    padding: "3px 0 4px",
  },
  ".cm-block-result-mark": {
    color: "#a3aaa6",
    userSelect: "none",
  },
  ".cm-block-result-text": {
    margin: "0",
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  ".cm-block-result-error": {
    color: "#8e3f34",
  },
  ".cm-block-result-value": {
    color: "#315e51",
  },
  ".cm-block-result-type": {
    marginRight: "8px",
    color: "#7d8983",
  },
  ".cm-inline-result": {
    display: "inline",
    marginLeft: "4px",
    borderRadius: "4px",
    padding: "1px 4px 2px",
    backgroundColor: "rgba(70, 107, 120, 0.09)",
    color: "#466b78",
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace",
    fontSize: "0.82em",
    whiteSpace: "pre",
  },
  ".cm-inline-result-error": {
    backgroundColor: "rgba(167, 67, 52, 0.08)",
    color: "#9a493d",
  },
});

const highlightStyle = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: "#7c5935" },
    { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: colors.green },
    { tag: [tags.string, tags.character], color: "#9a5d36" },
    { tag: [tags.number, tags.bool], color: colors.plum },
    { tag: tags.comment, color: "#87918b", fontStyle: "italic" },
    { tag: [tags.typeName, tags.className], color: colors.blue },
    { tag: tags.link, color: colors.green, textDecoration: "underline" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "700" },
    { tag: tags.monospace, color: "#34443d" },
  ]),
);

function classifyOcamlToken(token, text, source, tokenEnd, context) {
  if (context.previous === "." && /^[a-z_]/.test(text)) return "property";

  if (token === "keyword") {
    if (text === "let" || text === "and") context.binding = "value";
    else if (text === "type") context.binding = "type";
    else if (text === "module") context.binding = "module";
    else if (text === "exception") context.binding = "constructor";
    else if (text === "class") context.binding = "type";
    return "keyword";
  }

  if (token === "operator") {
    if (text === "=") context.binding = null;
    if (
      text === "@" &&
      (context.binding !== null || source[tokenEnd] === "(")
    ) {
      return "observation";
    }
    return "operator";
  }

  if (token === "variableName.special") return "label";
  if (token === "quote") return "variant";
  if (token === "builtin") {
    if (text === "true" || text === "false") return "bool";
    return /^[A-Z]/.test(text) ? "module" : "builtin";
  }
  if (token !== "variable") return token.replaceAll(".", "-");

  if (/^[A-Z]/.test(text)) {
    if (context.binding === "constructor") {
      context.binding = null;
      return "constructor-definition";
    }
    if (context.binding === "module") {
      context.binding = null;
      return "module-definition";
    }
    return source.slice(tokenEnd).trimStart().startsWith(".")
      ? "module"
      : "constructor";
  }
  if (context.binding === "type") {
    context.binding = null;
    return "type-definition";
  }
  if (context.binding === "module") {
    context.binding = null;
    return "module-definition";
  }
  if (context.binding === "constructor") {
    context.binding = null;
    return "constructor-definition";
  }
  if (context.binding === "value") {
    context.binding = "parameters";
    return "definition";
  }
  if (context.binding === "parameters") return "parameter";
  return "variable";
}

function markdownFenceMarker(text) {
  const leading = text.match(/^ {0,3}/)?.[0].length || 0;
  const marker = text[leading];
  if (marker !== "`" && marker !== "~") return null;
  let after = leading;
  while (text[after] === marker) after += 1;
  const length = after - leading;
  if (length < 3) return null;
  return { marker, length, after, info: text.slice(after).trim() };
}

function isMarkdownFenceClose(text, fence) {
  const candidate = markdownFenceMarker(text);
  return (
    candidate?.marker === fence.marker &&
    candidate.length >= fence.length &&
    text.slice(candidate.after).trim() === ""
  );
}

function isEscaped(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function singleBacktickSpans(text) {
  const delimiters = [];
  const spans = [];
  for (let index = 0; index < text.length; ) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    let after = index + 1;
    while (text[after] === "`") after += 1;
    const length = after - index;
    if (!isEscaped(text, index)) {
      if (length === 1) delimiters.push(index);
      else if (length === 2) {
        spans.push({ opening: index, closing: index + 1 });
      }
    }
    index = after;
  }
  for (let index = 0; index + 1 < delimiters.length; index += 2) {
    const opening = delimiters[index];
    const closing = delimiters[index + 1];
    spans.push({ opening, closing });
  }
  return spans.sort((left, right) => left.opening - right.opening);
}

function lineIsInsideMarkdownFence(doc, lineNumber) {
  let fence = null;
  for (let number = 1; number <= lineNumber; number += 1) {
    const text = doc.line(number).text;
    if (fence) {
      if (isMarkdownFenceClose(text, fence)) fence = null;
    } else {
      fence = markdownFenceMarker(text);
    }
  }
  return fence !== null;
}

const completeHeadingSpace = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged || !transaction.isUserEvent("input.type")) {
    return transaction;
  }
  let insertAt = null;
  transaction.changes.iterChangedRanges((fromBefore, _toBefore, fromAfter) => {
    if (insertAt !== null) return;
    const previousLine = transaction.startState.doc.lineAt(fromBefore);
    if (
      !/^#{1,6}$/.test(previousLine.text) ||
      lineIsInsideMarkdownFence(
        transaction.startState.doc,
        previousLine.number,
      )
    ) {
      return;
    }
    const nextLine = transaction.newDoc.lineAt(fromAfter);
    const heading = nextLine.text.match(/^(#{1,6})([^\s#])/u);
    if (heading) insertAt = nextLine.from + heading[1].length;
  });
  if (insertAt === null) return transaction;
  return [
    transaction,
    {
      changes: { from: insertAt, insert: " " },
      sequential: true,
      userEvent: "input.type",
    },
  ];
});

const setWikiConfig = StateEffect.define();
const wikiConfigField = StateField.define({
  create: () => ({ modules: new Set(), onNavigate: null }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setWikiConfig)) return effect.value;
    }
    return value;
  },
});

function wikiLinkSpans(text) {
  const spans = [];
  const expression = /\[\[([A-Z][A-Za-z0-9_']*(?:\.[A-Z][A-Za-z0-9_']*)*)(#[^\]\n]+)?\]\]/g;
  for (const match of text.matchAll(expression)) {
    const opening = match.index;
    if (isEscaped(text, opening)) continue;
    spans.push({
      opening,
      contentFrom: opening + 2,
      contentTo: opening + 2 + match[1].length + (match[2]?.length || 0),
      closingTo: opening + match[0].length,
      module: match[1],
    });
  }
  return spans;
}

function handleWikiInput(event, view) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    view.state.readOnly
  ) {
    return false;
  }
  const selection = view.state.selection.main;
  if (!selection.empty || view.state.selection.ranges.length !== 1) return false;
  if (event.key === "[") {
    const before =
      selection.head > 0 ? view.state.doc.sliceString(selection.head - 1, selection.head) : "";
    if (before !== "[") return false;
    view.dispatch({
      changes: { from: selection.head, insert: "[]]" },
      selection: { anchor: selection.head + 1 },
      userEvent: "input.type",
    });
    return true;
  }
  if (event.key === "]") {
    const after = view.state.doc.sliceString(
      selection.head,
      Math.min(view.state.doc.length, selection.head + 2),
    );
    if (!after.startsWith("]")) return false;
    view.dispatch({
      selection: { anchor: selection.head + 1 },
      userEvent: "select",
    });
    return true;
  }
  if (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey)
  ) {
    const line = view.state.doc.lineAt(selection.head);
    const column = selection.head - line.from;
    const span = wikiLinkSpans(line.text).find(
      (candidate) =>
        column >= candidate.opening && column <= candidate.closingTo,
    );
    if (!span) return false;
    view.state.field(wikiConfigField).onNavigate?.(span.module);
    return true;
  }
  return false;
}

function completeHeadingOnKeydown(event, view) {
  const character = event.key;
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    [...character].length !== 1 ||
    /^[\s#]$/u.test(character) ||
    view.state.readOnly
  ) {
    return false;
  }
  const selection = view.state.selection.main;
  if (!selection.empty || view.state.selection.ranges.length !== 1) {
    return false;
  }
  const line = view.state.doc.lineAt(selection.head);
  if (
    selection.head !== line.to ||
    !/^#{1,6}$/.test(line.text) ||
    lineIsInsideMarkdownFence(view.state.doc, line.number)
  ) {
    return false;
  }
  view.dispatch({
    changes: {
      from: selection.from,
      to: selection.to,
      insert: ` ${character}`,
    },
    selection: { anchor: selection.from + character.length + 1 },
    userEvent: "input.type",
    scrollIntoView: true,
  });
  return true;
}

class HeadingDraftAnchor extends WidgetType {
  eq(other) {
    return other instanceof HeadingDraftAnchor;
  }

  toDOM() {
    const anchor = document.createElement("span");
    anchor.className = "cm-md-heading-anchor";
    anchor.setAttribute("aria-hidden", "true");
    anchor.textContent = "\u200b";
    return anchor;
  }

  coordsAt(anchor) {
    const rect = anchor.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.left,
      top: rect.top,
      bottom: rect.bottom,
    };
  }
}

function markdownDecorations(view) {
  if (view.state.field(editorModeField) === "source") {
    return Decoration.none;
  }
  const decorations = [];
  const wikiConfig = view.state.field(wikiConfigField);
  let parserState = null;
  let markdownFence = null;
  let inOcamlFence = false;
  let listContext = false;

  for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
    const line = view.state.doc.line(lineNumber);
    const trimmed = line.text.trim();
    if (markdownFence) {
      if (isMarkdownFenceClose(line.text, markdownFence)) {
        markdownFence = null;
        inOcamlFence = false;
        parserState = null;
        listContext = false;
        continue;
      }
      if (!inOcamlFence) continue;
    } else {
      const openingFence = markdownFenceMarker(line.text);
      if (openingFence) {
        markdownFence = openingFence;
        inOcamlFence =
          openingFence.marker === "`" &&
          /^(?:ocaml|ocaml-example)(?:\s|$)/.test(openingFence.info);
        parserState = inOcamlFence ? oCaml.startState() : null;
        listContext = false;
        continue;
      }
    }

    const listItem = line.text.match(
      /^(\s*)((?:[-+*])|(?:\d+[.)]))(\s+)/,
    );
    const listContinuation =
      !inOcamlFence &&
      listContext &&
      (line.text.startsWith("    ") || trimmed === "");
    const indentation = line.text.startsWith("    ") ? 4 : 0;
    const unindentedBoundary =
      !inOcamlFence &&
      parserState !== null &&
      indentation === 0 &&
      trimmed === "" &&
      !listContext;
    const isOcaml =
      inOcamlFence ||
      (indentation === 4 && !listContinuation) ||
      unindentedBoundary;
    if (isOcaml) {
      listContext = false;
      decorations.push(
        Decoration.line({
          attributes: { class: "cm-md-indented-code" },
        }).range(line.from),
      );
      parserState ||= oCaml.startState();
      const source = line.text.slice(indentation);
      const stream = new StringStream(source, 4, 4);
      const tokenContext = { binding: null, previous: null };
      while (!stream.eol()) {
        stream.start = stream.pos;
        const token = oCaml.token(stream, parserState);
        if (stream.pos <= stream.start) stream.pos += 1;
        if (!token || stream.pos <= stream.start) continue;
        const text = source.slice(stream.start, stream.pos);
        const semanticToken = classifyOcamlToken(
          token,
          text,
          source,
          stream.pos,
          tokenContext,
        );
        const tokenClass = semanticToken
          .split(/\s+/)
          .filter(Boolean)
          .map((name) => `cm-ocaml-${name}`)
          .join(" ");
        const mark = { class: tokenClass };
        if (semanticToken === "observation") {
          mark.attributes = {
            "data-observation-line": String(lineNumber),
            "data-observation-column": String(indentation + stream.start),
          };
        }
        decorations.push(
          Decoration.mark(mark).range(
            line.from + indentation + stream.start,
            line.from + indentation + stream.pos,
          ),
        );
        if (token !== "comment") tokenContext.previous = text;
      }
      if (unindentedBoundary) parserState = null;
      continue;
    }

    if (trimmed) parserState = null;
    if (listItem) {
      const depth = Math.min(3, Math.floor(listItem[1].length / 4));
      decorations.push(
        Decoration.line({
          attributes: {
            class: `cm-md-list cm-md-list-${depth}`,
          },
        }).range(line.from),
      );
      decorations.push(
        Decoration.mark({ class: "cm-md-list-marker" }).range(
          line.from + listItem[1].length,
          line.from + listItem[1].length + listItem[2].length,
        ),
      );
      listContext = true;
    } else if (trimmed === "") {
      listContext = false;
    } else if (!line.text.startsWith("    ")) {
      listContext = false;
    }

    const heading = line.text.match(/^(#{1,6})(?=\s|$)/);
    if (heading) {
      const markerTo = line.from + heading[1].length;
      const headingDraft =
        line.text.slice(heading[1].length).trim().length === 0;
      const sourceMarkerTo =
        markerTo + (/^\s/.test(line.text.slice(heading[1].length)) ? 1 : 0);
      const markerVisible =
        view.hasFocus &&
        view.state.selection.ranges.some((range) =>
          range.empty
            ? range.head >= line.from && range.head <= sourceMarkerTo
            : range.from <= sourceMarkerTo && range.to >= line.from,
        );
      decorations.push(
        Decoration.line({
          attributes: {
            class: `cm-md-heading cm-md-heading-${heading[1].length}`,
          },
        }).range(line.from),
      );
      decorations.push(
        Decoration.mark({
          class: `cm-md-marker${markerVisible ? " cm-md-marker-visible" : ""}`,
        }).range(
          line.from,
          sourceMarkerTo,
        ),
      );
      if (headingDraft) {
        decorations.push(
          Decoration.widget({
            widget: new HeadingDraftAnchor(),
            side: -1,
          }).range(sourceMarkerTo),
        );
      }
    }

    const inlineSpans = singleBacktickSpans(line.text);
    for (const wiki of wikiLinkSpans(line.text)) {
      if (
        inlineSpans.some(
          (code) =>
            wiki.opening >= code.opening && wiki.opening <= code.closing,
        )
      ) {
        continue;
      }
      const opening = line.from + wiki.opening;
      const contentFrom = line.from + wiki.contentFrom;
      const contentTo = line.from + wiki.contentTo;
      const closingTo = line.from + wiki.closingTo;
      const markerVisible =
        view.hasFocus &&
        view.state.selection.ranges.some((range) =>
          range.empty
            ? range.head >= opening && range.head <= closingTo
            : range.from <= closingTo && range.to >= opening,
        );
      const markerClass = `cm-wiki-marker${markerVisible ? " cm-wiki-marker-visible" : ""}`;
      decorations.push(
        Decoration.mark({
          class: markerClass,
        }).range(opening, contentFrom),
        Decoration.mark({
          class: `cm-wiki-link${wikiConfig.modules.has(wiki.module) ? "" : " cm-wiki-missing"}`,
          attributes: {
            "data-wiki-module": wiki.module,
            title: wikiConfig.modules.has(wiki.module)
              ? `Open ${wiki.module}`
              : `Create ${wiki.module}`,
          },
        }).range(contentFrom, contentTo),
        Decoration.mark({
          class: markerClass,
        }).range(contentTo, closingTo),
      );
    }

    for (const code of inlineSpans) {
      const opening = line.from + code.opening;
      const contentFrom = opening + 1;
      const contentTo = line.from + code.closing;
      const closingTo = contentTo + 1;
      const markerVisible =
        view.hasFocus &&
        view.state.selection.ranges.some((range) =>
          range.empty
            ? range.head >= opening && range.head <= closingTo
            : range.from <= closingTo && range.to >= opening,
        );
      const markerClass = `cm-md-inline-marker${markerVisible ? " cm-md-inline-marker-visible" : ""}`;
      decorations.push(
        Decoration.mark({
          class: "cm-md-inline-shell",
        }).range(opening, closingTo),
        Decoration.mark({
          class: `${markerClass} cm-md-inline-marker-open`,
        }).range(opening, contentFrom),
      );
      if (contentFrom < contentTo) {
        decorations.push(
          Decoration.mark({ class: "cm-md-inline-code" }).range(
            contentFrom,
            contentTo,
          ),
        );
      }
      decorations.push(
        Decoration.mark({
          class: `${markerClass} cm-md-inline-marker-close`,
        }).range(contentTo, closingTo),
      );
    }
  }

  return Decoration.set(decorations, true);
}

const markdownPresentation = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = markdownDecorations(view);
    }

    update(update) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        update.transactions.some((transaction) =>
          transaction.effects.some(
            (effect) =>
              effect.is(setWikiConfig) || effect.is(setEditorMode),
          ),
        )
      ) {
        this.decorations = markdownDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function appendResultRow(parent, { kind = "output", marker = "›", text = "", type = "" }) {
  if (!text && kind !== "html") return;
  const row = document.createElement("div");
  row.className = `cm-block-result-row cm-block-result-${kind}`;

  const mark = document.createElement("span");
  mark.className = "cm-block-result-mark";
  mark.textContent = marker;
  row.append(mark);

  if (kind === "html") {
    const frame = document.createElement("iframe");
    frame.className = "runtime-frame";
    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    frame.setAttribute("title", "Sandboxed OCaml output");
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fffefa;color:#1d2824;font-family:system-ui,sans-serif}body{padding:12px}</style></head><body>${text}</body></html>`;
    row.append(frame);
  } else {
    const content = document.createElement("pre");
    content.className = "cm-block-result-text";
    if (type) {
      const typeNode = document.createElement("span");
      typeNode.className = "cm-block-result-type";
      typeNode.textContent = type;
      content.append(typeNode);
    }
    content.append(document.createTextNode(text));
    row.append(content);
  }
  parent.append(row);
}

class BlockResultsWidget extends WidgetType {
  constructor(group, invalidated = false) {
    super();
    this.group = group;
    this.invalidated = invalidated;
    this.key = JSON.stringify([group, invalidated]);
  }

  eq(other) {
    return other instanceof BlockResultsWidget && other.key === this.key;
  }

  toDOM() {
    const container = document.createElement("div");
    container.className = `cm-block-results${this.invalidated ? " cm-result-invalidated" : ""}`;
    container.setAttribute(
      "aria-label",
      this.invalidated ? "Out-of-date code block results" : "Code block results",
    );

    for (const output of this.group.outputs) {
      if (output.stdout) {
        appendResultRow(container, {
          kind: "output",
          marker: "›",
          text: output.stdout,
        });
      }
      if (output.stderr) {
        appendResultRow(container, {
          kind: "error",
          marker: "!",
          text: output.stderr,
        });
      }
    }
    for (const view of this.group.views) {
      if (view.kind === "value") {
        const [type = "", value = ""] = view.content.split("\x1f");
        appendResultRow(container, {
          kind: "value",
          marker: "=",
          text: value,
          type,
        });
      } else if (view.kind === "html") {
        appendResultRow(container, {
          kind: "html",
          marker: "↗",
          text: view.content,
        });
      } else if (view.kind === "link") {
        const [label = "", url = ""] = view.content.split("\x1f");
        appendResultRow(container, {
          kind: "value",
          marker: "↗",
          text: `${label} — ${url}`,
        });
      } else {
        appendResultRow(container, {
          kind: "value",
          marker: "=",
          text: view.content,
        });
      }
    }
    for (const diagnostic of this.group.diagnostics) {
      appendResultRow(container, {
        kind: diagnostic.severity === "warning" ? "warning" : "error",
        marker: diagnostic.severity === "warning" ? "△" : "!",
        text: diagnostic.message,
      });
    }
    return container;
  }

  withInvalidation(invalidated) {
    return new BlockResultsWidget(this.group, invalidated);
  }
}

class InlineResultWidget extends WidgetType {
  constructor(result, index, invalidated = false) {
    super();
    this.result = result;
    this.index = index;
    this.invalidated = invalidated;
    this.key = JSON.stringify([result, index, invalidated]);
  }

  eq(other) {
    return other instanceof InlineResultWidget && other.key === this.key;
  }

  toDOM() {
    const result = document.createElement("span");
    result.className = `cm-inline-result${this.result.error ? " cm-inline-result-error" : ""}${this.invalidated ? " cm-result-invalidated" : ""}`;
    result.textContent = this.result.error ? "!" : this.result.value;
    const description = this.result.error || this.result.type;
    if (this.invalidated) {
      result.title = description
        ? `Out of date · ${description}`
        : "Out of date";
    } else if (description) {
      result.title = description;
    }
    result.setAttribute(
      "aria-label",
      `${this.invalidated ? "Out-of-date " : ""}${
        this.result.error
          ? `inline expression error: ${this.result.error}`
          : `inline expression result: ${this.result.value}${this.result.type ? `, type ${this.result.type}` : ""}`
      }`,
    );
    return result;
  }

  withInvalidation(invalidated) {
    return new InlineResultWidget(this.result, this.index, invalidated);
  }
}

const setBlockResults = StateEffect.define();
const setResultInvalidation = StateEffect.define();

function resultIsInvalidated(widget, invalidation) {
  if (!invalidation) return false;
  if (widget instanceof BlockResultsWidget) {
    return (
      widget.group.executionIndex !== null &&
      invalidation.blockFrom !== null &&
      widget.group.executionIndex >= invalidation.blockFrom
    );
  }
  if (widget instanceof InlineResultWidget) {
    return (
      invalidation.inlineFrom !== null &&
      widget.index >= invalidation.inlineFrom
    );
  }
  return false;
}

function applyResultInvalidation(decorations, invalidation, documentLength) {
  const ranges = [];
  decorations.between(0, documentLength, (from, _to, decoration) => {
    const widget = decoration.spec.widget;
    if (
      !(widget instanceof BlockResultsWidget) &&
      !(widget instanceof InlineResultWidget)
    ) {
      ranges.push(decoration.range(from));
      return;
    }
    const nextWidget = widget.withInvalidation(
      resultIsInvalidated(widget, invalidation),
    );
    ranges.push(
      Decoration.widget({
        ...decoration.spec,
        widget: nextWidget,
      }).range(from),
    );
  });
  return Decoration.set(ranges, true);
}

const blockResultsField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setBlockResults)) next = effect.value;
      if (effect.is(setResultInvalidation)) {
        next = applyResultInvalidation(
          next,
          effect.value,
          transaction.newDoc.length,
        );
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function blockForDiagnostic(blocks, diagnostic) {
  if (!diagnostic.line) return null;
  return (
    blocks.find(
      (block) =>
        block.kind !== "prose" &&
        diagnostic.line >= block.lineStart &&
        diagnostic.line <= block.lineEnd,
    ) || null
  );
}

function buildBlockResultDecorations(state, { evaluation, blocks, path }) {
  if (!evaluation) return Decoration.none;
  const codeBlocks = blocks.filter((block) => block.kind !== "prose");
  let executionIndex = 0;
  const groups = new Map(
    codeBlocks.map((block) => {
      const group = {
        block,
        executionIndex: block.kind === "ocaml" ? executionIndex++ : null,
        outputs: [],
        views: [],
        diagnostics: [],
      };
      return [block.id, group];
    }),
  );
  const lastGroup = codeBlocks.length
    ? groups.get(codeBlocks[codeBlocks.length - 1].id)
    : null;

  const blockOutputs = (evaluation.blockOutputs || []).filter(
    (output) => !output.path || output.path === path,
  );
  for (const output of blockOutputs) {
    (groups.get(output.blockId) || lastGroup)?.outputs.push(output);
  }
  if (!blockOutputs.length && lastGroup) {
    if (evaluation.stdout) {
      lastGroup.outputs.push({ stdout: evaluation.stdout, stderr: "" });
    }
    if (evaluation.stderr) {
      lastGroup.outputs.push({ stdout: "", stderr: evaluation.stderr });
    }
  }

  for (const view of evaluation.views || []) {
    const matchingBlock = codeBlocks.find(
      (block) => block.id === view.id || block.name === view.id,
    );
    (groups.get(matchingBlock?.id) || lastGroup)?.views.push(view);
  }

  for (const diagnostic of evaluation.diagnostics || []) {
    if (diagnostic.path && diagnostic.path !== path) continue;
    const block = blockForDiagnostic(codeBlocks, diagnostic);
    if (block) groups.get(block.id)?.diagnostics.push(diagnostic);
    else if (!diagnostic.line) lastGroup?.diagnostics.push(diagnostic);
  }

  const widgets = [];
  for (const group of groups.values()) {
    if (
      !group.outputs.length &&
      !group.views.length &&
      !group.diagnostics.length
    ) {
      continue;
    }
    const lineNumber = Math.min(
      Math.max(group.block.lineEnd, 1),
      state.doc.lines,
    );
    const line = state.doc.line(lineNumber);
    widgets.push(
      Decoration.widget({
        widget: new BlockResultsWidget(group),
        block: true,
        side: 1,
      }).range(line.to),
    );
  }
  for (const [index, result] of (evaluation.inlineResults || []).entries()) {
    if (result.path && result.path !== path) continue;
    if (!result.line || result.line > state.doc.lines) continue;
    const line = state.doc.line(Math.max(1, result.line));
    const column = utf16ColumnForUtf8ByteColumn(
      line.text,
      result.resultColumn,
    );
    const position = line.from + Math.min(column, line.length);
    widgets.push(
      Decoration.widget({
        widget: new InlineResultWidget(result, index),
        side: -1,
      }).range(position),
    );
  }
  return Decoration.set(widgets, true);
}

function utf16ColumnForUtf8ByteColumn(text, byteColumn) {
  if (!Number.isFinite(byteColumn) || byteColumn <= 0) return 0;
  let bytes = 0;
  let utf16 = 0;
  for (const character of text) {
    const width = new TextEncoder().encode(character).length;
    if (bytes + width > byteColumn) break;
    bytes += width;
    utf16 += character.length;
  }
  return utf16;
}

function editorDiagnostics(state, evaluation, blocks, path) {
  if (!evaluation) return [];
  return (evaluation.diagnostics || [])
    .filter(
      (diagnostic) =>
        diagnostic.line &&
        (!diagnostic.path || diagnostic.path === path) &&
        diagnostic.line <= state.doc.lines,
    )
    .map((diagnostic) => {
      const line = state.doc.line(Math.max(1, diagnostic.line));
      const block = blockForDiagnostic(blocks, diagnostic);
      const sourceIndent =
        block?.kind === "ocaml" && line.text.startsWith("    ") ? 4 : 0;
      const sourceText = line.text.slice(sourceIndent);
      let from =
        line.from +
        sourceIndent +
        utf16ColumnForUtf8ByteColumn(
          sourceText,
          diagnostic.columnStart ?? 0,
        );
      let to =
        line.from +
        sourceIndent +
        utf16ColumnForUtf8ByteColumn(
          sourceText,
          diagnostic.columnEnd ?? diagnostic.columnStart ?? 0,
        );
      from = Math.min(Math.max(from, line.from), line.to);
      to = Math.min(Math.max(to, from), line.to);
      if (to === from) {
        if (from < line.to) {
          const token = line.text.slice(from - line.from).match(/^\S+/)?.[0];
          to = Math.min(line.to, from + Math.max(token?.length || 1, 1));
        } else if (from > line.from) {
          from -= 1;
        }
      }
      return {
        from,
        to,
        severity:
          diagnostic.severity === "warning"
            ? "warning"
            : diagnostic.severity === "info"
              ? "info"
              : "error",
        message: diagnostic.message,
      };
    });
}

export function setMarkdownEditorEvaluation(
  view,
  { evaluation, blocks = [], path = "" },
) {
  const diagnostics = editorDiagnostics(view.state, evaluation, blocks, path);
  const results = buildBlockResultDecorations(view.state, {
    evaluation,
    blocks,
    path,
  });
  const lintUpdate = setDiagnostics(view.state, diagnostics);
  view.dispatch({
    ...lintUpdate,
    effects: [
      ...(lintUpdate.effects || []),
      setBlockResults.of(results),
    ],
  });
}

export function setMarkdownEditorResultInvalidation(view, invalidation) {
  const lintUpdate = invalidation
    ? setDiagnostics(view.state, [])
    : { effects: [] };
  view.dispatch({
    ...lintUpdate,
    effects: [
      ...(lintUpdate.effects || []),
      setResultInvalidation.of(invalidation),
    ],
  });
}

function isInsideExecutableFence(doc, lineNumber) {
  let inFence = false;
  for (let number = 1; number <= lineNumber; number += 1) {
    const text = doc.line(number).text.trim();
    if (inFence && text === "```") {
      inFence = false;
    } else if (
      !inFence &&
      /^```(?:ocaml|ocaml-example)(?:\s|$)/.test(text)
    ) {
      inFence = true;
    }
  }
  return inFence;
}

const inlineBacktickLanguageData = Prec.highest(
  EditorState.languageData.of((state, position) => {
    const line = state.doc.lineAt(position);
    const isCode =
      line.text.startsWith("    ") ||
      lineIsInsideMarkdownFence(state.doc, line.number);
    return [
      {
        closeBrackets: {
          brackets: isCode ? [] : ["`"],
          before: ")]}:;>,.!?",
        },
      },
    ];
  }),
);

export function exitIndentedCodeBlock(view) {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;

  const line = view.state.doc.lineAt(selection.head);
  if (
    selection.head !== line.to ||
    !line.text.startsWith("    ") ||
    isInsideExecutableFence(view.state.doc, line.number)
  ) {
    return false;
  }

  const blank = line.text.trim() === "";
  view.dispatch({
    changes: blank
      ? { from: line.from, to: line.to, insert: "\n" }
      : { from: line.to, insert: "\n\n" },
    selection: { anchor: blank ? line.from + 1 : line.to + 2 },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

export function continueIndentedCodeBlock(view) {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;

  const line = view.state.doc.lineAt(selection.head);
  if (
    selection.head !== line.to ||
    !/^ {4,}$/.test(line.text) ||
    isInsideExecutableFence(view.state.doc, line.number)
  ) {
    return false;
  }

  view.dispatch({
    changes: { from: line.to, insert: `\n${line.text}` },
    selection: { anchor: line.to + 1 + line.text.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

export function exitEmptyMarkdownListItem(view) {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  if (!/^\s*(?:[-+*]|\d+[.)])\s*$/.test(line.text)) return false;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: "" },
    selection: { anchor: line.from },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

export function exitTrailingCodeBlock(view) {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;

  const line = view.state.doc.lineAt(selection.head);
  if (
    line.number !== view.state.doc.lines ||
    !line.text.startsWith("    ") ||
    isInsideExecutableFence(view.state.doc, line.number)
  ) {
    return false;
  }

  const lowerPosition = view.moveVertically(selection, true);
  if (lowerPosition.head !== selection.head) return false;

  view.dispatch({
    changes: { from: line.to, insert: "\n\n" },
    selection: { anchor: line.to + 2 },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

function mountEditor(
  parent,
  {
    doc,
    editorState,
    onChange,
    onBlur,
    onSave,
    onStateChange,
    onSelectionChange,
    onCompletionKey,
    onDefinitionRequest,
    onDebugNavigate,
    sourceMode = "literate",
    wikiModules = [],
    onWikiNavigate,
  },
) {
  if (editorState) {
    const view = new EditorView({ state: editorState, parent });
    view.dispatch({
      effects: [
        setWikiConfig.of({
          modules: new Set(wikiModules),
          onNavigate: onWikiNavigate,
        }),
        setEditorMode.of(sourceMode),
      ],
    });
    return view;
  }
  const extensions = [
    history(),
    drawSelection(),
    dropCursor(),
    highlightActiveLine(),
    bracketMatching(),
    closeBrackets(),
    inlineBacktickLanguageData,
    indentUnit.of("    "),
    blockResultsField,
    debugPositionField,
    debugProjectionField,
    wikiConfigField,
    editorModeField,
    Prec.highest(keymap.of([
      ...closeBracketsKeymap,
      {
        key: "Mod-s",
        run: () => {
          onSave();
          return true;
        },
      },
      {
        key: "F12",
        run: (view) => {
          if (!onDefinitionRequest) return false;
          return (
            onDefinitionRequest(
              view.state.selection.main.head,
              "navigate",
            ) !== false
          );
        },
      },
      {
        key: "Alt-F12",
        run: (view) => {
          if (!onDefinitionRequest) return false;
          return (
            onDefinitionRequest(view.state.selection.main.head, "peek") !==
            false
          );
        },
      },
      {
        key: "ArrowDown",
        run: () => onCompletionKey?.("next") || false,
      },
      {
        key: "ArrowUp",
        run: () => onCompletionKey?.("previous") || false,
      },
      {
        key: "Escape",
        run: () => onCompletionKey?.("dismiss") || false,
      },
      {
        key: "Tab",
        run: () => onCompletionKey?.("accept") || false,
      },
      {
        key: "Enter",
        run: () => onCompletionKey?.("accept") || false,
      },
      { key: "Enter", run: continueIndentedCodeBlock },
      { key: "Enter", run: exitEmptyMarkdownListItem },
      { key: "Enter", run: insertNewlineContinueMarkup },
      { key: "Backspace", run: deleteMarkupBackward },
      { key: "ArrowDown", run: exitTrailingCodeBlock },
      { key: "Shift-Enter", run: exitIndentedCodeBlock },
      { key: "Tab", run: indentMore },
      { key: "Shift-Tab", run: indentLess },
    ])),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    embeddedTheme,
    highlightStyle,
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      onStateChange?.(update.state);
      if (update.docChanged) onChange(update.state.doc.toString());
      if (update.selectionSet || update.docChanged) {
        onSelectionChange?.(update.state.selection.main.head);
      }
    }),
    EditorView.domEventHandlers({
      keydown: (event, view) =>
        handleWikiInput(event, view) || completeHeadingOnKeydown(event, view),
      mousedown: (event, view) => {
        const debugCall = event.target.closest?.("[data-debug-call]");
        if (debugCall && view.dom.contains(debugCall)) {
          onDebugNavigate?.(debugCall.dataset.debugCall);
          event.preventDefault();
          return true;
        }
        if (!(event.metaKey || event.ctrlKey)) return false;
        const link = event.target.closest?.("[data-wiki-module]");
        if (link && view.dom.contains(link)) {
          view.state
            .field(wikiConfigField)
            .onNavigate?.(link.dataset.wikiModule);
          event.preventDefault();
          return true;
        }
        const position = view.posAtCoords({
          x: event.clientX,
          y: event.clientY,
        });
        if (position === null || !onDefinitionRequest) return false;
        if (!onDefinitionRequest(position, "navigate")) return false;
        event.preventDefault();
        return true;
      },
      focusout: (_event, view) => {
        queueMicrotask(() => {
          if (!view.dom.contains(document.activeElement)) onBlur();
        });
      },
    }),
  ];

  extensions.push(completeHeadingSpace, markdown(), markdownPresentation);

  const view = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent,
  });
  view.dispatch({
    effects: [
      setWikiConfig.of({
        modules: new Set(wikiModules),
        onNavigate: onWikiNavigate,
      }),
      setEditorMode.of(sourceMode),
    ],
  });
  return view;
}

export function mountMarkdownEditor(parent, options) {
  parent.classList.add("cm-literate-editor");
  return mountEditor(parent, options);
}

export function setMarkdownEditorMode(view, mode) {
  if (!view || view.state.field(editorModeField) === mode) return;
  view.dispatch({ effects: setEditorMode.of(mode) });
}

export function setMarkdownEditorDebugPosition(view, position) {
  if (!view) return;
  view.dispatch({ effects: setDebugPosition.of(position) });
}

export function setMarkdownEditorDebugProjection(view, projection) {
  if (!view) return;
  view.dispatch({ effects: setDebugProjection.of(projection) });
}

export function replaceEditorStateDocument(editorState, source) {
  if (!editorState || source === editorState.doc.toString()) return editorState;
  return editorState.update({
    changes: {
      from: 0,
      to: editorState.doc.length,
      insert: source,
    },
    annotations: Transaction.addToHistory.of(false),
    userEvent: "input.refactor",
  }).state;
}

const outlineTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "#34443d",
    fontSize: "13.5px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    lineHeight: "1.68",
    scrollbarWidth: "thin",
  },
  ".cm-content": {
    padding: "2px 0 32px",
    caretColor: colors.green,
    whiteSpace: "pre",
  },
  ".cm-line": {
    position: "relative",
    padding: "0 12px 0 7px",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-line:not(.cm-outline-active):hover": {
    borderRadius: "6px 0 0 6px",
    backgroundColor: "rgba(40, 95, 78, 0.055)",
  },
  "&.cm-focused .cm-activeLine": {
    backgroundColor: "rgba(40, 95, 78, 0.065)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgba(40, 95, 78, 0.14)",
  },
  ".cm-outline-active": {
    zIndex: "1",
    borderRadius: "7px 0 0 7px",
    backgroundColor: "var(--paper)",
    color: "#202824",
  },
  "&.cm-focused .cm-activeLine.cm-outline-active": {
    backgroundColor: "var(--paper)",
  },
  ".cm-outline-active::before, .cm-outline-active::after": {
    content: '""',
    position: "absolute",
    right: "0",
    width: "12px",
    height: "12px",
    pointerEvents: "none",
  },
  ".cm-outline-active::before": {
    top: "-12px",
    borderBottomRightRadius: "12px",
    boxShadow: "4px 4px 0 4px var(--paper)",
  },
  ".cm-outline-active::after": {
    bottom: "-12px",
    borderTopRightRadius: "12px",
    boxShadow: "4px -4px 0 4px var(--paper)",
  },
  ".cm-outline-namespace": {
    color: "#6f7b75",
  },
  ".cm-outline-active.cm-outline-namespace": {
    color: "#34463e",
  },
  ".cm-outline-pending": {
    backgroundColor: "rgba(40, 95, 78, 0.075)",
  },
  ".cm-outline-pending-visible": {
    backgroundImage: "radial-gradient(circle, #73817a 0 2px, transparent 2.5px)",
    backgroundPosition: "right 7px center",
    backgroundRepeat: "no-repeat",
  },
  ".cm-outline-invalid": {
    textDecoration: "underline wavy #a94436",
    textUnderlineOffset: "3px",
  },
  ".cm-outline-drag-handle": {
    position: "absolute",
    zIndex: "8",
    left: "0",
    width: "15px",
    height: "18px",
    border: "0",
    borderRadius: "5px",
    opacity: "0",
    pointerEvents: "none",
    cursor: "grab",
    backgroundImage:
      "radial-gradient(circle, rgba(58, 74, 67, .55) 0 1px, transparent 1.15px)",
    backgroundPosition: "2px 2px",
    backgroundSize: "5px 5px",
    transition: "opacity 80ms ease, background-color 80ms ease",
  },
  ".cm-outline-drag-handle.cm-visible": {
    opacity: "1",
    pointerEvents: "auto",
  },
  ".cm-outline-drag-handle:hover": {
    backgroundColor: "rgba(40, 95, 78, .075)",
  },
  ".cm-outline-dragging .cm-outline-drag-handle": {
    cursor: "grabbing",
  },
  ".cm-outline-drop-indicator": {
    position: "absolute",
    zIndex: "7",
    right: "9px",
    height: "1.5px",
    borderRadius: "2px",
    pointerEvents: "none",
    backgroundColor: "rgba(40, 95, 78, .72)",
    boxShadow: "0 0 0 1px rgba(248, 247, 243, .72)",
  },
  ".cm-outline-drop-indicator::before": {
    content: '""',
    position: "absolute",
    top: "-2px",
    left: "-2px",
    width: "5px",
    height: "5px",
    borderRadius: "50%",
    backgroundColor: "rgba(40, 95, 78, .82)",
  },
  ".cm-outline-drop-parent": {
    position: "absolute",
    zIndex: "0",
    right: "8px",
    borderRadius: "6px 0 0 6px",
    pointerEvents: "none",
    backgroundColor: "rgba(40, 95, 78, .075)",
  },
});

const setOutlineConfig = StateEffect.define();

const outlineConfigField = StateField.define({
  create() {
    return {
      activeModule: null,
      pendingModule: null,
      pendingVisible: false,
      lineMap: [],
    };
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setOutlineConfig)) value = effect.value;
    }
    return value;
  },
});

function outlineDecorations(view) {
  const {
    activeModule,
    pendingModule,
    pendingVisible,
    lineMap,
  } = view.state.field(outlineConfigField);
  const decorations = [];
  for (let number = 1; number <= view.state.doc.lines; number += 1) {
    const line = view.state.doc.line(number);
    const entry = lineMap[number - 1];
    const spaces = line.text.match(/^ */)?.[0].length || 0;
    const component = line.text.slice(spaces);
    const classes = [];
    if (
      entry?.invalid ||
      spaces % 2 !== 0 ||
      (component && !/^[A-Z][A-Za-z0-9_']*$/.test(component))
    ) {
      classes.push("cm-outline-invalid");
    }
    if (entry?.namespace) classes.push("cm-outline-namespace");
    const modulePath =
      entry?.originTarget ||
      entry?.pageModule ||
      null;
    if (modulePath === activeModule) classes.push("cm-outline-active");
    if (pendingModule && modulePath === pendingModule) {
      classes.push("cm-outline-pending");
      if (pendingVisible) classes.push("cm-outline-pending-visible");
    }
    if (classes.length) {
      const attributes = { class: classes.join(" ") };
      if (entry?.error) attributes.title = entry.error;
      decorations.push(
        Decoration.line({ attributes }).range(line.from),
      );
    }
  }
  return Decoration.set(decorations, true);
}

function insertOutlineSibling(view, onCommit) {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  const entry = view.state.field(outlineConfigField).lineMap[line.number - 1];
  if (line.text.trim() && entry?.changed) {
    onCommit?.("enter", selection.head);
    return true;
  }
  const indent = line.text.match(/^ */)?.[0] || "";
  let insertionPoint = line.to;
  for (let number = line.number + 1; number <= view.state.doc.lines; number += 1) {
    const candidate = view.state.doc.line(number);
    const candidateIndent = candidate.text.match(/^ */)?.[0].length || 0;
    if (candidate.text.trim() && candidateIndent <= indent.length) break;
    insertionPoint = candidate.to;
  }
  view.dispatch({
    changes: { from: insertionPoint, insert: `\n${indent}` },
    selection: { anchor: insertionPoint + 1 + indent.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

const outlineMoveAnnotation = Annotation.define();

function applyOutlineTransform(view, transform, onCommit) {
  if (!transform) return true;
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(selection.head);
  const column = selection.head - line.from;
  const oldIndent = line.text.match(/^ */)?.[0].length || 0;
  const nextLines = transform.source.split("\n");
  const selectedLine = Math.max(
    0,
    transform.originLines.indexOf(line.number),
  );
  const nextIndent =
    nextLines[selectedLine]?.match(/^ */)?.[0].length || 0;
  const nextColumn =
    nextIndent + Math.max(0, column - oldIndent);
  const position =
    nextLines
      .slice(0, selectedLine)
      .reduce((length, text) => length + text.length + 1, 0) +
    Math.min(nextColumn, nextLines[selectedLine]?.length || 0);
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: transform.source,
    },
    selection: { anchor: position },
    scrollIntoView: true,
    annotations: outlineMoveAnnotation.of(transform.originLines),
    userEvent: "move.line",
  });
  queueMicrotask(() => onCommit?.("reorder", position));
  return true;
}

function moveOutlineSiblingInEditor(view, direction, onCommit) {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  const start = line.number - 1;
  return applyOutlineTransform(
    view,
    moveOutlineSibling(view.state.doc.toString(), start, direction),
    onCommit,
  );
}

function changeOutlineNesting(view, direction, onCommit) {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  const source = view.state.doc.toString();
  const transform =
    direction > 0
      ? indentOutlineSubtree(source, line.number - 1)
      : outdentOutlineSubtree(source, line.number - 1);
  return applyOutlineTransform(view, transform, onCommit);
}

function outlineLineElement(view, line) {
  const dom = view.domAtPos(line.from);
  const node = dom.node.nodeType === Node.TEXT_NODE
    ? dom.node.parentElement
    : dom.node;
  return node?.closest?.(".cm-line") || null;
}

function outlineDragPlugin(onCommit) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.hoveredLine = null;
        this.drag = null;
        this.handle = document.createElement("div");
        this.handle.className = "cm-outline-drag-handle";
        this.handle.setAttribute("aria-hidden", "true");
        this.handle.title = "Drag to move page";
        this.indicator = document.createElement("div");
        this.indicator.className = "cm-outline-drop-indicator";
        this.indicator.hidden = true;
        this.parentHighlight = document.createElement("div");
        this.parentHighlight.className = "cm-outline-drop-parent";
        this.parentHighlight.hidden = true;
        view.dom.append(this.parentHighlight, this.indicator, this.handle);
        this.onHover = (event) => this.hover(event);
        this.onLeave = (event) => this.leave(event);
        this.onPointerDown = (event) => this.start(event);
        this.onPointerMove = (event) => this.move(event);
        this.onPointerUp = (event) => this.finish(event);
        view.dom.addEventListener("pointermove", this.onHover);
        view.dom.addEventListener("pointerleave", this.onLeave);
        this.handle.addEventListener("pointerdown", this.onPointerDown);
        this.handle.addEventListener("pointermove", this.onPointerMove);
        this.handle.addEventListener("pointerup", this.onPointerUp);
        this.handle.addEventListener("pointercancel", this.onPointerUp);
      }

      lineAt(event) {
        const position = this.view.posAtCoords({
          x: event.clientX,
          y: event.clientY,
        });
        if (position === null) return null;
        const line = this.view.state.doc.lineAt(position);
        return line.text.trim() ? line : null;
      }

      placeHandle(line) {
        const element = outlineLineElement(this.view, line);
        if (!element) return this.hideHandle();
        const root = this.view.dom.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        this.hoveredLine = line.number - 1;
        this.handle.style.top =
          `${rect.top - root.top + (rect.height - 18) / 2}px`;
        this.handle.classList.add("cm-visible");
      }

      hideHandle() {
        if (this.drag) return;
        this.hoveredLine = null;
        this.handle.classList.remove("cm-visible");
      }

      hover(event) {
        if (this.drag || this.handle.contains(event.target)) return;
        const root = this.view.dom.getBoundingClientRect();
        if (event.clientX - root.left > 20) {
          this.hideHandle();
          return;
        }
        const line = this.lineAt(event);
        if (line) this.placeHandle(line);
        else this.hideHandle();
      }

      leave(event) {
        if (!this.drag && !this.handle.contains(event.relatedTarget)) {
          this.hideHandle();
        }
      }

      start(event) {
        if (event.button !== 0 || this.hoveredLine === null) return;
        event.preventDefault();
        event.stopPropagation();
        this.drag = {
          pointerId: event.pointerId,
          sourceLine: this.hoveredLine,
          transform: null,
        };
        this.handle.setPointerCapture(event.pointerId);
        this.view.dom.classList.add("cm-outline-dragging");
      }

      showDrop(line, placement) {
        const element = outlineLineElement(this.view, line);
        if (!element) return;
        const root = this.view.dom.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        const source = this.view.state.doc.toString();
        let top = rect.top - root.top;
        let depth = outlineDepth(line.text);
        if (placement === "after") {
          const end = outlineSubtreeEnd(source, line.number - 1);
          const finalLine = this.view.state.doc.line(
            Math.max(line.number, end),
          );
          const finalElement = outlineLineElement(this.view, finalLine);
          top = (finalElement?.getBoundingClientRect().bottom || rect.bottom)
            - root.top;
        } else if (placement === "inside-first") {
          top = rect.bottom - root.top;
          depth += 1;
        }
        const content = this.view.contentDOM.getBoundingClientRect();
        this.indicator.style.top = `${top - 0.75}px`;
        this.indicator.style.left =
          `${Math.max(13, content.left - root.left + 7 + depth * 14)}px`;
        this.indicator.hidden = false;
        if (placement === "inside-first") {
          this.parentHighlight.style.top = `${rect.top - root.top}px`;
          this.parentHighlight.style.left =
            `${Math.max(15, content.left - root.left + 3)}px`;
          this.parentHighlight.style.height = `${rect.height}px`;
          this.parentHighlight.hidden = false;
        } else {
          this.parentHighlight.hidden = true;
        }
      }

      clearDrop() {
        this.indicator.hidden = true;
        this.parentHighlight.hidden = true;
        if (this.drag) this.drag.transform = null;
      }

      move(event) {
        if (!this.drag || event.pointerId !== this.drag.pointerId) return;
        event.preventDefault();
        const line = this.lineAt(event);
        if (!line) return this.clearDrop();
        const element = outlineLineElement(this.view, line);
        if (!element) return this.clearDrop();
        const rect = element.getBoundingClientRect();
        const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
        const placement =
          ratio < 0.27
            ? "before"
            : ratio > 0.73
              ? "after"
              : "inside-first";
        const transform = moveOutlineSubtree(
          this.view.state.doc.toString(),
          this.drag.sourceLine,
          line.number - 1,
          placement,
        );
        if (!transform) return this.clearDrop();
        this.drag.transform = transform;
        this.showDrop(line, placement);
        const scroller = this.view.scrollDOM.getBoundingClientRect();
        if (event.clientY < scroller.top + 24) this.view.scrollDOM.scrollTop -= 8;
        else if (event.clientY > scroller.bottom - 24) {
          this.view.scrollDOM.scrollTop += 8;
        }
      }

      finish(event) {
        if (!this.drag || event.pointerId !== this.drag.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const transform = this.drag.transform;
        this.drag = null;
        this.view.dom.classList.remove("cm-outline-dragging");
        this.clearDrop();
        this.hideHandle();
        if (transform) {
          this.view.focus();
          applyOutlineTransform(this.view, transform, onCommit);
        }
      }

      destroy() {
        this.view.dom.removeEventListener("pointermove", this.onHover);
        this.view.dom.removeEventListener("pointerleave", this.onLeave);
        this.handle.removeEventListener("pointerdown", this.onPointerDown);
        this.handle.removeEventListener("pointermove", this.onPointerMove);
        this.handle.removeEventListener("pointerup", this.onPointerUp);
        this.handle.removeEventListener("pointercancel", this.onPointerUp);
        this.handle.remove();
        this.indicator.remove();
        this.parentHighlight.remove();
      }
    },
  );
}

export function mountModuleOutlineEditor(
  parent,
  {
    doc,
    selection = 0,
    activeModule,
    pendingModule = null,
    pendingVisible = false,
    lineMap = [],
    onChange,
    onSelectionChange,
    onNavigate,
    onCommit,
    onCancel,
    onFocus,
    onBlur,
  },
) {
  parent.classList.add("cm-module-outline");
  const presentation = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = outlineDecorations(view);
      }

      update(update) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.transactions.some((transaction) =>
            transaction.effects.some((effect) => effect.is(setOutlineConfig)),
          )
        ) {
          this.decorations = outlineDecorations(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
  const extensions = [
    history(),
    drawSelection(),
    highlightActiveLine(),
    outlineTheme,
    outlineConfigField,
    presentation,
    outlineDragPlugin(onCommit),
    Prec.highest(
      keymap.of([
        {
          key: "Enter",
          run: (view) => insertOutlineSibling(view, onCommit),
        },
        {
          key: "Tab",
          run: (view) => changeOutlineNesting(view, 1, onCommit),
        },
        {
          key: "Shift-Tab",
          run: (view) => changeOutlineNesting(view, -1, onCommit),
        },
        {
          key: "Alt-ArrowUp",
          run: (view) => moveOutlineSiblingInEditor(view, -1, onCommit),
        },
        {
          key: "Alt-ArrowDown",
          run: (view) => moveOutlineSiblingInEditor(view, 1, onCommit),
        },
        {
          key: "Alt-ArrowRight",
          run: (view) => changeOutlineNesting(view, 1, onCommit),
        },
        {
          key: "Alt-ArrowLeft",
          run: (view) => changeOutlineNesting(view, -1, onCommit),
        },
        {
          key: "Escape",
          run: () => {
            onCancel?.();
            return true;
          },
        },
        {
          key: "Mod-Enter",
          run: () => {
            onCommit?.("mod-enter");
            return true;
          },
        },
      ]),
    ),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of((update) => {
      const externalSync = update.transactions.some(
        (transaction) =>
          transaction.annotation(Transaction.userEvent) === "outline.sync",
      );
      if (update.docChanged && !externalSync) {
        const moveOrigins = update.transactions
          .map((transaction) => transaction.annotation(outlineMoveAnnotation))
          .find(Boolean);
        onChange?.(update.state.doc.toString(), update, { moveOrigins });
      }
      if (update.selectionSet || update.docChanged) {
        onSelectionChange?.(update.state.selection.main, update);
      }
      if (update.selectionSet && !update.docChanged && !update.view.composing) {
        const userEvent = update.transactions
          .map((transaction) => transaction.annotation(Transaction.userEvent))
          .find(Boolean);
        if (userEvent?.startsWith("select")) {
          const before = update.startState.doc.lineAt(
            update.startState.selection.main.head,
          ).number;
          const after = update.state.doc.lineAt(
            update.state.selection.main.head,
          ).number;
          if (before !== after || userEvent.includes("pointer")) {
            onNavigate?.(
              update.state.selection.main,
              update,
              userEvent.includes("pointer") ? "pointer" : "vertical",
            );
          }
        }
      }
    }),
    EditorView.domEventHandlers({
      focus: () => {
        onFocus?.();
      },
      focusout: (_event, view) => {
        queueMicrotask(() => {
          if (!view.dom.contains(document.activeElement)) onBlur?.();
        });
      },
    }),
  ];
  const maxSelection = Math.min(selection, doc.length);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: maxSelection },
      extensions,
    }),
    parent,
  });
  view.doxOutlineExtensions = extensions;
  view.dispatch({
    effects: setOutlineConfig.of({
      activeModule,
      pendingModule,
      pendingVisible,
      lineMap,
    }),
  });
  return view;
}

export function updateModuleOutlineEditor(
  view,
  {
    doc,
    selection,
    activeModule,
    pendingModule = null,
    pendingVisible = false,
    lineMap,
    moveSelection = false,
  },
) {
  const current = view.state.doc.toString();
  const changed = current !== doc;
  const maxSelection = Math.min(selection, doc.length);
  const selectionChanged =
    view.state.selection.main.anchor !== maxSelection ||
    !view.state.selection.main.empty;
  if (changed) {
    const focused = view.hasFocus;
    view.setState(
      EditorState.create({
        doc,
        selection: { anchor: maxSelection },
        extensions: view.doxOutlineExtensions,
      }),
    );
    view.dispatch({
      effects: setOutlineConfig.of({
        activeModule,
        pendingModule,
        pendingVisible,
        lineMap,
      }),
    });
    if (focused) view.focus();
    return;
  }
  view.dispatch({
    selection:
      moveSelection && selectionChanged
        ? { anchor: maxSelection }
        : undefined,
    effects: setOutlineConfig.of({
      activeModule,
      pendingModule,
      pendingVisible,
      lineMap,
    }),
    userEvent:
      moveSelection && selectionChanged
        ? "outline.sync"
        : undefined,
  });
}
