type module_info = {
  module_path : string;
  uses : string list;
  used_by : string list;
}

type t = {
  ok : bool;
  compiler : string;
  diagnostics : string list;
  modules : module_info list;
}

type generated_page = {
  module_path : string;
  source_path : string;
  generated_path : string;
  source : string;
}

type described_page = { page : generated_page; cmt : string }
type sexp = Atom of string | List of sexp list

let ( let* ) = Result.bind

let tool next_to_compiler fallback =
  let candidate =
    Filename.concat (Filename.dirname (Evaluator.compiler ())) next_to_compiler
  in
  if Sys.file_exists candidate then candidate else fallback

let source_for page =
  "open Doclang_prelude\n"
  ^ Document.compilation_source page.Page_index.document

let generated_path module_path =
  Module_path.split module_path
  |> List.map Module_path.uncapitalize_component
  |> String.concat "/"
  |> fun path -> path ^ ".ml"

let generated_pages index =
  index.Page_index.pages
  |> List.map (fun page ->
      {
        module_path = page.Page_index.module_path;
        source_path = page.source_path;
        generated_path = generated_path page.module_path;
        source = source_for page;
      })

let reverse modules =
  modules
  |> List.map (fun (entry : module_info) ->
      let used_by =
        modules
        |> List.filter_map (fun (candidate : module_info) ->
            if List.mem entry.module_path candidate.uses then
              Some candidate.module_path
            else None)
        |> List.sort_uniq String.compare
      in
      { entry with used_by })

let internal_owner module_path =
  let rec before_internal prefix = function
    | [] -> None
    | "Internal" :: _ ->
        if prefix = [] then Some ""
        else Some (String.concat "." (List.rev prefix))
    | component :: rest -> before_internal (component :: prefix) rest
  in
  before_internal [] (String.split_on_char '.' module_path)

let internal_violations modules =
  modules
  |> List.concat_map (fun (entry : module_info) ->
      match internal_owner entry.module_path with
      | None | Some "" -> []
      | Some owner ->
          entry.used_by
          |> List.filter_map (fun user ->
              if Module_path.is_beneath ~namespace:owner user then None
              else
                Some
                  (Printf.sprintf
                     "%s is below %s.Internal and cannot be used by %s."
                     entry.module_path owner user)))

let workspace root = Filename.concat root ".doclang/dune-workspace"
let pages_directory root = Filename.concat (workspace root) "pages"
let manifest_path root = Filename.concat (workspace root) "manifest.json"
let watcher_log_path root = Filename.concat (workspace root) "watcher.log"
let watcher_pid_path root = Filename.concat (workspace root) "watcher.pid"

let watcher_identity_path root =
  Filename.concat (workspace root) "watcher-identity.json"

let dune_project =
  "(lang dune 3.12)\n(name doclang_workspace)\n(generate_opam_files false)\n"

let pages_dune =
  {|(include_subdirs qualified)

(library
 (name doclang_pages)
 (wrapped false)
 (modes byte)
 (flags (:standard -w -33))
 (libraries doclang_support))
|}

let support_dune =
  {|(library
 (name doclang_support)
 (wrapped false)
 (modes byte))
|}

let write_if_changed path contents =
  match Util.read_file path with
  | Ok current when String.equal current contents -> Ok ()
  | _ -> Util.write_file_atomic path contents

let ensure_plain_directory path =
  try
    match (Unix.lstat path).st_kind with
    | Unix.S_DIR -> Ok ()
    | Unix.S_LNK ->
        Error ("Refusing to use a symlinked compiler directory: " ^ path)
    | _ -> Error ("Compiler workspace path is not a directory: " ^ path)
  with
  | Unix.Unix_error (Unix.ENOENT, _, _) -> (
      try
        Unix.mkdir path 0o700;
        Ok ()
      with Unix.Unix_error (code, operation, argument) ->
        Error
          (Printf.sprintf "%s(%s): %s" operation argument
             (Unix.error_message code)))
  | Unix.Unix_error (code, operation, argument) ->
      Error
        (Printf.sprintf "%s(%s): %s" operation argument
           (Unix.error_message code))

let ensure_workspace_directories root =
  let open Result in
  let metadata = Filename.concat root ".doclang" in
  let directory = workspace root in
  let pages = pages_directory root in
  let support = Filename.concat directory "support" in
  let* () = ensure_plain_directory metadata in
  let* () = ensure_plain_directory directory in
  let* () = ensure_plain_directory pages in
  let* () = ensure_plain_directory support in
  Ok ()

let ensure_generated_parent root relative =
  let rec loop current = function
    | [] | [ _ ] -> Ok ()
    | component :: rest ->
        let next = Filename.concat current component in
        let* () = ensure_plain_directory next in
        loop next rest
  in
  loop (pages_directory root) (String.split_on_char '/' relative)

let reject_symlink path =
  try
    match (Unix.lstat path).st_kind with
    | Unix.S_LNK ->
        Error ("Refusing to follow a compiler-workspace symlink: " ^ path)
    | _ -> Ok ()
  with
  | Unix.Unix_error (Unix.ENOENT, _, _) -> Ok ()
  | Unix.Unix_error (code, operation, argument) ->
      Error
        (Printf.sprintf "%s(%s): %s" operation argument
           (Unix.error_message code))

let write_generated_file path contents =
  let* () = reject_symlink path in
  write_if_changed path contents

let rec remove_tree path =
  if Sys.file_exists path then
    match (Unix.lstat path).st_kind with
    | Unix.S_DIR ->
        Sys.readdir path
        |> Array.iter (fun name -> remove_tree (Filename.concat path name));
        Unix.rmdir path
    | _ -> Sys.remove path

let rec remove_empty_parents ~stop path =
  if String.equal path stop then ()
  else
    try
      if Array.length (Sys.readdir path) = 0 then (
        Unix.rmdir path;
        remove_empty_parents ~stop (Filename.dirname path))
    with Sys_error _ | Unix.Unix_error _ -> ()

let safe_generated_file value =
  Filename.is_relative value
  && Util.ends_with ~suffix:".ml" value
  && String.split_on_char '/' value
     |> List.for_all (fun component ->
         not
           (String.equal component "" || String.equal component "."
           || String.equal component ".."))

let old_generated_files root =
  match Util.read_file (manifest_path root) with
  | Error _ -> []
  | Ok source -> (
      try
        Yojson.Safe.from_string source
        |> Yojson.Safe.Util.member "files"
        |> Yojson.Safe.Util.to_list
        |> List.filter_map (function
          | `String value when safe_generated_file value -> Some value
          | `String _ -> None
          | _ -> None)
      with Yojson.Json_error _ | Yojson.Safe.Util.Type_error _ -> [])

let compiler_path_environment () =
  let directory = Filename.dirname (Evaluator.compiler ()) in
  let current = Option.value ~default:"" (Sys.getenv_opt "PATH") in
  [ ("PATH", directory ^ ":" ^ current) ]

let dune_version_value =
  lazy
    (let result =
       Evaluator.run_process ~timeout_seconds:2. ~output_limit:16_384
         ~environment:(compiler_path_environment ())
         "dune" [ "--version" ]
     in
     if Evaluator.successful result.status then String.trim result.stdout
     else "unavailable")

let dune_version () = Lazy.force dune_version_value

let sync root pages =
  let directory = workspace root in
  let pages_root = pages_directory root in
  let support = Filename.concat directory "support" in
  let open Result in
  let* () = ensure_workspace_directories root in
  let* () =
    write_generated_file (Filename.concat directory "dune-project") dune_project
  in
  let* () =
    write_generated_file (Filename.concat pages_root "dune") pages_dune
  in
  let* () =
    write_generated_file (Filename.concat support "dune") support_dune
  in
  let* () =
    write_generated_file
      (Filename.concat support "doclang_prelude.ml")
      Evaluator.prelude
  in
  let current_files = List.map (fun page -> page.generated_path) pages in
  let stale =
    old_generated_files root
    |> List.filter (fun path -> not (List.mem path current_files))
  in
  List.iter
    (fun relative ->
      let absolute = Filename.concat pages_root relative in
      match ensure_generated_parent root relative with
      | Error _ -> ()
      | Ok () -> (
          if Sys.file_exists absolute then
            try
              Sys.remove absolute;
              remove_empty_parents ~stop:pages_root (Filename.dirname absolute)
            with Sys_error _ -> ()))
    stale;
  let* () =
    pages
    |> List.fold_left
         (fun result page ->
           let* () = result in
           let path = Filename.concat pages_root page.generated_path in
           let* () = ensure_generated_parent root page.generated_path in
           write_generated_file path page.source)
         (Ok ())
  in
  let program_digest =
    pages
    |> List.map (fun page ->
        page.module_path ^ "\x00" ^ Util.digest page.source)
    |> String.concat "\x00" |> Util.digest
  in
  let module_digest =
    pages
    |> List.map (fun page -> page.module_path ^ "\x00" ^ page.generated_path)
    |> String.concat "\x00" |> Util.digest
  in
  let manifest =
    `Assoc
      [
        ("format", `Int 1);
        ("programDigest", `String program_digest);
        ("moduleDigest", `String module_digest);
        ("compiler", `String (Evaluator.compiler_identity ()));
        ("dune", `String (dune_version ()));
        ("files", `List (List.map (fun path -> `String path) current_files));
        ( "pages",
          `List
            (List.map
               (fun page ->
                 `Assoc
                   [
                     ("module", `String page.module_path);
                     ("source", `String page.source_path);
                     ("generated", `String page.generated_path);
                   ])
               pages) );
      ]
  in
  let* () =
    write_generated_file (manifest_path root)
      (Yojson.Safe.pretty_to_string manifest)
  in
  Ok (program_digest, module_digest)

let parse_sexps source =
  let length = String.length source in
  let rec whitespace index =
    if index < length then
      match source.[index] with
      | ' ' | '\t' | '\r' | '\n' -> whitespace (index + 1)
      | _ -> index
    else index
  in
  let rec quoted index buffer =
    if index >= length then Error "Unterminated string in Dune description."
    else
      match source.[index] with
      | '"' -> Ok (Buffer.contents buffer, index + 1)
      | '\\' when index + 1 < length ->
          Buffer.add_char buffer source.[index + 1];
          quoted (index + 2) buffer
      | character ->
          Buffer.add_char buffer character;
          quoted (index + 1) buffer
  in
  let atom index =
    let rec finish cursor =
      if cursor >= length then cursor
      else
        match source.[cursor] with
        | ' ' | '\t' | '\r' | '\n' | '(' | ')' -> cursor
        | _ -> finish (cursor + 1)
    in
    let finish = finish index in
    (String.sub source index (finish - index), finish)
  in
  let rec one index =
    let index = whitespace index in
    if index >= length then Error "Unexpected end of Dune description."
    else
      match source.[index] with
      | '(' ->
          let rec items cursor result =
            let cursor = whitespace cursor in
            if cursor >= length then
              Error "Unterminated list in Dune description."
            else if source.[cursor] = ')' then
              Ok (List (List.rev result), cursor + 1)
            else
              let* item, cursor = one cursor in
              items cursor (item :: result)
          in
          items (index + 1) []
      | ')' -> Error "Unexpected ')' in Dune description."
      | '"' ->
          let* value, next = quoted (index + 1) (Buffer.create 32) in
          Ok (Atom value, next)
      | _ ->
          let value, next = atom index in
          Ok (Atom value, next)
  in
  let rec all index result =
    let index = whitespace index in
    if index >= length then Ok (List.rev result)
    else
      let* item, next = one index in
      all next (item :: result)
  in
  all 0 []

let field name = function
  | List items ->
      List.find_map
        (function
          | List [ Atom candidate; value ] when String.equal candidate name ->
              Some value
          | _ -> None)
        items
  | Atom _ -> None

let atom = function Atom value -> Some value | List _ -> None

let single_atom = function
  | List [ Atom value ] -> Some value
  | Atom value -> Some value
  | List _ -> None

let rec described_modules result = function
  | Atom _ -> result
  | List items as node ->
      let result =
        match (field "impl" node, field "cmt" node) with
        | Some impl, Some cmt -> (
            match (single_atom impl, single_atom cmt) with
            | Some impl, Some cmt
              when Util.starts_with ~prefix:"_build/default/pages/" impl
                   && Util.ends_with ~suffix:".ml" impl ->
                (impl, cmt) :: result
            | _ -> result)
        | _ -> result
      in
      List.fold_left described_modules result items

let describe root pages =
  let result =
    Evaluator.run_process ~cwd:(workspace root) ~timeout_seconds:12.
      ~output_limit:2_000_000
      ~environment:(compiler_path_environment ())
      "dune"
      [
        "describe";
        "workspace";
        "--root";
        workspace root;
        "--with-deps";
        "--format";
        "sexp";
        "--lang";
        "0.1";
      ]
  in
  if not (Evaluator.successful result.status) then
    Error (String.trim (result.stderr ^ "\n" ^ result.stdout))
  else
    let open Result in
    let* description = parse_sexps result.stdout in
    let described =
      List.fold_left described_modules [] description
      |> List.filter_map (fun (impl, cmt) ->
          let prefix = "_build/default/pages/" in
          let relative =
            String.sub impl (String.length prefix)
              (String.length impl - String.length prefix)
          in
          List.find_opt
            (fun page -> String.equal page.generated_path relative)
            pages
          |> Option.map (fun page -> { page; cmt }))
    in
    if List.length described = List.length pages then Ok described
    else Error "Dune did not describe every generated Doclang page."

let manifest_description pages =
  pages
  |> List.map (fun page ->
      let components = Module_path.split page.module_path in
      let cmt_name =
        match List.rev components with
        | [] -> assert false
        | leaf :: [] -> Module_path.uncapitalize_component leaf ^ ".cmt"
        | leaf :: reversed_namespace ->
            let namespace =
              match List.rev reversed_namespace with
              | [] -> assert false
              | first :: rest ->
                  Module_path.uncapitalize_component first :: rest
                  |> String.concat "__"
            in
            namespace ^ "__" ^ leaf ^ ".cmt"
      in
      {
        page;
        cmt = "_build/default/pages/.doclang_pages.objs/byte/" ^ cmt_name;
      })

let read_from path offset =
  try
    let channel = open_in_bin path in
    Fun.protect
      ~finally:(fun () -> close_in_noerr channel)
      (fun () ->
        let length = in_channel_length channel in
        let offset = min offset length in
        seek_in channel offset;
        really_input_string channel (length - offset))
  with Sys_error _ -> ""

let watcher_enabled root =
  match Sys.getenv_opt "DOCLANG_DUNE_WATCH" with
  | Some watched -> String.equal watched (workspace root)
  | None -> false

let build_targets ?(cancelled = fun () -> false) root cmts =
  let prefix = "_build/default/" in
  let targets =
    cmts
    |> List.map (fun cmt ->
        if Util.starts_with ~prefix cmt then
          String.sub cmt (String.length prefix)
            (String.length cmt - String.length prefix)
        else cmt)
  in
  if watcher_enabled root then
    let log_path = watcher_log_path root in
    let log_offset =
      try (Unix.stat log_path).st_size with Unix.Unix_error _ -> 0
    in
    let result =
      Evaluator.run_process ~cwd:(workspace root) ~timeout_seconds:20.
        ~output_limit:2_000_000 ~cancelled
        ~environment:(compiler_path_environment ())
        "dune"
        ([
           "rpc";
           "build";
           "--root";
           workspace root;
           "--wait";
           "--display";
           "quiet";
         ]
        @ targets)
    in
    if
      Evaluator.successful result.status
      && String.split_on_char '\n' result.stdout
         |> List.exists (fun line -> String.equal (String.trim line) "Success")
    then result
    else
      {
        result with
        status = Unix.WEXITED 1;
        stderr =
          String.trim (result.stderr ^ "\n" ^ read_from log_path log_offset);
      }
  else
    Evaluator.run_process ~cwd:(workspace root) ~timeout_seconds:20.
      ~output_limit:2_000_000 ~cancelled
      ~environment:(compiler_path_environment ())
      "dune"
      ([ "build"; "--root"; workspace root; "--display"; "quiet" ] @ targets)

let build_target ?(cancelled = fun () -> false) root cmt =
  build_targets ~cancelled root [ cmt ]

let start_watcher ~root pages =
  let* _ = sync root pages in
  let log_path = watcher_log_path root in
  (try
     if (Unix.stat log_path).st_size > 2_000_000 then
       let channel = open_out_bin log_path in
       close_out channel
   with Unix.Unix_error _ | Sys_error _ -> ());
  let descriptor =
    Unix.openfile log_path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_APPEND ] 0o600
  in
  match Unix.fork () with
  | 0 -> (
      try
        ignore (Unix.setsid ());
        let null = Unix.openfile "/dev/null" [ Unix.O_RDONLY ] 0 in
        Unix.dup2 null Unix.stdin;
        Unix.dup2 descriptor Unix.stdout;
        Unix.dup2 descriptor Unix.stderr;
        Unix.close null;
        Unix.close descriptor;
        let environment =
          Evaluator.environment_with (compiler_path_environment ())
        in
        Unix.execvpe "dune"
          [|
            "dune";
            "build";
            "--root";
            workspace root;
            "--passive-watch-mode";
            "--display";
            "quiet";
          |]
          environment
      with error ->
        prerr_endline
          ("Could not start the Dune watcher: " ^ Printexc.to_string error);
        Unix._exit 127)
  | pid ->
      Unix.close descriptor;
      ignore
        (Util.write_file_atomic (watcher_pid_path root) (string_of_int pid));
      let rec record_identity attempts =
        let process =
          Evaluator.run_process ~timeout_seconds:1. ~output_limit:16_384 "ps"
            [ "-p"; string_of_int pid; "-o"; "lstart="; "-o"; "command=" ]
        in
        let identity = String.trim process.stdout in
        if
          Evaluator.successful process.status
          &&
            try
              ignore
                (Str.search_forward
                   (Str.regexp_string "--passive-watch-mode")
                   identity 0);
              true
            with Not_found -> false
        then
          ignore
            (Util.write_file_atomic
               (watcher_identity_path root)
               (Yojson.Safe.to_string
                  (`Assoc
                     [
                       ("pid", `Int pid);
                       ("root", `String (workspace root));
                       ("identity", `String identity);
                     ])))
        else if attempts > 0 then (
          ignore (Unix.select [] [] [] 0.01);
          record_identity (attempts - 1))
      in
      record_identity 20;
      Unix.putenv "DOCLANG_DUNE_WATCH" (workspace root);
      Ok pid

let wait_for_watcher root =
  let result =
    Evaluator.run_process ~cwd:(workspace root) ~timeout_seconds:5.
      ~output_limit:262_144
      ~environment:(compiler_path_environment ())
      "dune"
      [
        "rpc"; "ping"; "--root"; workspace root; "--wait"; "--display"; "quiet";
      ]
  in
  if Evaluator.successful result.status then Ok ()
  else Error (String.trim (result.stderr ^ "\n" ^ result.stdout))

let stop_watcher pid =
  (try Unix.kill (-pid) Sys.sigterm with Unix.Unix_error _ -> ());
  let rec wait attempts =
    if attempts <= 0 then (
      (try Unix.kill (-pid) Sys.sigkill with Unix.Unix_error _ -> ());
      try ignore (Unix.waitpid [] pid) with Unix.Unix_error _ -> ())
    else
      match Unix.waitpid [ Unix.WNOHANG ] pid with
      | 0, _ ->
          ignore (Unix.select [] [] [] 0.02);
          wait (attempts - 1)
      | _ -> ()
      | exception Unix.Unix_error (Unix.EINTR, _, _) -> wait attempts
      | exception Unix.Unix_error _ -> ()
  in
  wait 50

let line_value prefix output =
  String.split_on_char '\n' output
  |> List.find_map (fun line ->
      let line = String.trim line in
      if Util.starts_with ~prefix line then
        Some
          (String.sub line (String.length prefix)
             (String.length line - String.length prefix)
          |> String.trim)
      else None)

let imported_units output =
  let tab = Str.regexp "^[0-9a-f]+[ \t]+\\([A-Za-z0-9_']+\\)$" in
  String.split_on_char '\n' output
  |> List.filter_map (fun line ->
      let line = String.trim line in
      if Str.string_match tab line 0 then Some (Str.matched_group 1 line)
      else None)
  |> List.sort_uniq String.compare

let inspect_cmt root described =
  let path = Filename.concat (workspace root) described.cmt in
  let result =
    Evaluator.run_process ~cwd:(workspace root) ~timeout_seconds:4.
      ~output_limit:262_144
      ~environment:(compiler_path_environment ())
      (tool "ocamlobjinfo" "ocamlobjinfo")
      [ path ]
  in
  if Evaluator.successful result.status then
    match line_value "Unit name:" result.stdout with
    | Some unit_name -> Ok (unit_name, imported_units result.stdout)
    | None -> Error "ocamlobjinfo omitted the compilation unit name."
  else Error (String.trim result.stderr)

let analyze_pages ?target ?described ?(cancelled = fun () -> false) ~root pages
    =
  match sync root pages with
  | Error message ->
      {
        ok = false;
        compiler = Evaluator.compiler_identity ();
        diagnostics = [ message ];
        modules = [];
      }
  | Ok _ ->
      let described =
        match described with
        | Some described -> described
        | None -> (
            if watcher_enabled root then manifest_description pages
            else
              match describe root pages with
              | Ok described -> described
              | Error _ -> manifest_description pages)
      in
      let requested =
        match target with
        | None -> described
        | Some module_path ->
            List.filter
              (fun entry -> String.equal entry.page.module_path module_path)
              described
      in
      let build_separately () =
        requested
        |> List.fold_left
             (fun (built, diagnostics) entry ->
               let result = build_target ~cancelled root entry.cmt in
               if Evaluator.successful result.status then
                 (entry :: built, diagnostics)
               else
                 let diagnostic =
                   String.trim (result.stderr ^ "\n" ^ result.stdout)
                 in
                 (built, diagnostic :: diagnostics))
             ([], [])
      in
      let built, diagnostics =
        match requested with
        | [] -> ([], [])
        | [ _ ] -> build_separately ()
        | _ ->
            let result =
              build_targets ~cancelled root
                (List.map (fun entry -> entry.cmt) requested)
            in
            if Evaluator.successful result.status then (requested, [])
            else build_separately ()
      in
      let available =
        described
        |> List.filter (fun entry ->
            Sys.file_exists (Filename.concat (workspace root) entry.cmt))
        |> List.filter_map (fun entry ->
            match inspect_cmt root entry with
            | Ok info -> Some (entry, info)
            | Error _ -> None)
      in
      let unit_to_module =
        available
        |> List.map (fun (entry, (unit_name, _)) ->
            (unit_name, entry.page.module_path))
      in
      let rec reachable_units known pending =
        match pending with
        | [] -> known
        | unit_name :: rest when List.mem unit_name known ->
            reachable_units known rest
        | unit_name :: rest ->
            let imports =
              available
              |> List.find_map (fun (_, (candidate, imports)) ->
                  if String.equal candidate unit_name then Some imports
                  else None)
              |> Option.value ~default:[]
              |> List.filter (fun imported ->
                  List.mem_assoc imported unit_to_module)
            in
            reachable_units (unit_name :: known) (imports @ rest)
      in
      let built_units =
        built
        |> List.filter_map (fun entry ->
            available
            |> List.find_map (fun (candidate, (unit_name, _)) ->
                if
                  String.equal candidate.page.module_path entry.page.module_path
                then Some unit_name
                else None))
      in
      let reachable = reachable_units [] built_units in
      let modules =
        available
        |> List.filter_map (fun (entry, (unit_name, imports)) ->
            if not (List.mem unit_name reachable) then None
            else
              Some
                {
                  module_path = entry.page.module_path;
                  uses =
                    imports
                    |> List.filter_map (fun unit_name ->
                        List.assoc_opt unit_name unit_to_module)
                    |> List.filter (fun dependency ->
                        not (String.equal dependency entry.page.module_path))
                    |> List.sort_uniq String.compare;
                  used_by = [];
                })
        |> reverse
      in
      let diagnostics =
        List.rev diagnostics @ internal_violations modules
        |> List.filter (fun message -> not (String.equal message ""))
      in
      {
        ok =
          diagnostics = []
          && List.length built = List.length requested
          && List.length requested > 0;
        compiler = Evaluator.compiler_identity ();
        diagnostics;
        modules;
      }

let analyze_workspace ?target ?(cancelled = fun () -> false) ~root index =
  analyze_pages ?target ~cancelled ~root (generated_pages index)

let module_info_to_json (entry : module_info) =
  `Assoc
    [
      ("module", `String entry.module_path);
      ("uses", `List (List.map (fun value -> `String value) entry.uses));
      ("usedBy", `List (List.map (fun value -> `String value) entry.used_by));
    ]

let analysis_to_json analysis =
  `Assoc
    [
      ("ok", `Bool analysis.ok);
      ("compiler", `String analysis.compiler);
      ( "diagnostics",
        `List (List.map (fun value -> `String value) analysis.diagnostics) );
      ("modules", `List (List.map module_info_to_json analysis.modules));
    ]

let strings_member name json =
  Yojson.Safe.Util.member name json
  |> Yojson.Safe.Util.to_list
  |> List.map Yojson.Safe.Util.to_string

let analysis_of_json json =
  {
    ok = Yojson.Safe.Util.member "ok" json |> Yojson.Safe.Util.to_bool;
    compiler =
      Yojson.Safe.Util.member "compiler" json |> Yojson.Safe.Util.to_string;
    diagnostics = strings_member "diagnostics" json;
    modules =
      Yojson.Safe.Util.member "modules" json
      |> Yojson.Safe.Util.to_list
      |> List.map (fun entry ->
          {
            module_path =
              Yojson.Safe.Util.member "module" entry
              |> Yojson.Safe.Util.to_string;
            uses = strings_member "uses" entry;
            used_by = strings_member "usedBy" entry;
          });
  }

let page_to_json page =
  `Assoc
    [
      ("module", `String page.module_path);
      ("sourcePath", `String page.source_path);
      ("generatedPath", `String page.generated_path);
      ("source", `String page.source);
    ]

let page_of_json ~root json =
  let open Result in
  let module_path =
    Yojson.Safe.Util.member "module" json |> Yojson.Safe.Util.to_string
  in
  let source_path =
    Yojson.Safe.Util.member "sourcePath" json |> Yojson.Safe.Util.to_string
  in
  let requested_generated_path =
    Yojson.Safe.Util.member "generatedPath" json |> Yojson.Safe.Util.to_string
  in
  let source =
    Yojson.Safe.Util.member "source" json |> Yojson.Safe.Util.to_string
  in
  let* _ = Module_path.validate module_path in
  let expected_source_path = Module_path.source_path module_path in
  let expected_generated_path = generated_path module_path in
  if Module_path.is_beneath ~namespace:"Doclang_prelude" module_path then
    Error "Doclang_prelude is reserved for compiler support."
  else if not (String.equal source_path expected_source_path) then
    Error
      (Printf.sprintf "Invalid source path %S for %s." source_path module_path)
  else if not (String.equal requested_generated_path expected_generated_path)
  then
    Error
      (Printf.sprintf "Invalid generated path %S for %s."
         requested_generated_path module_path)
  else
    let absolute_source = Filename.concat root source_path in
    let* () =
      try
        match (Unix.lstat absolute_source).st_kind with
        | Unix.S_REG -> Ok ()
        | Unix.S_LNK ->
            Error ("Page source paths cannot be symlinks: " ^ source_path)
        | _ -> Error ("Page source path is not a regular file: " ^ source_path)
      with Unix.Unix_error (code, operation, argument) ->
        Error
          (Printf.sprintf "%s(%s): %s" operation argument
             (Unix.error_message code))
    in
    Ok
      {
        module_path;
        source_path;
        generated_path = expected_generated_path;
        source;
      }

let validate_pages ~root json_pages =
  let open Result in
  let* pages =
    List.fold_left
      (fun result json ->
        let* pages = result in
        let* page = page_of_json ~root json in
        Ok (page :: pages))
      (Ok []) json_pages
    |> Result.map List.rev
  in
  let unique field label =
    let values = List.map field pages in
    if List.length values = List.length (List.sort_uniq String.compare values)
    then Ok ()
    else Error ("Duplicate " ^ label ^ " in compiler request.")
  in
  let* () = unique (fun page -> page.module_path) "module path" in
  let* () = unique (fun page -> page.source_path) "source path" in
  let* () = unique (fun page -> page.generated_path) "generated path" in
  match
    List.find_map
      (fun page ->
        pages
        |> List.find_opt (fun candidate ->
            (not (String.equal page.module_path candidate.module_path))
            && Module_path.is_beneath ~namespace:page.module_path
                 candidate.module_path)
        |> Option.map (fun candidate ->
            Printf.sprintf "%s is both a page and a namespace for %s."
              page.module_path candidate.module_path))
      pages
  with
  | Some message -> Error message
  | None -> Ok pages

let failed message =
  {
    ok = false;
    compiler = Evaluator.compiler_identity ();
    diagnostics = [ message ];
    modules = [];
  }

type coordinator = {
  pid : int option;
  socket_path : string;
  root : string;
  owner : Unix.file_descr option;
}

let coordinator_socket root =
  Filename.concat "/tmp"
    (Printf.sprintf "doclang-%d-%s.sock" (Unix.getuid ()) (Util.digest root))

let connect socket_path =
  let socket = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  try
    Unix.connect socket (Unix.ADDR_UNIX socket_path);
    Ok socket
  with error ->
    Unix.close socket;
    Error error

let stop_recorded_watcher root =
  let path = watcher_pid_path root in
  let identity_path = watcher_identity_path root in
  let recorded =
    try
      let json =
        Util.read_file identity_path |> Result.get_ok |> Yojson.Safe.from_string
      in
      let pid = Yojson.Safe.Util.member "pid" json |> Yojson.Safe.Util.to_int in
      let recorded_root =
        Yojson.Safe.Util.member "root" json |> Yojson.Safe.Util.to_string
      in
      let identity =
        Yojson.Safe.Util.member "identity" json |> Yojson.Safe.Util.to_string
      in
      let pid_file =
        Util.read_file path |> Result.get_ok |> String.trim |> int_of_string
      in
      if pid = pid_file && String.equal recorded_root (workspace root) then
        Some (pid, identity)
      else None
    with
    | Yojson.Json_error _ | Yojson.Safe.Util.Type_error _ | Failure _
    | Invalid_argument _
    ->
      None
  in
  Option.iter
    (fun (pid, expected_identity) ->
      let process =
        Evaluator.run_process ~timeout_seconds:1. ~output_limit:16_384 "ps"
          [ "-p"; string_of_int pid; "-o"; "lstart="; "-o"; "command=" ]
      in
      if
        Evaluator.successful process.status
        && String.equal (String.trim process.stdout) expected_identity
        &&
          try
            ignore
              (Str.search_forward
                 (Str.regexp_string ("--root " ^ workspace root))
                 expected_identity 0);
            ignore
              (Str.search_forward
                 (Str.regexp_string "--passive-watch-mode")
                 expected_identity 0);
            true
          with Not_found -> false
      then (
        (try Unix.kill (-pid) Sys.sigterm with Unix.Unix_error _ -> ());
        ignore (Unix.select [] [] [] 0.05);
        try Unix.kill (-pid) Sys.sigkill with Unix.Unix_error _ -> ()))
    recorded;
  List.iter
    (fun stale ->
      if Sys.file_exists stale then
        try Sys.remove stale with Sys_error _ -> ())
    [ path; identity_path ]

let send_json socket json =
  let channel = Unix.out_channel_of_descr (Unix.dup socket) in
  Fun.protect
    ~finally:(fun () -> close_out_noerr channel)
    (fun () ->
      output_string channel (Yojson.Safe.to_string json);
      output_char channel '\n';
      flush channel)

let analyze_via_coordinator ~cancelled ~socket_path ?target pages =
  match connect socket_path with
  | Error error ->
      failed
        ("The Dune build coordinator is unavailable: "
       ^ Printexc.to_string error)
  | Ok socket ->
      Fun.protect
        ~finally:(fun () ->
          try Unix.close socket with Unix.Unix_error _ -> ())
        (fun () ->
          send_json socket
            (`Assoc
               [
                 ( "target",
                   Option.fold ~none:`Null
                     ~some:(fun value -> `String value)
                     target );
                 ("pages", `List (List.map page_to_json pages));
               ]);
          let rec wait () =
            if cancelled () then raise Evaluator.Cancelled
            else
              match Unix.select [ socket ] [] [] 0.02 with
              | [], _, _ -> wait ()
              | _ ->
                  let channel = Unix.in_channel_of_descr (Unix.dup socket) in
                  Fun.protect
                    ~finally:(fun () -> close_in_noerr channel)
                    (fun () ->
                      try
                        input_line channel |> Yojson.Safe.from_string
                        |> analysis_of_json
                      with
                      | End_of_file ->
                          failed
                            "The Dune build coordinator closed the request."
                      | Yojson.Json_error message ->
                          failed
                            ("The Dune build coordinator returned invalid \
                              JSON: " ^ message))
          in
          wait ())

let watcher_alive pid =
  match Unix.waitpid [ Unix.WNOHANG ] pid with
  | 0, _ -> true
  | _ -> false
  | exception Unix.Unix_error (Unix.EINTR, _, _) -> true
  | exception Unix.Unix_error _ -> false

let socket_closed socket =
  try
    match Unix.select [ socket ] [] [] 0. with
    | [], _, _ -> false
    | _ ->
        let byte = Bytes.create 1 in
        Unix.recv socket byte 0 1 [ Unix.MSG_PEEK ] = 0
  with
  | Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK | Unix.EINTR), _, _) ->
      false
  | Unix.Unix_error _ -> true

let owner_closed owner =
  try
    match Unix.select [ owner ] [] [] 0. with
    | [], _, _ -> false
    | _ ->
        let byte = Bytes.create 1 in
        Unix.read owner byte 0 1 = 0
  with
  | Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK | Unix.EINTR), _, _) ->
      false
  | Unix.Unix_error _ -> true

type coordinator_command =
  | Analyze of string option * generated_page list
  | Ping
  | Shutdown

let coordinator_command ~root line =
  if String.equal line "ping" then Ok Ping
  else if String.equal line "shutdown" then Ok Shutdown
  else
    try
      let json = Yojson.Safe.from_string line in
      let target =
        match Yojson.Safe.Util.member "target" json with
        | `String value ->
            let* _ = Module_path.validate value in
            Ok (Some value)
        | `Null -> Ok None
        | _ -> Error "Invalid compiler request target."
      in
      let* target = target in
      let* pages =
        Yojson.Safe.Util.member "pages" json
        |> Yojson.Safe.Util.to_list |> validate_pages ~root
      in
      Ok (Analyze (target, pages))
    with
    | Yojson.Json_error message | Yojson.Safe.Util.Type_error (message, _) ->
      Error ("Invalid compiler request: " ^ message)

let read_command ~root socket =
  let channel = Unix.in_channel_of_descr (Unix.dup socket) in
  Fun.protect
    ~finally:(fun () -> close_in_noerr channel)
    (fun () ->
      try input_line channel |> coordinator_command ~root
      with End_of_file -> Error "The compiler request closed before its body.")

let coordinator_loop ~root ~listener ~owner ~ready initial_pages =
  let watcher = ref None in
  let current_pages = ref initial_pages in
  let module_digest pages =
    pages
    |> List.map (fun page -> page.module_path ^ "\x00" ^ page.generated_path)
    |> String.concat "\x00" |> Util.digest
  in
  let current_module_digest = ref (module_digest initial_pages) in
  let described =
    ref
      (match describe root initial_pages with
      | Ok entries -> entries
      | Error _ -> manifest_description initial_pages)
  in
  let start () =
    match start_watcher ~root !current_pages with
    | Error message -> Error message
    | Ok pid -> (
        match wait_for_watcher root with
        | Ok () ->
            watcher := Some pid;
            Ok ()
        | Error message ->
            stop_watcher pid;
            Error message)
  in
  let ensure () =
    match !watcher with
    | Some pid when watcher_alive pid -> Ok ()
    | Some _ | None ->
        watcher := None;
        start ()
  in
  let prepare pages =
    let digest = module_digest pages in
    if String.equal digest !current_module_digest then ensure ()
    else (
      Option.iter stop_watcher !watcher;
      watcher := None;
      match sync root pages with
      | Error message -> Error message
      | Ok _ ->
          current_pages := pages;
          current_module_digest := digest;
          (described :=
             match describe root pages with
             | Ok entries -> entries
             | Error _ -> manifest_description pages);
          start ())
  in
  let reply_error socket message =
    try send_json socket (analysis_to_json (failed message))
    with Sys_error _ | Unix.Unix_error _ -> ()
  in
  let close socket = try Unix.close socket with Unix.Unix_error _ -> () in
  let rec serve () =
    match Unix.select [ owner; listener ] [] [] (-1.) with
    | readable, _, _ when List.mem owner readable -> ()
    | _ -> (
        let socket, _ = Unix.accept listener in
        match read_command ~root socket with
        | Error message ->
            reply_error socket message;
            close socket;
            serve ()
        | Ok Ping ->
            (try send_json socket (`Assoc [ ("ready", `Bool true) ])
             with Sys_error _ | Unix.Unix_error _ -> ());
            close socket;
            serve ()
        | Ok Shutdown -> close socket
        | Ok (Analyze (target, pages)) ->
            let cancelled () = socket_closed socket || owner_closed owner in
            let analysis =
              try
                Util.with_file_lock (Filename.concat root ".doclang/build.lock")
                  (fun () ->
                    if cancelled () then raise Evaluator.Cancelled;
                    match prepare pages with
                    | Error message ->
                        failed ("Could not restart the Dune watcher: " ^ message)
                    | Ok () ->
                        analyze_pages ?target ~described:!described ~cancelled
                          ~root pages)
              with
              | Evaluator.Cancelled ->
                  failed "This compiler request was superseded."
              | error ->
                  failed
                    ("The Dune build coordinator failed: "
                   ^ Printexc.to_string error)
            in
            (if not (cancelled ()) then
               try send_json socket (analysis_to_json analysis)
               with Sys_error _ | Unix.Unix_error _ -> ());
            close socket;
            serve ())
  in
  Fun.protect
    ~finally:(fun () ->
      close_out_noerr ready;
      (try Unix.close owner with Unix.Unix_error _ -> ());
      Option.iter stop_watcher !watcher)
    (fun () ->
      match
        Util.with_file_lock (Filename.concat root ".doclang/build.lock") start
      with
      | Ok () ->
          output_string ready "ready\n";
          flush ready;
          close_out_noerr ready;
          serve ()
      | Error message ->
          output_string ready ("error:" ^ message ^ "\n");
          flush ready;
          prerr_endline ("Could not start the Dune watcher: " ^ message))

let start_coordinator ~root index =
  let pages = generated_pages index in
  let socket_path = coordinator_socket root in
  let* () = ensure_workspace_directories root in
  Util.with_file_lock (Filename.concat root ".doclang/coordinator-start.lock")
    (fun () ->
      let existing =
        if Sys.file_exists socket_path then (
          match connect socket_path with
          | Ok socket ->
              Unix.close socket;
              true
          | Error _ ->
              (try Sys.remove socket_path with Sys_error _ -> ());
              false)
        else false
      in
      if existing then
        Error
          "This project already has a live Doclang compiler coordinator. Stop \
           the other server before starting another one."
      else
        let listener = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
        let owns_socket = ref false in
        try
          Unix.set_close_on_exec listener;
          stop_recorded_watcher root;
          Unix.bind listener (Unix.ADDR_UNIX socket_path);
          owns_socket := true;
          Unix.chmod socket_path 0o600;
          Unix.listen listener 32;
          let ready_read, ready_write = Unix.pipe ~cloexec:true () in
          let owner_read, owner_write = Unix.pipe ~cloexec:true () in
          match Unix.fork () with
          | exception error ->
              List.iter
                (fun descriptor ->
                  try Unix.close descriptor with Unix.Unix_error _ -> ())
                [ ready_read; ready_write; owner_read; owner_write ];
              raise error
          | 0 ->
              Unix.close ready_read;
              Unix.close owner_write;
              Sys.set_signal Sys.sigpipe Sys.Signal_ignore;
              let exit_code =
                try
                  let ready = Unix.out_channel_of_descr ready_write in
                  coordinator_loop ~root ~listener ~owner:owner_read ~ready
                    pages;
                  0
                with error ->
                  prerr_endline
                    ("Compiler coordinator crashed: " ^ Printexc.to_string error);
                  1
              in
              (try Unix.close listener with Unix.Unix_error _ -> ());
              (try Sys.remove socket_path with Sys_error _ -> ());
              Unix._exit exit_code
          | pid -> (
              let fail_startup message =
                List.iter
                  (fun descriptor ->
                    try Unix.close descriptor with Unix.Unix_error _ -> ())
                  [ ready_read; ready_write; owner_read; owner_write; listener ];
                (try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ());
                (try ignore (Unix.waitpid [] pid) with Unix.Unix_error _ -> ());
                (try Sys.remove socket_path with Sys_error _ -> ());
                Error message
              in
              try
                Unix.close ready_write;
                Unix.close owner_read;
                Unix.close listener;
                let ready = Unix.in_channel_of_descr ready_read in
                let startup =
                  Fun.protect
                    ~finally:(fun () -> close_in_noerr ready)
                    (fun () ->
                      match Unix.select [ ready_read ] [] [] 8. with
                      | [], _, _ ->
                          Error "Timed out waiting for Dune RPC readiness."
                      | _ -> (
                          try
                            let line = input_line ready in
                            if String.equal line "ready" then Ok ()
                            else if Util.starts_with ~prefix:"error:" line then
                              Error (String.sub line 6 (String.length line - 6))
                            else
                              Error
                                "The compiler coordinator returned invalid \
                                 startup data."
                          with End_of_file ->
                            Error
                              "The compiler coordinator exited during startup."))
                in
                match startup with
                | Ok () ->
                    Ok
                      {
                        pid = Some pid;
                        socket_path;
                        root;
                        owner = Some owner_write;
                      }
                | Error message -> fail_startup message
              with error -> fail_startup (Printexc.to_string error))
        with error ->
          (try Unix.close listener with Unix.Unix_error _ -> ());
          (if !owns_socket then
             try Sys.remove socket_path with Sys_error _ -> ());
          Error (Printexc.to_string error))

let coordinator_alive coordinator =
  match coordinator.pid with
  | None -> false
  | Some pid -> (
      match Unix.waitpid [ Unix.WNOHANG ] pid with
      | 0, _ -> true
      | _ -> false
      | exception Unix.Unix_error (Unix.EINTR, _, _) -> true
      | exception Unix.Unix_error _ -> false)

let detach_coordinator_owner coordinator =
  Option.iter
    (fun descriptor -> try Unix.close descriptor with Unix.Unix_error _ -> ())
    coordinator.owner

let stop_coordinator coordinator =
  detach_coordinator_owner coordinator;
  match coordinator.pid with
  | None -> ()
  | Some pid -> (
      (match connect coordinator.socket_path with
      | Error _ -> ()
      | Ok socket ->
          (try
             let channel = Unix.out_channel_of_descr (Unix.dup socket) in
             output_string channel "shutdown\n";
             flush channel;
             close_out_noerr channel
           with Sys_error _ | Unix.Unix_error _ -> ());
          Unix.close socket);
      let rec wait attempts =
        if attempts <= 0 then (
          (try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ());
          try ignore (Unix.waitpid [] pid) with Unix.Unix_error _ -> ())
        else
          match Unix.waitpid [ Unix.WNOHANG ] pid with
          | 0, _ ->
              ignore (Unix.select [] [] [] 0.02);
              wait (attempts - 1)
          | _ -> ()
          | exception Unix.Unix_error (Unix.EINTR, _, _) -> wait attempts
          | exception Unix.Unix_error _ -> ()
      in
      wait 100;
      stop_recorded_watcher coordinator.root;
      if Sys.file_exists coordinator.socket_path then
        try Sys.remove coordinator.socket_path with Sys_error _ -> ())

let analyze_unlocked index =
  let root = Filename.temp_dir "doclang-dune-workspace-" "" in
  Fun.protect
    ~finally:(fun () ->
      try remove_tree root with Sys_error _ | Unix.Unix_error _ -> ())
    (fun () -> analyze_workspace ~root index)

let analyze ?target ?(cancelled = fun () -> false) ~root ~version:_ index =
  let metadata = Filename.concat root ".doclang" in
  match Util.ensure_directory metadata with
  | Error message ->
      {
        ok = false;
        compiler = Evaluator.compiler_identity ();
        diagnostics = [ message ];
        modules = [];
      }
  | Ok () ->
      let socket_path = coordinator_socket root in
      if Sys.file_exists socket_path then
        analyze_via_coordinator ~cancelled ~socket_path ?target
          (generated_pages index)
      else
        Util.with_file_lock (Filename.concat metadata "build.lock") (fun () ->
            analyze_workspace ?target ~cancelled ~root index)

let boundary module_path =
  match String.split_on_char '.' module_path with
  | first :: _ -> first
  | [] -> module_path

let module_json (analysis : t) module_path =
  let entry =
    List.find_opt
      (fun (entry : module_info) -> String.equal entry.module_path module_path)
      analysis.modules
  in
  let uses = Option.fold ~none:[] ~some:(fun entry -> entry.uses) entry in
  let used_by = Option.fold ~none:[] ~some:(fun entry -> entry.used_by) entry in
  let boundary_status =
    if Option.is_none entry || not analysis.ok then "unknown"
    else if used_by = [] then "unused"
    else if
      List.for_all
        (fun user -> String.equal (boundary user) (boundary module_path))
        used_by
    then "namespace-local"
    else "cross-namespace"
  in
  `Assoc
    [
      ("module", `String module_path);
      ("uses", `List (List.map (fun value -> `String value) uses));
      ("usedBy", `List (List.map (fun value -> `String value) used_by));
      ("boundary", `String boundary_status);
      ("compilerBacked", `Bool (Option.is_some entry && analysis.ok));
      ("compiler", `String analysis.compiler);
      ( "diagnostics",
        `List (List.map (fun message -> `String message) analysis.diagnostics)
      );
    ]
