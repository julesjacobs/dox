High-Level Design: A Live Literate Programming Language and Workspace

Status: Conceptual designScope: Language model, live document environment, project UI, debugging, artifact generation, and agent interaction

1. Purpose

The system is a programming language and development environment in which a source file is simultaneously:

a program;

a readable technical document;

a live, editable webpage;

a container for interactive application views;

an entry point into running services and other resources;

an inspectable and debuggable execution environment.

The design should scale from a single literate file to a multi-file application or project. It should also be native to AI-assisted development: an agent should be able to observe and operate on the same project that a human sees, while human users can review agent changes at the level of rendered documents and system structure rather than only as textual source diffs.

The exact surface syntax, type system, runtime strategy, and UI layout remain open. This document defines the common conceptual model and required capabilities.

2. Design principles

2.1 One underlying project, many projections

Source files are the durable representation of the program and document. The system derives several coordinated projections from them:

executable program structure;

rendered documents;

live application views;

runtime and debugger state;

generated artifacts;

file, module, subsystem, and project overviews;

semantic and visual diffs.

These are views of the same project, not separate products that must be manually synchronized.

2.2 Document and program are peers

Prose is not merely a comment attached to code, and code is not merely an opaque block embedded in a document. Both contribute to the meaning and structure of the source.

The document should be readable as a document, while the code portions collectively form an ordinary program. Splitting code across explanatory sections should not force notebook-style execution semantics.

2.3 Continuous use rather than a compile/run workflow

Editing, evaluating, rendering, and inspecting belong to one continuous environment. The system may compile internally, but the user should not need to switch between a compiler mode and a runtime mode.

Definitions can be used immediately in the live project. Producing a standalone executable or another deployable artifact is an explicit operation performed on an entry value, rather than a separate global phase imposed on the whole project.

2.4 Everything important is inspectable

A user should be able to move from any visible object to its source, runtime meaning, dependencies, and execution history. Conversely, a source entity should reveal where it appears in the document, application, running system, and project structure.

Inspection is a primary interface, not an afterthought.

2.5 Changes are first-class and reviewable at several levels

A modification is more than a textual patch. The system should understand it as a change to document structure, program entities, behavior, runtime topology, and project architecture.

The exact source diff remains available, but human review should usually begin with a rendered or semantic view of what changed.

2.6 Humans and agents share one interaction model

An agent should not operate through a hidden parallel interface unrelated to the human UI. Humans and agents should inspect the same project entities, invoke the same operations, and produce changes through the same versioned project model.

Visual interaction remains available, but semantic structure and provenance should make interaction more reliable than pixel-only automation.

3. Conceptual system model

At a high level:

source files
    |
    v
live project state
    |
    +-- rendered documents and applications
    +-- contextual inspection pane
    +-- running computations and services
    +-- debugger and execution history
    +-- generated executables and other artifacts
    +-- file/module/project structure views
    +-- proposed and committed change sets

The live project state is the coherent current interpretation of all source files, running values, document views, and long-lived activities. It is versioned so that edits, running executions, generated artifacts, debugger traces, and agent observations can be related to the exact project version from which they came.

4. Literate source model

The language must allow document markup and executable code to coexist naturally in one file.

A likely surface direction is document-first prose, such as Markdown, with indentation-delimited executable regions. HTML or an HTML-like notation may also be available where precise structure or application views are needed. The exact lexical design is intentionally not fixed here.

The core requirements are:

prose and code are unambiguously distinguishable;

code regions in one file contribute to a common program context;

source locations remain meaningful across document and code projections;

document markup may refer to values or views computed by the program;

code may construct document or application views;

ordinary source-control and text-editing workflows remain possible.

The language should distinguish executable code that belongs to the program from code examples that are merely shown in the document.

5. Live rendering and editing

A source document can be opened as a live webpage. The page is both a rendering of the source and an editing interface for it.

Editing rendered prose, code, or other source-backed structures should produce changes to the underlying source. The rendered HTML is not itself the canonical source representation.

Not every visible object is necessarily edited in the same way:

some visible regions correspond directly to prose or code in the source;

some represent live runtime state;

some are generated results;

some are interactive application components;

some are views of external or persistent resources.

The UI should make the meaning of an edit clear. Changing a source definition, changing current runtime state, and invoking an external action are different operations even when they are exposed through similar visual controls.

The environment should support both direct editing of the rendered document and access to the exact textual source.

6. Compiler processing and source corrections

Processing the source may do more than produce an executable interpretation. It may also:

format source;

normalize or transform source constructs;

update generated sections;

materialize selected computed results into the document;

apply language migrations or other source-level corrections.

Such transformations must be represented as explicit, reviewable changes to the source. They should not silently destroy authorship information or make it impossible to determine what changed.

Generated or baked material should remain connected to the computation that produced it. The design should allow a result to be:

computed only in the live session;

cached outside the source;

materialized into the source or project as a durable result.

The exact syntax and policy for generated regions are open.

7. Continuous evaluation and artifact production

The language behaves like a scripting or interactive language in that source definitions become usable as the project is evaluated. There is no required global distinction between “compiling the program” and “running the program.”

Standalone artifacts are created explicitly from values. For example, a function can take a designated entry function and produce an executable artifact. The same general idea may apply to other targets, such as a browser application, server, static document, or library.

This implies a local boundary between:

values and computations that exist in the current live project; and

values and code that become part of a produced artifact.

The detailed rules for captured state, external resources, target platforms, and optimization are intentionally left open. The important principle is that artifact production is an operation inside the language rather than a separate build-language layer.

Artifacts should be inspectable from the live environment and traceable back to the source and project version that produced them.

8. Applications, servers, and embedded views

A document may create and use running application infrastructure.

For example, code in the document may start a server. The rendered document may then:

link to that server;

embed it in an iframe;

issue requests to it;

show its status or output;

inspect and debug its execution.

The same principle extends to other live entities such as background computations, browser sessions, databases, workers, or external processes.

Long-lived activities must remain associated with the source expression and project version that created them. Editing the source should update, replace, preserve, or stop such activities according to explicit language and runtime semantics. The precise lifecycle model remains open, but accidental duplication or leakage of long-running activities is not acceptable.

The live document therefore acts not only as documentation but also as an application shell and operational interface.

9. Contextual side pane

The workspace includes a persistent contextual side pane analogous in spirit to Lean’s proof-state view.

The side pane shows additional information about the object at the cursor, current selection, focused view, or selected project entity. It provides detail without forcing all information to appear inline in the document.

Depending on context, it may show:

the meaning, type, or expanded form of a code expression;

the current value or state associated with a definition;

documentation and structural information;

callers, dependencies, and dependents;

the rendered result of a value;

a live preview that should not appear in the main document;

server status, requests, logs, or other resource information;

recent execution events and causal history;

debugger controls and the current debugging context;

before/after information while reviewing a change;

the source and runtime origins of a rendered object.

The pane should work bidirectionally:

moving through source or rendered content updates the pane;

selecting information in the pane can navigate to the corresponding source, view, runtime instance, or trace.

The pane is the common home for elaboration feedback, debugging, runtime inspection, and auxiliary previews.

10. Debugging and execution inspection

The debugger is integrated into the live document environment rather than separated into a distinct tool.

A user should be able to inspect execution starting from:

a source expression;

a rendered element;

an application interaction;

an embedded iframe;

a request to a server;

a value shown in the side pane;

a project-level behavior or dependency.

The system should preserve enough provenance to connect visible behavior to the source and runtime events that caused it.

Debugging should include both ordinary sequential execution and higher-level causal structure. In an application, a useful explanation may cross several boundaries:

user interaction
  -> client computation
  -> request
  -> server computation
  -> persistent-state change
  -> response
  -> rendered update

The exact tracing and replay mechanisms remain open, especially for external effects. The required capability is that execution can be inspected in terms of source-level entities and causal relationships, not only low-level machine state.

11. Multi-file and project workspace

The environment must scale beyond a single document.

It should provide a UI for browsing:

files and documents;

sections and definitions;

modules and packages;

application components and services;

tests and generated artifacts;

user-defined or inferred architectural areas;

the entire project.

The project should be viewable both as a containment hierarchy and through semantic relationships such as dependencies, calls, rendering, communication, generation, and deployment.

Files remain important, but they are not the only useful organizing unit. A feature or subsystem may span several files, while one file may contain entities that participate in several higher-level structures.

12. Semantic zoom

The project UI supports semantic zoom: zooming changes the representation and level of abstraction, rather than merely making the same text smaller.

Possible levels include:

exact source;

a definition, section, component, or resource;

a file or document outline;

a module, feature, or subsystem;

the whole project.

At each level, the system presents the information appropriate to that scale:

exact text at the source level;

formatted code, prose, or a live view at the entity level;

structure and summaries at the file level;

interfaces and relationships at the subsystem level;

architecture, runtime topology, and major flows at the project level.

A selected object should remain anchored while moving between levels, allowing the user to move from a visible button to its component, file, subsystem, and project role, or in the opposite direction.

13. Change sets and rendered diffs

Changes made by humans, agents, or compiler transformations are represented as coherent change sets between project versions.

A change set includes the exact underlying source modifications, but also supports derived views of:

changed prose and document structure;

changed definitions and interfaces;

changed application views;

changed execution behavior;

changed services and runtime topology;

changed dependencies and affected project areas;

validation results.

The primary review view should match the kind of thing that changed:

prose is reviewed as formatted prose with tracked changes;

document structure is reviewed in the rendered document;

code is reviewed structurally and, when needed, as exact source;

components may be reviewed through before/after live views;

project changes are reviewed through summaries and architecture views;

runtime changes may be reviewed through traces or behavior comparisons.

A textual diff is always available as the final audit layer, but should not be the only way to understand a change.

14. Diffs at every zoom level

The same change set must be visible across semantic zoom levels.

At the project level, the UI should quickly answer:

which parts of the system were directly edited;

which parts may be affected indirectly;

which user-visible features changed;

which interfaces or effects changed;

which tests or validations cover the changes.

At a subsystem or file level, it should show which contained entities changed and how they relate.

At the document or component level, it should show the actual rendered or behavioral before/after difference.

At the source level, it should show the precise source modifications.

Direct edits and inferred impact must be distinguished. An agent may touch only a few definitions while affecting many downstream views or artifacts; the UI should show both facts without conflating them.

A user must be able to move from a project-level change marker down to the exact source edit, and from a source edit back up to its architectural and behavioral impact.

15. AI-native interaction

Agents operate on the same live project model as humans.

An agent should have access to:

the visible state of the workspace;

structured information about visible objects;

source, runtime, and project structure;

available operations on selected objects;

the current project version;

recent execution and change history.

Visual input remains available so that agents can handle arbitrary rendered content, but system-native views should expose semantic structure and provenance as well.

When a user refers to something on screen—such as “this button,” “the graph above,” “that error,” or “the service on the right”—the conversation turn should carry the current selection, pointer target, focus, viewport, and relevant project references. The resolved reference should be visible to the user so that misunderstandings can be corrected.

Agents should be able to:

inspect source, rendered views, runtime values, and traces;

interact with applications in the same ways a human can;

edit source or document structure;

run and inspect the consequences of a proposed change;

navigate and reason over several files;

use project-level structure and semantic zoom;

present their work as a reviewable change set.

Agent changes must never be visible only as an unexplained rewritten file. They should appear in rendered diffs and project-level change views, with a clear path to the exact source edits.

16. Core requirements

The design should preserve the following invariants:

A single coherent project state underlies source, documents, applications, runtime inspection, and project views.

Every visible system-native object can be related to its source and runtime origin where such an origin exists.

Every persistent modification is attributable to an actor and a project version.

Every important change can be reviewed without requiring the user to begin with raw source text.

Every high-level change marker can be followed down to exact evidence and source modifications.

Directly edited entities and transitively affected entities are represented separately.

Compiler transformations and baked results are explicit source changes rather than invisible mutation.

Long-running computations and services are inspectable and tied to their source lifecycle.

Human and agent interactions use the same project semantics, permissions, and change model.

The exact source remains available and portable even though most interaction may happen through richer projections.

Updates are versioned and coherent; the UI must not silently mix unrelated source, runtime, and review states.

The system supports semantic zoom and semantic diff over the whole project, not only file-by-file navigation.

17. Intentionally open design questions

This document does not settle:

the final surface syntax for switching between document markup and code;

the relationship between Markdown, HTML, and program-constructed views;

the type system and effect system;

the exact semantics of editing generated or runtime-backed views;

the representation and ownership of baked results;

the lifecycle and hot-reload model for servers and other long-running activities;

how values are captured and transformed when producing an executable;

how much project architecture is declared by authors versus inferred by tools;

the exact UI layout and visualization used for semantic zoom;

the detailed security and capability model;

persistence and replay semantics for runtime state and external effects;

the protocol used by external agents.

These choices should be evaluated against the common model above rather than fixed prematurely.

18. Summary

The system is best understood as a live, literate, multi-file programming workspace.

Its source files combine document and program. Evaluating them creates a live project containing rendered pages, applications, services, values, and artifacts. The same environment supports editing, inspection, debugging, and executable production.

A contextual side pane provides Lean-like information at the cursor and acts as the common interface for types, runtime values, previews, traces, and debugger state.

The workspace supports semantic zoom from exact source to the whole project. Changes are first-class and can be reviewed as rendered document edits, code changes, behavioral changes, or architectural impact at every zoom level.

Agents participate in this same workspace. They can observe and operate on what humans see, understand screen references through stable project objects, and present their work as reviewable semantic change sets rather than opaque source rewrites.