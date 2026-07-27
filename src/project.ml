type t = { root : string }

type snapshot = {
  version : string;
  captured_at : string;
  documents : Document.t list;
}

type error =
  | Not_found of string
  | Conflict of string
  | Invalid of string
  | Io of string

let ( let* ) = Result.bind

let error_message = function
  | Not_found message | Conflict message | Invalid message | Io message ->
      message

let create root =
  let root =
    try Unix.realpath root
    with Unix.Unix_error _ -> Filename.concat (Sys.getcwd ()) root
  in
  { root }

let metadata_directory project = Filename.concat project.root ".doclang"

let lock_path project =
  Filename.concat (metadata_directory project) "project.lock"

let document_paths project =
  Util.list_files project.root
  |> List.filter (fun path -> Util.ends_with ~suffix:".live.md" path)

let read_document_file project path =
  if not (Util.ends_with ~suffix:".live.md" path) then
    Error (Invalid "Only .live.md documents belong to the live project.")
  else
    match Util.safe_existing_path ~root:project.root path with
    | Error message -> Error (Not_found message)
    | Ok absolute -> (
        match Util.read_file absolute with
        | Ok source -> Ok (Document.parse ~path source)
        | Error message -> Error (Io message))

let version_of_documents documents =
  documents
  |> List.sort (fun left right -> String.compare left.Document.path right.path)
  |> List.map (fun document ->
      document.Document.path ^ "\x00" ^ document.version)
  |> String.concat "\x00" |> Util.digest

let snapshot_unlocked project =
  let rec read accumulator = function
    | [] -> Ok (List.rev accumulator)
    | path :: rest -> (
        match read_document_file project path with
        | Ok document -> read (document :: accumulator) rest
        | Error error -> Error error)
  in
  let rec capture attempts =
    let paths = document_paths project in
    let* documents = read [] paths in
    let current_paths = document_paths project in
    let stable_paths = paths = current_paths in
    let stable_documents =
      stable_paths
      && List.for_all
           (fun captured ->
             match read_document_file project captured.Document.path with
             | Ok current -> String.equal captured.version current.version
             | Error _ -> false)
           documents
    in
    if stable_documents then
      Ok
        {
          version = version_of_documents documents;
          captured_at = Util.timestamp ();
          documents;
        }
    else if attempts > 0 then capture (attempts - 1)
    else Error (Conflict "The project changed while a snapshot was captured.")
  in
  capture 2

let snapshot project =
  match Util.ensure_directory (metadata_directory project) with
  | Error message -> Error (Io message)
  | Ok () ->
      Util.with_file_lock (lock_path project) (fun () ->
          snapshot_unlocked project)

let document snapshot path =
  match
    List.find_opt
      (fun document -> String.equal document.Document.path path)
      snapshot.documents
  with
  | Some document -> Ok document
  | None -> Error (Not_found (Printf.sprintf "Document %S was not found." path))

let resolve_documents snapshot target =
  let find path =
    if String.equal path target.Document.path then Ok target
    else document snapshot path
  in
  let rec visit visiting visited ordered path =
    if List.mem path visited then Ok (visited, ordered)
    else if List.mem path visiting then
      Error (Invalid (Printf.sprintf "Document import cycle includes %S." path))
    else
      let* document = find path in
      let rec visit_imports visited ordered = function
        | [] -> Ok (visited, ordered)
        | imported :: rest ->
            let* visited, ordered =
              visit (path :: visiting) visited ordered imported
            in
            visit_imports visited ordered rest
      in
      let* visited, ordered = visit_imports visited ordered document.imports in
      Ok (path :: visited, document :: ordered)
  in
  let* _, reversed = visit [] [] [] target.path in
  Ok (List.rev reversed)

let read_document project path =
  match snapshot project with
  | Error error -> Error error
  | Ok snapshot -> document snapshot path

let file_summary document =
  `Assoc
    [
      ("path", `String document.Document.path);
      ("title", `String document.title);
      ("version", `String document.version);
      ("imports", `List (List.map (fun path -> `String path) document.imports));
      ("definitions", `Int (List.length document.definitions));
      ( "outline",
        `List
          (List.map
             (fun definition ->
               `Assoc
                 [
                   ("name", `String definition.Document.name);
                   ("kind", `String definition.kind);
                   ("line", `Int definition.line);
                   ( "references",
                     `List
                       (List.map
                          (fun name -> `String name)
                          definition.references) );
                 ])
             document.definitions) );
      ("issues", `List (List.map Document.issue_to_json document.issues));
    ]

let manifest_files root =
  if not (Sys.file_exists root) then []
  else
    Util.list_files root
    |> List.filter (fun path -> Filename.basename path = "manifest.json")

let artifacts project =
  let root = Filename.concat project.root "_artifacts" in
  manifest_files root
  |> List.filter_map (fun relative ->
      match Util.read_file (Filename.concat root relative) with
      | Error _ -> None
      | Ok source -> (
          try Some (Yojson.Safe.from_string source)
          with Yojson.Json_error _ -> None))

let snapshot_to_json project snapshot =
  `Assoc
    [
      ("root", `String project.root);
      ("version", `String snapshot.version);
      ("capturedAt", `String snapshot.captured_at);
      ("documents", `List (List.map file_summary snapshot.documents));
      ("documentCount", `Int (List.length snapshot.documents));
      ("artifacts", `List (artifacts project));
    ]

let to_json project =
  match snapshot project with
  | Ok snapshot -> Ok (snapshot_to_json project snapshot)
  | Error error -> Error error

let source_by_block document =
  document.Document.blocks
  |> List.map (function
    | Document.Prose { id; source; _ } -> (id, "prose", source)
    | Document.Code { id; source; kind; _ } ->
        ( id,
          (match kind with
          | Document.Program -> "ocaml"
          | Document.Example -> "ocaml-example"),
          source ))

let changed_blocks before after =
  let before_blocks = source_by_block before in
  let after_blocks = source_by_block after in
  let ids =
    List.map (fun (id, _, _) -> id) (before_blocks @ after_blocks)
    |> List.sort_uniq String.compare
  in
  ids
  |> List.filter_map (fun id ->
      let before_block =
        List.find_opt
          (fun (candidate, _, _) -> String.equal candidate id)
          before_blocks
      in
      let after_block =
        List.find_opt
          (fun (candidate, _, _) -> String.equal candidate id)
          after_blocks
      in
      if before_block = after_block then None
      else
        let kind =
          match (after_block, before_block) with
          | Some (_, kind, _), _ | None, Some (_, kind, _) -> kind
          | None, None -> "unknown"
        in
        Some
          (`Assoc
             [
               ("id", `String id);
               ("kind", `String kind);
               ( "change",
                 `String
                   (match (before_block, after_block) with
                   | None, Some _ -> "added"
                   | Some _, None -> "removed"
                   | _ -> "modified") );
             ]))

let definition_sources (document : Document.t) =
  let source_for_definition (definition : Document.definition) =
    document.Document.blocks
    |> List.find_map (function
      | Document.Prose _ -> None
      | Document.Code { id; source; source_line; _ }
        when String.equal id definition.Document.block_id ->
          let lines = String.split_on_char '\n' source |> Array.of_list in
          let offset = definition.line - source_line in
          let next_line =
            match
              document.definitions
              |> List.filter_map (fun (candidate : Document.definition) ->
                  if
                    String.equal candidate.Document.block_id id
                    && candidate.line > definition.line
                  then Some candidate.line
                  else None)
              |> List.sort Int.compare
            with
            | line :: _ -> Some line
            | [] -> None
          in
          let end_offset =
            match next_line with
            | Some line -> line - source_line
            | None -> Array.length lines
          in
          if offset < 0 || end_offset < offset then Some ""
          else
            Some
              (Array.sub lines offset (end_offset - offset)
              |> Array.to_list |> String.concat "\n")
      | Document.Code _ -> None)
  in
  document.Document.definitions
  |> List.map (fun (definition : Document.definition) ->
      ( definition.name,
        Option.value ~default:"" (source_for_definition definition) ))

let changed_definition_names before after =
  let before_sources = definition_sources before in
  let after_sources = definition_sources after in
  let names =
    List.map fst (before_sources @ after_sources)
    |> List.sort_uniq String.compare
  in
  names
  |> List.filter (fun name ->
      List.assoc_opt name before_sources <> List.assoc_opt name after_sources)

let affected_definition_names before after direct =
  let all_definitions =
    before.Document.definitions @ after.Document.definitions
  in
  let rec expand known =
    let newly_affected =
      all_definitions
      |> List.filter_map (fun (definition : Document.definition) ->
          if List.mem definition.Document.name known then None
          else if
            List.exists
              (fun reference -> List.mem reference known)
              definition.references
          then Some definition.name
          else None)
      |> List.sort_uniq String.compare
    in
    if newly_affected = [] then known
    else expand (List.sort_uniq String.compare (known @ newly_affected))
  in
  expand direct
  |> List.filter (fun name -> not (List.mem name direct))
  |> List.sort_uniq String.compare

let affected_document_paths documents changed_path =
  let rec expand known =
    let newly_affected =
      documents
      |> List.filter_map (fun document ->
          if List.mem document.Document.path known then None
          else if
            List.exists
              (fun imported -> List.mem imported known)
              document.imports
          then Some document.path
          else None)
      |> List.sort_uniq String.compare
    in
    if newly_affected = [] then known
    else expand (List.sort_uniq String.compare (known @ newly_affected))
  in
  expand [ changed_path ]
  |> List.filter (fun path -> not (String.equal path changed_path))

let object_key source =
  Printf.sprintf "%s-%d" (Util.digest source) (String.length source)

let object_path project key =
  Filename.concat (Filename.concat (metadata_directory project) "objects") key

let store_object project source =
  let key = object_key source in
  let path = object_path project key in
  match Util.ensure_directory (Filename.dirname path) with
  | Error message -> Error (Io message)
  | Ok () -> (
      if Sys.file_exists path then Ok key
      else
        match Util.write_file_atomic path source with
        | Ok () -> Ok key
        | Error message -> Error (Io message))

let read_object project key =
  match Util.read_file (object_path project key) with
  | Ok source -> Ok source
  | Error message -> Error (Io message)

let journal_path project =
  Filename.concat (metadata_directory project) "changes.jsonl"

let journal_contents project =
  let path = journal_path project in
  if not (Sys.file_exists path) then Ok ""
  else
    match Util.read_file path with
    | Ok contents -> Ok contents
    | Error message -> Error (Io message)

let append_change project change =
  match Util.ensure_directory (metadata_directory project) with
  | Error message -> Error (Io message)
  | Ok () -> (
      match journal_contents project with
      | Error error -> Error error
      | Ok existing -> (
          let next = existing ^ Yojson.Safe.to_string change ^ "\n" in
          match Util.write_file_atomic (journal_path project) next with
          | Ok () -> Ok ()
          | Error message -> Error (Io message)))

let changes project =
  match journal_contents project with
  | Error error -> Error error
  | Ok contents ->
      let rec parse line_number accumulator = function
        | [] -> Ok (List.rev accumulator)
        | line :: rest when String.equal (String.trim line) "" ->
            parse (line_number + 1) accumulator rest
        | line :: rest -> (
            try
              parse (line_number + 1)
                (Yojson.Safe.from_string line :: accumulator)
                rest
            with Yojson.Json_error message ->
              Error
                (Io
                   (Printf.sprintf "Change journal is corrupt at line %d: %s"
                      line_number message)))
      in
      parse 1 [] (String.split_on_char '\n' contents) |> Result.map List.rev

let change_by_id project id =
  match changes project with
  | Error error -> Error error
  | Ok changes -> (
      match
        List.find_opt
          (fun change -> Yojson.Safe.Util.member "id" change = `String id)
          changes
      with
      | None -> Error (Not_found "Change set was not found.")
      | Some change ->
          let before_key =
            Yojson.Safe.Util.member "beforeObject" change
            |> Yojson.Safe.Util.to_string
          in
          let after_key =
            Yojson.Safe.Util.member "afterObject" change
            |> Yojson.Safe.Util.to_string
          in
          Result.bind (read_object project before_key) (fun before_source ->
              Result.map
                (fun after_source ->
                  `Assoc
                    [
                      ("change", change);
                      ("beforeSource", `String before_source);
                      ("afterSource", `String after_source);
                    ])
                (read_object project after_key)))

let transaction_directory project =
  Filename.concat (metadata_directory project) "transactions"

let transaction_path project id =
  Filename.concat (transaction_directory project) (id ^ ".json")

let remove_if_exists path = try Sys.remove path with Sys_error _ -> ()

let changes_contain project id =
  match changes project with
  | Error _ -> false
  | Ok changes ->
      List.exists
        (fun change -> Yojson.Safe.Util.member "id" change = `String id)
        changes

let recover_transactions project =
  let directory = transaction_directory project in
  if not (Sys.file_exists directory) then Ok ()
  else
    let intents =
      Sys.readdir directory |> Array.to_list
      |> List.filter (fun name -> Util.ends_with ~suffix:".json" name)
    in
    let rec recover = function
      | [] -> Ok ()
      | name :: rest ->
          let path = Filename.concat directory name in
          let result =
            match Util.read_file path with
            | Error message -> Error (Io message)
            | Ok contents -> (
                try
                  let intent = Yojson.Safe.from_string contents in
                  let change = Yojson.Safe.Util.member "change" intent in
                  let id =
                    Yojson.Safe.Util.member "id" change
                    |> Yojson.Safe.Util.to_string
                  in
                  let relative =
                    Yojson.Safe.Util.member "path" change
                    |> Yojson.Safe.Util.to_string
                  in
                  let after_version =
                    Yojson.Safe.Util.member "afterVersion" change
                    |> Yojson.Safe.Util.to_string
                  in
                  let is_creation =
                    Yojson.Safe.Util.member "beforeVersion" change = `Null
                  in
                  match read_document_file project relative with
                  | Ok current when String.equal current.version after_version
                    ->
                      let committed =
                        if changes_contain project id then Ok ()
                        else append_change project change
                      in
                      Result.map (fun () -> remove_if_exists path) committed
                  | Ok _ ->
                      remove_if_exists path;
                      Ok ()
                  | Error (Not_found _) when is_creation ->
                      remove_if_exists path;
                      Ok ()
                  | Error error -> Error error
                with Yojson.Json_error message ->
                  Error (Io ("Transaction record is corrupt: " ^ message)))
          in
          Result.bind result (fun () -> recover rest)
    in
    recover intents

let replace_document documents replacement =
  documents
  |> List.map (fun document ->
      if String.equal document.Document.path replacement.Document.path then
        replacement
      else document)

let validation_summary validation =
  `Assoc
    [
      ("ok", `Bool validation.Evaluator.ok);
      ("status", `String validation.status);
      ("evaluationId", `String validation.evaluation_id);
      ("durationMs", `Int validation.duration_ms);
      ( "diagnostics",
        `List (List.map Evaluator.diagnostic_to_json validation.diagnostics) );
    ]

let save_document project ~path ~source ~base_version ~base_project_version
    ~principal ~validation =
  match Util.ensure_directory (metadata_directory project) with
  | Error message -> Error (Io message)
  | Ok () ->
      Util.with_file_lock (lock_path project) (fun () ->
          let* () = recover_transactions project in
          let* before_snapshot = snapshot_unlocked project in
          if not (String.equal before_snapshot.version base_project_version)
          then
            Error
              (Conflict "The project changed after this edit session began.")
          else
            let* before = document before_snapshot path in
            if not (String.equal before.version base_version) then
              Error (Conflict "The document changed after it was opened.")
            else if String.equal before.source source then
              Error (Invalid "There are no source changes to save.")
            else
              let after = Document.parse ~path source in
              let timestamp = Util.timestamp () in
              let direct = changed_definition_names before after in
              let affected = affected_definition_names before after direct in
              let affected_documents =
                affected_document_paths before_snapshot.documents path
              in
              let changed_blocks = changed_blocks before after in
              let prose_changed =
                List.exists
                  (fun json ->
                    Yojson.Safe.Util.member "kind" json = `String "prose")
                  changed_blocks
              in
              let after_documents =
                replace_document before_snapshot.documents after
              in
              let after_project_version =
                version_of_documents after_documents
              in
              let* before_object = store_object project before.source in
              let* after_object = store_object project after.source in
              let id =
                Util.digest
                  (before_snapshot.version ^ after_project_version ^ timestamp
                 ^ principal)
              in
              let change =
                `Assoc
                  [
                    ("id", `String id);
                    ("timestamp", `String timestamp);
                    ("principal", `String principal);
                    ("path", `String path);
                    ("projectBeforeVersion", `String before_snapshot.version);
                    ("projectAfterVersion", `String after_project_version);
                    ("beforeVersion", `String before.version);
                    ("afterVersion", `String after.version);
                    ("beforeObject", `String before_object);
                    ("afterObject", `String after_object);
                    ( "directEntities",
                      `List (List.map (fun name -> `String name) direct) );
                    ( "affectedEntities",
                      `List (List.map (fun name -> `String name) affected) );
                    ( "affectedDocuments",
                      `List
                        (List.map
                           (fun affected_path -> `String affected_path)
                           affected_documents) );
                    ("changedBlocks", `List changed_blocks);
                    ("proseChanged", `Bool prose_changed);
                    ( "sourceDiff",
                      Diff.to_json (Diff.compute before.source after.source) );
                    ("validation", validation_summary validation);
                  ]
              in
              let intent_path = transaction_path project id in
              let* () =
                match Util.ensure_directory (transaction_directory project) with
                | Ok () -> Ok ()
                | Error message -> Error (Io message)
              in
              let* () =
                match
                  Util.write_file_atomic intent_path
                    (Yojson.Safe.to_string (`Assoc [ ("change", change) ]))
                with
                | Ok () -> Ok ()
                | Error message -> Error (Io message)
              in
              let* absolute =
                match Util.safe_existing_path ~root:project.root path with
                | Ok absolute -> Ok absolute
                | Error message -> Error (Invalid message)
              in
              match
                Util.write_file_atomic_if_digest absolute
                  ~expected:before.version source
              with
              | Error `Changed ->
                  remove_if_exists intent_path;
                  Error
                    (Conflict
                       "The document changed immediately before the save \
                        commit.")
              | Error (`Io message) ->
                  remove_if_exists intent_path;
                  Error (Io message)
              | Ok () -> (
                  match append_change project change with
                  | Ok () ->
                      remove_if_exists intent_path;
                      Ok
                        ( after,
                          change,
                          {
                            version = after_project_version;
                            captured_at = timestamp;
                            documents = after_documents;
                          } )
                  | Error journal_error -> (
                      match
                        Util.write_file_atomic_if_digest absolute
                          ~expected:after.version before.source
                      with
                      | Ok () ->
                          remove_if_exists intent_path;
                          Error journal_error
                      | Error (`Changed | `Io _) ->
                          remove_if_exists intent_path;
                          Error journal_error)))

let create_document project ~path ~source ~base_project_version ~principal =
  if not (Util.ends_with ~suffix:".live.md" path) then
    Error (Invalid "New documents must end in .live.md.")
  else
    match Util.ensure_directory (metadata_directory project) with
    | Error message -> Error (Io message)
    | Ok () ->
        Util.with_file_lock (lock_path project) (fun () ->
            let* () = recover_transactions project in
            let* before_snapshot = snapshot_unlocked project in
            if not (String.equal before_snapshot.version base_project_version)
            then Error (Conflict "The project changed before creation.")
            else
              let* absolute =
                match Util.safe_new_path ~root:project.root path with
                | Ok absolute -> Ok absolute
                | Error message -> Error (Invalid message)
              in
              if Sys.file_exists absolute then
                Error (Conflict "A document already exists at that path.")
              else
                let document = Document.parse ~path source in
                let documents = document :: before_snapshot.documents in
                let project_version = version_of_documents documents in
                let* before_object = store_object project "" in
                let* after_object = store_object project source in
                let timestamp = Util.timestamp () in
                let id =
                  Util.digest (path ^ document.version ^ timestamp ^ principal)
                in
                let change =
                  `Assoc
                    [
                      ("id", `String id);
                      ("timestamp", `String timestamp);
                      ("principal", `String principal);
                      ("path", `String path);
                      ("projectBeforeVersion", `String before_snapshot.version);
                      ("projectAfterVersion", `String project_version);
                      ("beforeVersion", `Null);
                      ("afterVersion", `String document.version);
                      ("beforeObject", `String before_object);
                      ("afterObject", `String after_object);
                      ("directEntities", `List []);
                      ("affectedEntities", `List []);
                      ("affectedDocuments", `List []);
                      ( "changedBlocks",
                        `List
                          [
                            `Assoc
                              [
                                ("id", `String "document");
                                ("kind", `String "document");
                                ("change", `String "added");
                              ];
                          ] );
                      ("proseChanged", `Bool true);
                      ("sourceDiff", Diff.to_json (Diff.compute "" source));
                    ]
                in
                let intent_path = transaction_path project id in
                let* () =
                  match
                    Util.ensure_directory (transaction_directory project)
                  with
                  | Ok () -> Ok ()
                  | Error message -> Error (Io message)
                in
                let* () =
                  match
                    Util.write_file_atomic intent_path
                      (Yojson.Safe.to_string (`Assoc [ ("change", change) ]))
                  with
                  | Ok () -> Ok ()
                  | Error message -> Error (Io message)
                in
                match Util.write_file_atomic absolute source with
                | Error message ->
                    remove_if_exists intent_path;
                    Error (Io message)
                | Ok () -> (
                    match append_change project change with
                    | Ok () ->
                        remove_if_exists intent_path;
                        Ok
                          ( document,
                            change,
                            {
                              version = project_version;
                              captured_at = timestamp;
                              documents;
                            } )
                    | Error error ->
                        remove_if_exists absolute;
                        remove_if_exists intent_path;
                        Error error))

let valid_name value = Str.string_match (Str.regexp "^[A-Za-z0-9_-]+$") value 0

let valid_entry value =
  Str.string_match (Str.regexp "^[a-z_][A-Za-z0-9_']*$") value 0

let remove_tree root =
  let rec remove path =
    match (Unix.lstat path).st_kind with
    | Unix.S_DIR ->
        Sys.readdir path
        |> Array.iter (fun name -> remove (Filename.concat path name));
        Unix.rmdir path
    | _ -> Sys.remove path
  in
  if Sys.file_exists root then
    try remove root with Unix.Unix_error _ | Sys_error _ -> ()

let build_artifact project ~path ~entry ~name ~expected_project_version
    ~expected_document_version ~principal =
  if not (valid_name name) then
    Error
      (Invalid "Artifact name may contain only letters, digits, '_' and '-'.")
  else if not (valid_entry entry) then
    Error (Invalid "Entry must be an OCaml value name.")
  else
    let* snapshot = snapshot project in
    if not (String.equal snapshot.version expected_project_version) then
      Error (Conflict "The project changed before the artifact build.")
    else
      let* document = document snapshot path in
      if not (String.equal document.version expected_document_version) then
        Error (Conflict "The document changed before the artifact build.")
      else
        let* documents = resolve_documents snapshot document in
        let evaluation =
          Evaluator.evaluate_documents ~project_version:snapshot.version
            ~documents ~target:document ()
        in
        if not evaluation.ok then
          Error
            (Invalid
               (Printf.sprintf "Artifact validation failed with status %S."
                  evaluation.status))
        else
          let entry_type =
            List.find_opt
              (fun (binding : Evaluator.binding) ->
                String.equal binding.Evaluator.name entry)
              evaluation.bindings
          in
          match entry_type with
          | None ->
              Error
                (Invalid (Printf.sprintf "Entry value %S was not found." entry))
          | Some binding when not (String.equal binding.type_ "unit -> unit") ->
              Error
                (Invalid
                   (Printf.sprintf
                      "Entry %S has type %s; artifacts require unit -> unit."
                      entry binding.type_))
          | Some _ -> (
              let artifact_id =
                Util.digest
                  (snapshot.version
                  ^ (documents
                    |> List.map (fun document -> document.Document.version)
                    |> String.concat ":")
                  ^ entry
                  ^ Evaluator.artifact_builder_identity ())
              in
              let artifacts_root = Filename.concat project.root "_artifacts" in
              let name_root = Filename.concat artifacts_root name in
              let final_directory = Filename.concat name_root artifact_id in
              let manifest_path =
                Filename.concat final_directory "manifest.json"
              in
              if Sys.file_exists manifest_path then
                match Util.read_file manifest_path with
                | Ok source -> (
                    try Ok (Yojson.Safe.from_string source)
                    with Yojson.Json_error message -> Error (Io message))
                | Error message -> Error (Io message)
              else
                let* () =
                  match Util.ensure_directory name_root with
                  | Ok () -> Ok ()
                  | Error message -> Error (Io message)
                in
                let staging =
                  Filename.temp_dir ~temp_dir:name_root ".doclang-artifact-" ""
                in
                let output = Filename.concat staging name in
                match
                  Evaluator.build_artifact_documents ~documents ~entry ~output
                with
                | Error message ->
                    remove_tree staging;
                    Error (Invalid message)
                | Ok (source_path, build_log) -> (
                    let executable_source =
                      Result.value ~default:"" (Util.read_file output)
                    in
                    let manifest =
                      `Assoc
                        [
                          ("id", `String artifact_id);
                          ("name", `String name);
                          ("entry", `String entry);
                          ("principal", `String principal);
                          ("sourceDocument", `String path);
                          ( "dependencyDocuments",
                            `List
                              (List.map
                                 (fun dependency ->
                                   `Assoc
                                     [
                                       ("path", `String dependency.Document.path);
                                       ("version", `String dependency.version);
                                     ])
                                 documents) );
                          ("documentVersion", `String document.version);
                          ("projectVersion", `String snapshot.version);
                          ("createdAt", `String (Util.timestamp ()));
                          ("compiler", `String (Evaluator.compiler_identity ()));
                          ( "builderIdentity",
                            `String (Evaluator.artifact_builder_identity ()) );
                          ( "artifactDigest",
                            `String (Util.digest executable_source) );
                          ( "executable",
                            `String
                              (Filename.concat
                                 (Filename.concat name artifact_id)
                                 name) );
                          ( "generatedSource",
                            `String
                              (Filename.concat
                                 (Filename.concat name artifact_id)
                                 (Filename.basename source_path)) );
                          ("buildLog", `String build_log);
                        ]
                    in
                    match
                      Util.write_file
                        (Filename.concat staging "manifest.json")
                        (Yojson.Safe.pretty_to_string manifest ^ "\n")
                    with
                    | Error message ->
                        remove_tree staging;
                        Error (Io message)
                    | Ok () -> (
                        try
                          Unix.rename staging final_directory;
                          Ok manifest
                        with Unix.Unix_error (error, _, _) ->
                          remove_tree staging;
                          Error (Io (Unix.error_message error)))))
