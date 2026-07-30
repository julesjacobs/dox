# Project

A small two-page project demonstrating that Dox pages are real OCaml modules.

- [[Project.Dataset]] defines typed source data.
- [[Project.Analysis]] imports it, derives statistics, and renders a report.

Use go-to-definition on `Project.Dataset.readings` from the analysis page to
cross the document boundary. The context pane also shows the compiler-derived
dependency between the pages.
