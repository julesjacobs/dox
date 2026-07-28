type t = { root : string }

type snapshot = {
  version : string;
  captured_at : string;
  documents : Document.t list;
  page_index : Page_index.t;
  module_graph : Module_graph.t;
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
      let* page_index =
        Page_index.build_migrating documents
        |> Result.map_error (fun message -> Invalid message)
      in
      let module_graph = Module_graph.build page_index in
      Ok
        {
          version = version_of_documents documents;
          captured_at = Util.timestamp ();
          documents;
          page_index;
          module_graph;
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

let page snapshot module_path =
  match Page_index.find snapshot.page_index module_path with
  | Some page -> Ok page.document
  | None ->
      Error
        (Not_found (Printf.sprintf "Page module %S was not found." module_path))

let resolve_documents ?(cancelled = fun () -> false) project snapshot target =
  let documents =
    snapshot.documents
    |> List.map (fun document ->
        if String.equal document.Document.path target.Document.path then target
        else document)
  in
  let* page_index =
    Page_index.build_migrating documents
    |> Result.map_error (fun message -> Invalid message)
  in
  let target_module =
    Result.to_option (Module_path.of_source_path target.path)
  in
  let compiler_graph =
    Compiler_workspace.analyze ?target:target_module ~cancelled
      ~root:project.root
      ~version:(version_of_documents documents)
      page_index
  in
  let compiler_entry module_path =
    List.find_opt
      (fun (entry : Compiler_workspace.module_info) ->
        String.equal entry.Compiler_workspace.module_path module_path)
      compiler_graph.modules
  in
  let dependencies module_path =
    match compiler_entry module_path with
    | Some entry -> entry.uses
    | None -> []
  in
  let find path =
    if String.equal path target.Document.path then Ok target
    else document snapshot path
  in
  let rec visit visiting visited ordered path =
    if List.mem path visited then Ok (visited, ordered)
    else if List.mem path visiting then
      Error
        (Invalid
           (Printf.sprintf "The OCaml module dependency cycle includes %S." path))
    else
      let* document = find path in
      let qualified_imports =
        match Module_path.of_source_path document.path with
        | Error _ -> []
        | Ok module_path ->
            dependencies module_path
            |> List.filter_map (fun dependency ->
                Option.map
                  (fun page -> page.Page_index.source_path)
                  (Page_index.find page_index dependency))
      in
      let imports = List.sort_uniq String.compare qualified_imports in
      let rec visit_imports visited ordered = function
        | [] -> Ok (visited, ordered)
        | imported :: rest ->
            let* visited, ordered =
              visit (path :: visiting) visited ordered imported
            in
            visit_imports visited ordered rest
      in
      let* visited, ordered = visit_imports visited ordered imports in
      Ok (path :: visited, document :: ordered)
  in
  match target_module with
  | Some module_path when Option.is_none (compiler_entry module_path) ->
      Ok
        ( documents
        |> List.filter (fun document ->
            not (String.equal document.Document.path target.path))
        |> List.sort (fun left right ->
            String.compare left.Document.path right.Document.path)
        |> fun dependencies -> dependencies @ [ target ] )
  | _ ->
      let* _, reversed = visit [] [] [] target.path in
      Ok (List.rev reversed)

let read_document project path =
  match snapshot project with
  | Error error -> Error error
  | Ok snapshot -> document snapshot path

let file_summary document =
  let module_path =
    match Module_path.of_source_path document.Document.path with
    | Ok value -> value
    | Error _ -> document.path
  in
  `Assoc
    [
      ("path", `String document.Document.path);
      ("module", `String module_path);
      ("title", `String document.title);
      ("version", `String document.version);
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
      ("pageIndex", Page_index.to_json snapshot.page_index);
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

let affected_document_paths project snapshot changed_path =
  match Page_index.find_source snapshot.page_index changed_path with
  | None -> []
  | Some page ->
      let analysis =
        Compiler_workspace.analyze ~root:project.root ~version:snapshot.version
          snapshot.page_index
      in
      let rec expand known pending =
        match pending with
        | [] -> known
        | module_path :: rest ->
            let dependents =
              analysis.modules
              |> List.find_opt (fun (entry : Compiler_workspace.module_info) ->
                  String.equal entry.module_path module_path)
              |> Option.map (fun (entry : Compiler_workspace.module_info) ->
                  entry.used_by)
              |> Option.value ~default:[]
              |> List.filter (fun dependent -> not (List.mem dependent known))
            in
            expand (dependents @ known) (dependents @ rest)
      in
      expand [] [ page.module_path ]
      |> List.filter_map (fun module_path ->
          Page_index.find snapshot.page_index module_path
          |> Option.map (fun page -> page.Page_index.source_path))

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

let remove_checked path =
  try
    if Sys.file_exists path then Sys.remove path;
    if Sys.file_exists path then
      Error (Printf.sprintf "Could not remove %s." path)
    else Ok ()
  with
  | Sys_error message -> Error message
  | Unix.Unix_error (error, _, _) -> Error (Unix.error_message error)

let optional_file path =
  match Util.read_file path with
  | Ok source -> Ok (Some source)
  | Error _ when not (Sys.file_exists path) -> Ok None
  | Error message -> Error (Io message)

let restore_quarantine ~path ~quarantine source =
  match Util.write_file_atomic_if_absent path source with
  | Ok () ->
      remove_checked quarantine |> Result.map_error (fun message -> Io message)
  | Error `Changed ->
      Error
        (Conflict
           (Printf.sprintf
              "%s changed while a displaced file was being restored; the \
               displaced file remains at %s."
              path quarantine))
  | Error (`Io message) -> Error (Io message)

let quarantine_file ~path ~quarantine ~expected =
  let* () =
    Util.ensure_directory (Filename.dirname quarantine)
    |> Result.map_error (fun message -> Io message)
  in
  let* quarantined = optional_file quarantine in
  let* () =
    match quarantined with
    | Some _ -> Ok ()
    | None -> (
        try
          Unix.rename path quarantine;
          Ok ()
        with
        | Unix.Unix_error (Unix.ENOENT, _, _) ->
            Error
              (Conflict
                 (Printf.sprintf
                    "%s disappeared while the refactor was being published."
                    path))
        | Unix.Unix_error (error, _, _) -> Error (Io (Unix.error_message error))
        | Sys_error message -> Error (Io message))
  in
  let* displaced =
    match optional_file quarantine with
    | Ok (Some source) -> Ok source
    | Ok None ->
        Error
          (Io
             (Printf.sprintf "The displaced file for %s could not be read." path))
    | Error error -> Error error
  in
  if String.equal displaced expected then Ok ()
  else
    let* () = restore_quarantine ~path ~quarantine displaced in
    Error
      (Conflict
         (Printf.sprintf "%s changed while the refactor was being published."
            path))

let publish_refactor_target ~path ~quarantine ~expected ~source =
  let* current = optional_file path in
  if Option.equal String.equal current (Some source) then Ok ()
  else
    match expected with
    | None -> (
        match Util.write_file_atomic_if_absent path source with
        | Ok () -> Ok ()
        | Error `Changed ->
            Error
              (Conflict
                 (Printf.sprintf
                    "%s was created while the refactor was being published."
                    path))
        | Error (`Io message) -> Error (Io message))
    | Some expected -> (
        let* () = quarantine_file ~path ~quarantine ~expected in
        match Util.write_file_atomic_if_absent path source with
        | Ok () -> Ok ()
        | Error `Changed ->
            Error
              (Conflict
                 (Printf.sprintf
                    "%s changed after its previous contents were safely \
                     displaced to %s."
                    path quarantine))
        | Error (`Io message) -> Error (Io message))

let quarantine_refactor_deletion ~path ~quarantine ~expected =
  let* current = optional_file path in
  let* displaced = optional_file quarantine in
  match (current, displaced) with
  | None, None -> Ok ()
  | None, Some source when String.equal source expected -> Ok ()
  | None, Some _ ->
      Error
        (Conflict
           (Printf.sprintf
              "The displaced old file for %s does not match the refactor input."
              path))
  | Some _, Some _ ->
      Error
        (Conflict
           (Printf.sprintf
              "%s was recreated while its old contents were quarantined." path))
  | Some _, None -> quarantine_file ~path ~quarantine ~expected

let changes_contain project id =
  match changes project with
  | Error _ -> false
  | Ok changes ->
      List.exists
        (fun change -> Yojson.Safe.Util.member "id" change = `String id)
        changes

let recover_refactor_intent project intent intent_path =
  let open Yojson.Safe.Util in
  let entries = intent |> member "entries" |> to_list in
  let target_paths =
    entries |> List.map (fun entry -> entry |> member "targetPath" |> to_string)
  in
  let rec publish = function
    | [] -> Ok ()
    | entry :: rest ->
        let target_path = entry |> member "targetPath" |> to_string in
        let after_source = entry |> member "afterSource" |> to_string in
        let quarantine = entry |> member "targetQuarantine" |> to_string in
        let expected_before =
          match entry |> member "targetBeforeSource" with
          | `String source -> Some source
          | _ -> None
        in
        let absolute = Filename.concat project.root target_path in
        let* () =
          Util.ensure_directory (Filename.dirname absolute)
          |> Result.map_error (fun message -> Io message)
        in
        let* () =
          publish_refactor_target ~path:absolute ~quarantine
            ~expected:expected_before ~source:after_source
        in
        publish rest
  in
  let rec remove_old = function
    | [] -> Ok ()
    | entry :: rest ->
        let old_path = entry |> member "oldPath" |> to_string in
        let before_source = entry |> member "beforeSource" |> to_string in
        let quarantine = entry |> member "oldQuarantine" |> to_string in
        if List.mem old_path target_paths then remove_old rest
        else
          let absolute = Filename.concat project.root old_path in
          let* () =
            quarantine_refactor_deletion ~path:absolute ~quarantine
              ~expected:before_source
          in
          remove_old rest
  in
  let quarantines =
    entries
    |> List.concat_map (fun entry ->
        let target =
          match entry |> member "targetBeforeSource" with
          | `String _ -> [ entry |> member "targetQuarantine" |> to_string ]
          | _ -> []
        in
        target @ [ entry |> member "oldQuarantine" |> to_string ])
  in
  let rec clean = function
    | [] -> Ok ()
    | path :: rest ->
        let* () =
          remove_checked path |> Result.map_error (fun message -> Io message)
        in
        clean rest
  in
  let* () = publish entries in
  let* () = remove_old entries in
  let* () = clean quarantines in
  let quarantine_directories =
    quarantines |> List.map Filename.dirname |> List.sort_uniq String.compare
  in
  let rec remove_directories = function
    | [] -> Ok ()
    | directory :: rest ->
        let* () =
          if not (Sys.file_exists directory) then Ok ()
          else
            try
              Unix.rmdir directory;
              Ok ()
            with Unix.Unix_error (error, _, _) ->
              Error (Io (Unix.error_message error))
        in
        remove_directories rest
  in
  let* () = remove_directories quarantine_directories in
  remove_checked intent_path |> Result.map_error (fun message -> Io message)

let recover_save_intent ?(recovering = false) project intent intent_path =
  let open Yojson.Safe.Util in
  let relative = intent |> member "path" |> to_string in
  let before_source =
    match intent |> member "beforeSource" with
    | `String source -> Some source
    | _ -> None
  in
  let after_source = intent |> member "afterSource" |> to_string in
  let quarantine = intent |> member "quarantine" |> to_string in
  let absolute = Filename.concat project.root relative in
  let directory = Filename.dirname quarantine in
  let remove_directory () =
    if not (Sys.file_exists directory) then Ok ()
    else
      try
        Unix.rmdir directory;
        Ok ()
      with Unix.Unix_error (error, _, _) ->
        Error (Io (Unix.error_message error))
  in
  match
    publish_refactor_target ~path:absolute ~quarantine ~expected:before_source
      ~source:after_source
  with
  | Error error when not (Sys.file_exists quarantine) ->
      let* () = remove_directory () in
      let* () =
        remove_checked intent_path
        |> Result.map_error (fun message -> Io message)
      in
      if recovering then Ok () else Error error
  | Error error -> Error error
  | Ok () ->
      let change = intent |> member "change" in
      let* () =
        match change with
        | `Null -> Ok ()
        | change ->
            let id = change |> member "id" |> to_string in
            if changes_contain project id then Ok ()
            else append_change project change
      in
      let* () =
        remove_checked quarantine
        |> Result.map_error (fun message -> Io message)
      in
      let* () = remove_directory () in
      remove_checked intent_path |> Result.map_error (fun message -> Io message)

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
                  if Yojson.Safe.Util.member "kind" intent = `String "refactor"
                  then recover_refactor_intent project intent path
                  else if
                    Yojson.Safe.Util.member "kind" intent = `String "page-save"
                    || Yojson.Safe.Util.member "kind" intent = `String "save"
                  then recover_save_intent ~recovering:true project intent path
                  else
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
                affected_document_paths project before_snapshot path
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
              let* page_index =
                Page_index.build_migrating after_documents
                |> Result.map_error (fun message -> Invalid message)
              in
              let module_graph = Module_graph.build page_index in
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
              let quarantine_directory =
                Filename.concat (transaction_directory project) (id ^ ".files")
              in
              let quarantine =
                Filename.concat quarantine_directory "document"
              in
              let* () =
                match Util.ensure_directory quarantine_directory with
                | Ok () -> Ok ()
                | Error message -> Error (Io message)
              in
              let* () =
                match
                  Util.write_file_atomic intent_path
                    (Yojson.Safe.to_string
                       (`Assoc
                          [
                            ("kind", `String "save");
                            ("path", `String path);
                            ("beforeSource", `String before.source);
                            ("afterSource", `String source);
                            ("quarantine", `String quarantine);
                            ("change", change);
                          ]))
                with
                | Ok () -> Ok ()
                | Error message -> Error (Io message)
              in
              let* _absolute =
                match Util.safe_existing_path ~root:project.root path with
                | Ok absolute -> Ok absolute
                | Error message -> Error (Invalid message)
              in
              let* () =
                recover_save_intent project
                  (`Assoc
                     [
                       ("kind", `String "save");
                       ("path", `String path);
                       ("beforeSource", `String before.source);
                       ("afterSource", `String source);
                       ("quarantine", `String quarantine);
                       ("change", change);
                     ])
                  intent_path
              in
              Ok
                ( after,
                  change,
                  {
                    version = after_project_version;
                    captured_at = timestamp;
                    documents = after_documents;
                    page_index;
                    module_graph;
                  } ))

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
                let* page_index =
                  Page_index.build documents
                  |> Result.map_error (fun message -> Invalid message)
                in
                let module_graph = Module_graph.build page_index in
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
                let quarantine_directory =
                  Filename.concat (transaction_directory project) (id ^ ".files")
                in
                let quarantine =
                  Filename.concat quarantine_directory "document"
                in
                let intent =
                  `Assoc
                    [
                      ("kind", `String "save");
                      ("path", `String path);
                      ("beforeSource", `Null);
                      ("afterSource", `String source);
                      ("quarantine", `String quarantine);
                      ("change", change);
                    ]
                in
                let* () =
                  match Util.ensure_directory quarantine_directory with
                  | Ok () -> Ok ()
                  | Error message -> Error (Io message)
                in
                let* () =
                  match
                    Util.write_file_atomic intent_path
                      (Yojson.Safe.to_string intent)
                  with
                  | Ok () -> Ok ()
                  | Error message -> Error (Io message)
                in
                let* () =
                  Util.ensure_directory (Filename.dirname absolute)
                  |> Result.map_error (fun message -> Io message)
                in
                let* () = recover_save_intent project intent intent_path in
                Ok
                  ( document,
                    change,
                    {
                      version = project_version;
                      captured_at = timestamp;
                      documents;
                      page_index;
                      module_graph;
                    } ))

type module_rename = { before : string; after : string }

let identifier_character = function
  | 'A' .. 'Z' | 'a' .. 'z' | '0' .. '9' | '_' | '\'' -> true
  | _ -> false

let rewrite_module_paths renames source =
  let renames =
    List.sort
      (fun left right ->
        compare (String.length right.before) (String.length left.before))
      renames
  in
  let buffer = Buffer.create (String.length source + 32) in
  let rec matching index = function
    | [] -> None
    | rename :: rest ->
        let length = String.length rename.before in
        let fits = index + length <= String.length source in
        if not fits then matching index rest
        else
          let equal = String.sub source index length = rename.before in
          let before_ok =
            index = 0
            ||
            let character = source.[index - 1] in
            not (identifier_character character || character = '.')
          in
          let after_ok =
            index + length = String.length source
            ||
            let character = source.[index + length] in
            character = '.' || not (identifier_character character)
          in
          if equal && before_ok && after_ok then Some rename
          else matching index rest
  in
  let rec loop index =
    if index >= String.length source then ()
    else
      match matching index renames with
      | Some rename ->
          Buffer.add_string buffer rename.after;
          loop (index + String.length rename.before)
      | None ->
          Buffer.add_char buffer source.[index];
          loop (index + 1)
  in
  loop 0;
  Buffer.contents buffer

type ocaml_rewrite_state = {
  mutable comment_depth : int;
  mutable in_string : bool;
  mutable in_character : bool;
  mutable escaped : bool;
  mutable quoted_closing : string option;
}

let rewrite_ocaml_line renames state source =
  let renames =
    List.sort
      (fun left right ->
        compare (String.length right.before) (String.length left.before))
      renames
  in
  let buffer = Buffer.create (String.length source + 16) in
  let matching index =
    List.find_opt
      (fun rename ->
        let length = String.length rename.before in
        index + length <= String.length source
        && String.sub source index length = rename.before
        && (index = 0
           ||
           let character = source.[index - 1] in
           not (identifier_character character || character = '.'))
        && (index + length = String.length source
           ||
           let character = source.[index + length] in
           character = '.' || not (identifier_character character)))
      renames
  in
  let rec loop index =
    if index >= String.length source then ()
    else if Option.is_some state.quoted_closing then
      let closing = Option.get state.quoted_closing in
      if
        index + String.length closing <= String.length source
        && String.sub source index (String.length closing) = closing
      then (
        Buffer.add_string buffer closing;
        state.quoted_closing <- None;
        loop (index + String.length closing))
      else (
        Buffer.add_char buffer source.[index];
        loop (index + 1))
    else if state.comment_depth > 0 then
      if
        index + 1 < String.length source
        && source.[index] = '('
        && source.[index + 1] = '*'
      then (
        Buffer.add_string buffer "(*";
        state.comment_depth <- state.comment_depth + 1;
        loop (index + 2))
      else if
        index + 1 < String.length source
        && source.[index] = '*'
        && source.[index + 1] = ')'
      then (
        Buffer.add_string buffer "*)";
        state.comment_depth <- state.comment_depth - 1;
        loop (index + 2))
      else (
        Buffer.add_char buffer source.[index];
        loop (index + 1))
    else if state.in_string || state.in_character then (
      let character = source.[index] in
      Buffer.add_char buffer character;
      if state.escaped then state.escaped <- false
      else if character = '\\' then state.escaped <- true
      else if state.in_string && character = '"' then state.in_string <- false
      else if state.in_character && character = '\'' then
        state.in_character <- false;
      loop (index + 1))
    else if
      index + 1 < String.length source
      && source.[index] = '('
      && source.[index + 1] = '*'
    then (
      Buffer.add_string buffer "(*";
      state.comment_depth <- 1;
      loop (index + 2))
    else if source.[index] = '"' then (
      Buffer.add_char buffer '"';
      state.in_string <- true;
      state.escaped <- false;
      loop (index + 1))
    else if source.[index] = '{' then (
      let rec quoted_opening cursor =
        if cursor >= String.length source then None
        else if source.[cursor] = '|' then
          Some
            ( cursor + 1,
              "|" ^ String.sub source (index + 1) (cursor - index - 1) ^ "}" )
        else
          match source.[cursor] with
          | 'a' .. 'z' | '_' -> quoted_opening (cursor + 1)
          | _ -> None
      in
      match quoted_opening (index + 1) with
      | Some (next, closing) ->
          Buffer.add_substring buffer source index (next - index);
          state.quoted_closing <- Some closing;
          loop next
      | None ->
          Buffer.add_char buffer source.[index];
          loop (index + 1))
    else if
      source.[index] = '\''
      && index + 2 < String.length source
      && (source.[index + 2] = '\''
         || source.[index + 1] = '\\'
            && index + 3 < String.length source
            && source.[index + 3] = '\'')
    then (
      Buffer.add_char buffer '\'';
      state.in_character <- true;
      state.escaped <- false;
      loop (index + 1))
    else
      match matching index with
      | Some rename ->
          Buffer.add_string buffer rename.after;
          loop (index + String.length rename.before)
      | None ->
          Buffer.add_char buffer source.[index];
          loop (index + 1)
  in
  loop 0;
  Buffer.contents buffer

let rewrite_document_module_paths renames document =
  let lines = Document.lines_with_endings document.Document.source in
  let code_lines = Hashtbl.create 32 in
  List.iter
    (function
      | Document.Prose _ -> ()
      | Document.Code { source; source_line; _ } ->
          let count = List.length (Document.lines_with_endings source) in
          for line = source_line to source_line + count - 1 do
            Hashtbl.replace code_lines line ()
          done)
    document.Document.blocks;
  let references = Hashtbl.create 16 in
  List.iter
    (fun reference ->
      let current =
        Option.value ~default:[]
          (Hashtbl.find_opt references reference.Document.line)
      in
      Hashtbl.replace references reference.line (reference :: current))
    document.Document.page_references;
  let state =
    {
      comment_depth = 0;
      in_string = false;
      in_character = false;
      escaped = false;
      quoted_closing = None;
    }
  in
  lines
  |> List.mapi (fun index line ->
      let line_number = index + 1 in
      if Hashtbl.mem code_lines line_number then
        rewrite_ocaml_line renames state line
      else
        let references =
          Option.value ~default:[] (Hashtbl.find_opt references line_number)
          |> List.sort (fun left right ->
              compare right.Document.column_start left.Document.column_start)
        in
        let line =
          List.fold_left
            (fun result reference ->
              let before = reference.Document.module_path in
              let after = rewrite_module_paths renames before in
              if String.equal before after then result
              else
                let start = reference.column_start + 2 in
                String.sub result 0 start ^ after
                ^ String.sub result
                    (start + String.length before)
                    (String.length result - start - String.length before))
            line references
        in
        line)
  |> String.concat ""

let validate_module_renames snapshot renames =
  let before = List.map (fun rename -> rename.before) renames in
  let after = List.map (fun rename -> rename.after) renames in
  if renames = [] then Error (Invalid "The refactor contains no changes.")
  else if
    List.length before <> List.length (List.sort_uniq String.compare before)
  then Error (Invalid "A module can be renamed only once per transaction.")
  else if List.length after <> List.length (List.sort_uniq String.compare after)
  then Error (Invalid "Two modules cannot be renamed to the same destination.")
  else
    let rec validate = function
      | [] -> Ok ()
      | rename :: rest ->
          let* _ =
            Module_path.validate rename.before
            |> Result.map_error (fun message -> Invalid message)
          in
          let* _ =
            Module_path.validate rename.after
            |> Result.map_error (fun message -> Invalid message)
          in
          let* _ = page snapshot rename.before in
          if
            (not (List.mem rename.after before))
            && Option.is_some (Page_index.find snapshot.page_index rename.after)
          then
            Error
              (Conflict
                 (Printf.sprintf "Page module %s already exists." rename.after))
          else validate rest
    in
    validate renames

let refactor_preview_id snapshot renames =
  Util.digest
    (snapshot.version
    ^ (renames
      |> List.map (fun rename -> rename.before ^ "\x00" ^ rename.after)
      |> String.concat "\x00"))

let refactor_preview snapshot renames =
  let* () = validate_module_renames snapshot renames in
  let transformed_documents =
    snapshot.documents
    |> List.map (fun document ->
        let module_path =
          match
            Page_index.find_source snapshot.page_index document.Document.path
          with
          | Some page -> page.Page_index.module_path
          | None -> document.Document.path
        in
        let target_module =
          Option.value ~default:module_path
            (List.find_map
               (fun rename ->
                 if String.equal rename.before module_path then
                   Some rename.after
                 else None)
               renames)
        in
        Document.parse
          ~path:(Module_path.source_path target_module)
          (rewrite_document_module_paths renames document))
  in
  let* transformed_index =
    Page_index.build transformed_documents
    |> Result.map_error (fun message -> Invalid message)
  in
  let compiler_analysis =
    Compiler_workspace.analyze_unlocked transformed_index
  in
  let* () =
    if compiler_analysis.ok then Ok ()
    else
      Error
        (Invalid
           ("The refactor does not compile:\n"
           ^ String.concat "\n" compiler_analysis.diagnostics))
  in
  let rewritten =
    snapshot.documents
    |> List.filter_map (fun document ->
        let source = rewrite_document_module_paths renames document in
        let module_path =
          match
            Page_index.find_source snapshot.page_index document.Document.path
          with
          | Some page -> page.Page_index.module_path
          | None -> document.Document.path
        in
        let target_module =
          Option.value ~default:module_path
            (List.find_map
               (fun rename ->
                 if String.equal rename.before module_path then
                   Some rename.after
                 else None)
               renames)
        in
        let target_path = Module_path.source_path target_module in
        if
          String.equal source document.Document.source
          && String.equal target_path document.Document.path
        then None
        else
          Some
            (`Assoc
               [
                 ("module", `String module_path);
                 ("path", `String document.Document.path);
                 ("targetModule", `String target_module);
                 ("targetPath", `String target_path);
                 ( "sourceChanged",
                   `Bool (not (String.equal source document.Document.source)) );
               ]))
  in
  let preview_id = refactor_preview_id snapshot renames in
  Ok
    (`Assoc
       [
         ("previewId", `String preview_id);
         ("projectVersion", `String snapshot.version);
         ( "renames",
           `List
             (List.map
                (fun rename ->
                  `Assoc
                    [
                      ("before", `String rename.before);
                      ("after", `String rename.after);
                    ])
                renames) );
         ("files", `List rewritten);
       ])

let apply_module_refactor project ~expected_project_version ~expected_preview_id
    renames =
  match Util.ensure_directory (metadata_directory project) with
  | Error message -> Error (Io message)
  | Ok () ->
      Util.with_file_lock (lock_path project) (fun () ->
          let* () = recover_transactions project in
          let* snapshot = snapshot_unlocked project in
          if not (String.equal snapshot.version expected_project_version) then
            Error (Conflict "The project changed after the refactor preview.")
          else if
            not
              (String.equal expected_preview_id
                 (refactor_preview_id snapshot renames))
          then
            Error
              (Conflict
                 "The refactor request does not match the reviewed preview.")
          else
            let* preview = refactor_preview snapshot renames in
            let transformed =
              snapshot.documents
              |> List.map (fun document ->
                  let module_path =
                    match
                      Page_index.find_source snapshot.page_index
                        document.Document.path
                    with
                    | Some page -> page.Page_index.module_path
                    | None -> document.Document.path
                  in
                  let target_module =
                    Option.value ~default:module_path
                      (List.find_map
                         (fun rename ->
                           if String.equal rename.before module_path then
                             Some rename.after
                           else None)
                         renames)
                  in
                  let path = Module_path.source_path target_module in
                  let source = rewrite_document_module_paths renames document in
                  (document, path, source))
            in
            let documents =
              List.map
                (fun (_, path, source) -> Document.parse ~path source)
                transformed
            in
            let target_paths =
              List.map (fun (_, path, _) -> path) transformed
            in
            let changed =
              List.filter
                (fun (document, path, source) ->
                  (not (String.equal document.Document.path path))
                  || not (String.equal document.Document.source source))
                transformed
            in
            let* page_index =
              Page_index.build documents
              |> Result.map_error (fun message -> Invalid message)
            in
            let original_paths =
              List.map
                (fun document -> document.Document.path)
                snapshot.documents
            in
            let rec verify_inputs = function
              | [] -> Ok ()
              | (document, target_path, _) :: rest ->
                  let absolute =
                    Filename.concat project.root document.Document.path
                  in
                  let* current =
                    Util.read_file absolute
                    |> Result.map_error (fun message -> Io message)
                  in
                  if
                    not
                      (String.equal (Util.digest current)
                         document.Document.version)
                  then
                    Error
                      (Conflict
                         (Printf.sprintf
                            "%s changed while the refactor was being checked."
                            document.Document.path))
                  else if
                    (not (List.mem target_path original_paths))
                    && Sys.file_exists
                         (Filename.concat project.root target_path)
                  then
                    Error
                      (Conflict
                         (Printf.sprintf
                            "%s was created while the refactor was being \
                             checked."
                            target_path))
                  else verify_inputs rest
            in
            let* () = verify_inputs changed in
            let intent_id =
              "refactor-" ^ String.sub (Util.random_token ()) 0 24
            in
            let intent_path = transaction_path project intent_id in
            let quarantine_directory =
              Filename.concat
                (transaction_directory project)
                (intent_id ^ ".files")
            in
            let entries =
              changed
              |> List.mapi (fun index (document, target_path, source) ->
                  let target_before =
                    snapshot.documents
                    |> List.find_opt (fun candidate ->
                        String.equal candidate.Document.path target_path)
                  in
                  let target_quarantine =
                    Filename.concat quarantine_directory
                      (Printf.sprintf "%04d-target" index)
                  in
                  let old_quarantine =
                    Filename.concat quarantine_directory
                      (Printf.sprintf "%04d-old" index)
                  in
                  ( document,
                    target_path,
                    source,
                    target_before,
                    target_quarantine,
                    old_quarantine ))
            in
            let* () =
              Util.ensure_directory quarantine_directory
              |> Result.map_error (fun message -> Io message)
            in
            let intent =
              `Assoc
                [
                  ("kind", `String "refactor");
                  ("id", `String intent_id);
                  ( "entries",
                    `List
                      (List.map
                         (fun ( document,
                                target_path,
                                source,
                                target_before,
                                target_quarantine,
                                old_quarantine ) ->
                           `Assoc
                             [
                               ("oldPath", `String document.Document.path);
                               ("targetPath", `String target_path);
                               ("beforeSource", `String document.source);
                               ("afterSource", `String source);
                               ("targetQuarantine", `String target_quarantine);
                               ("oldQuarantine", `String old_quarantine);
                               ( "targetBeforeSource",
                                 Option.fold ~none:`Null
                                   ~some:(fun candidate ->
                                     `String candidate.Document.source)
                                   target_before );
                             ])
                         entries) );
                ]
            in
            let* () =
              Util.write_file_atomic intent_path (Yojson.Safe.to_string intent)
              |> Result.map_error (fun message -> Io message)
            in
            let preserve_intent error =
              let message =
                error_message error
                ^ " The refactor recovery intent was preserved."
              in
              match error with
              | Conflict _ -> Conflict message
              | Invalid _ -> Invalid message
              | Not_found _ -> Not_found message
              | Io _ -> Io message
            in
            let rec publish = function
              | [] -> Ok ()
              | (_, target_path, source, target_before, target_quarantine, _)
                :: rest ->
                  let absolute = Filename.concat project.root target_path in
                  let* () =
                    Util.ensure_directory (Filename.dirname absolute)
                    |> Result.map_error (fun message -> Io message)
                  in
                  let* () =
                    publish_refactor_target ~path:absolute
                      ~quarantine:target_quarantine
                      ~expected:
                        (Option.map
                           (fun document -> document.Document.source)
                           target_before)
                      ~source
                  in
                  publish rest
            in
            match publish entries with
            | Error error -> Error (preserve_intent error)
            | Ok () ->
                let rec remove_old = function
                  | [] -> Ok ()
                  | (document, target_path, _, _, _, old_quarantine) :: rest ->
                      if
                        String.equal document.Document.path target_path
                        || List.mem document.Document.path target_paths
                      then remove_old rest
                      else
                        let absolute =
                          Filename.concat project.root document.Document.path
                        in
                        let* () =
                          quarantine_refactor_deletion ~path:absolute
                            ~quarantine:old_quarantine ~expected:document.source
                        in
                        remove_old rest
                in
                let* () =
                  remove_old entries |> Result.map_error preserve_intent
                in
                let quarantines =
                  entries
                  |> List.concat_map
                       (fun
                         ( _,
                           _,
                           _,
                           target_before,
                           target_quarantine,
                           old_quarantine )
                       ->
                         (if Option.is_some target_before then
                            [ target_quarantine ]
                          else [])
                         @ [ old_quarantine ])
                in
                let rec clean = function
                  | [] -> Ok ()
                  | path :: rest ->
                      let* () =
                        remove_checked path
                        |> Result.map_error (fun message -> Io message)
                      in
                      clean rest
                in
                let* () =
                  clean quarantines |> Result.map_error preserve_intent
                in
                let* () =
                  (try
                     Unix.rmdir quarantine_directory;
                     Ok ()
                   with
                    | Unix.Unix_error (error, _, _) ->
                        Error (Io (Unix.error_message error))
                    | Sys_error message -> Error (Io message))
                  |> Result.map_error preserve_intent
                in
                let module_graph = Module_graph.build page_index in
                let result_snapshot =
                  {
                    version = version_of_documents documents;
                    captured_at = Util.timestamp ();
                    documents;
                    page_index;
                    module_graph;
                  }
                in
                let* () =
                  remove_checked intent_path
                  |> Result.map_error (fun message -> Io message)
                in
                Ok
                  ( preview,
                    result_snapshot,
                    `List
                      (List.map
                         (fun rename ->
                           `Assoc
                             [
                               ("before", `String rename.before);
                               ("after", `String rename.after);
                             ])
                         renames) ))

let create_page project ~module_path ~base_project_version ~principal =
  let* module_path =
    Module_path.validate module_path
    |> Result.map_error (fun message -> Invalid message)
  in
  let path = Module_path.source_path module_path in
  let source = Printf.sprintf "# %s\n\n" module_path in
  create_document project ~path ~source ~base_project_version ~principal

let save_page_source project ~module_path ~source ~expected_digest
    ~edit_revision =
  match Util.ensure_directory (metadata_directory project) with
  | Error message -> Error (Io message)
  | Ok () ->
      Util.with_file_lock (lock_path project) (fun () ->
          let* () = recover_transactions project in
          let* snapshot = snapshot_unlocked project in
          let* before = page snapshot module_path in
          if not (String.equal before.version expected_digest) then
            Error
              (Conflict
                 "The page changed outside this editor. The draft was \
                  preserved and was not written.")
          else if String.equal before.source source then
            Ok (before, snapshot, edit_revision)
          else
            let intent_id =
              "page-save-" ^ String.sub (Util.random_token ()) 0 24
            in
            let intent_path = transaction_path project intent_id in
            let quarantine_directory =
              Filename.concat
                (transaction_directory project)
                (intent_id ^ ".files")
            in
            let quarantine = Filename.concat quarantine_directory "document" in
            let intent =
              `Assoc
                [
                  ("kind", `String "page-save");
                  ("path", `String before.path);
                  ("beforeSource", `String before.source);
                  ("afterSource", `String source);
                  ("quarantine", `String quarantine);
                  ("change", `Null);
                ]
            in
            let* () =
              Util.ensure_directory quarantine_directory
              |> Result.map_error (fun message -> Io message)
            in
            let* () =
              Util.write_file_atomic intent_path (Yojson.Safe.to_string intent)
              |> Result.map_error (fun message -> Io message)
            in
            let* () = recover_save_intent project intent intent_path in
            let* saved_snapshot = snapshot_unlocked project in
            let* saved = page saved_snapshot module_path in
            Ok (saved, saved_snapshot, edit_revision))

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
        let* documents = resolve_documents project snapshot document in
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
