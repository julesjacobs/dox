function modules(rows) {
  return rows.flatMap((row) => {
    const modulePath = row.targetModule || row.pageModule;
    return modulePath ? [modulePath] : [];
  });
}

export function remapModule(modulePath, mapping = []) {
  if (!modulePath) return modulePath;
  for (const { before, after } of mapping) {
    if (modulePath === before) return after;
    if (modulePath.startsWith(`${before}.`)) {
      return after + modulePath.slice(before.length);
    }
  }
  return modulePath;
}

export function deriveOutlineOperation({
  committedRows,
  draftRows,
  openModule = null,
}) {
  const previous = modules(committedRows);
  const next = modules(draftRows);
  const renames = draftRows
    .filter(
      (row) =>
        row.originTarget &&
        row.targetModule &&
        row.originTarget !== row.targetModule,
    )
    .map((row) => ({ before: row.originTarget, after: row.targetModule }));
  const retainedOrigins = new Set(
    draftRows.flatMap((row) => (row.originTarget ? [row.originTarget] : [])),
  );
  const deleted = previous.filter(
    (modulePath) => !retainedOrigins.has(modulePath),
  );
  const created = draftRows.flatMap((row) =>
    !row.originTarget && row.targetModule ? [row.targetModule] : [],
  );
  const orderChanged =
    previous.length !== next.length ||
    previous.some((modulePath, index) => modulePath !== next[index]);

  if (!created.length && !renames.length && !deleted.length && !orderChanged) {
    return { kind: "none", previous, order: next, openModule };
  }
  const mutationKinds = [created, renames, deleted].filter(
    (items) => items.length,
  ).length;
  if (mutationKinds > 1) {
    return {
      kind: "ambiguous",
      previous,
      order: next,
      created,
      renames,
      deleted,
      openModule,
    };
  }
  if (deleted.length) {
    return { kind: "delete", previous, order: next, deleted, openModule };
  }
  if (created.length) {
    return {
      kind: "create",
      previous,
      order: next,
      created,
      openModule,
    };
  }
  if (renames.length) {
    return {
      kind: "refactor",
      previous,
      order: next,
      renames,
      openModule: remapModule(openModule, renames),
    };
  }
  return { kind: "reorder", previous, order: next, openModule };
}

export function selectedWorkspaceInvariant({
  selectedPage,
  routePage,
  outlinePage,
  sessionPage,
}) {
  const values = [selectedPage, routePage, outlinePage, sessionPage].filter(
    (value) => value !== null && value !== undefined,
  );
  return values.length < 2 || values.every((value) => value === values[0]);
}
