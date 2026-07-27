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

let tool next_to_compiler fallback =
  let candidate =
    Filename.concat (Filename.dirname (Evaluator.compiler ())) next_to_compiler
  in
  if Sys.file_exists candidate then candidate else fallback

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

let source_for page =
  let document = page.Page_index.document in
  let legacy_opens =
    document.Document.imports
    |> List.filter_map (fun path ->
        Result.to_option (Module_path.of_source_path path))
    |> List.map (fun module_path ->
        "open " ^ Module_path.compiler_unit module_path)
    |> String.concat "\n"
  in
  "open Doclang_prelude\n" ^ legacy_opens ^ "\n"
  ^ Document.compilation_source document

let reverse modules =
  modules
  |> List.map (fun entry ->
      let used_by =
        modules
        |> List.filter_map (fun candidate ->
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
  |> List.concat_map (fun entry ->
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

let write_sources directory pages =
  let prepared =
    pages
    |> List.map (fun page ->
        let unit_name = Module_path.compiler_unit page.Page_index.module_path in
        let path =
          Filename.concat directory (String.uncapitalize_ascii unit_name ^ ".ml")
        in
        (page, path, source_for page))
  in
  let aliases =
    pages
    |> List.map (fun page -> page.Page_index.module_path)
    |> Module_path.alias_units
    |> List.map (fun (unit_name, source) ->
        ( Filename.concat directory (String.uncapitalize_ascii unit_name ^ ".ml"),
          source ))
  in
  let page_result =
    prepared
    |> List.fold_left
         (fun result (_, path, source) ->
           Result.bind result (fun () -> Util.write_file path source))
         (Ok ())
  in
  let result =
    Result.bind page_result (fun () ->
        aliases
        |> List.fold_left
             (fun result (path, source) ->
               Result.bind result (fun () -> Util.write_file path source))
             (Ok ()))
  in
  Result.map (fun () -> (prepared, aliases)) result

let compile_aliases directory aliases =
  aliases
  |> List.fold_left
       (fun result (path, _) ->
         Result.bind result (fun () ->
             let compiled =
               Evaluator.run_process ~cwd:directory ~timeout_seconds:12.
                 ~output_limit:1_000_000 (Evaluator.compiler ())
                 [ "-w"; "-49"; "-no-alias-deps"; "-c"; path ]
             in
             if Evaluator.successful compiled.status then Ok ()
             else Error (String.trim compiled.stderr)))
       (Ok ())

let compile_pages directory prepared =
  let rec pass compiled pending =
    match pending with
    | [] -> (List.rev compiled, [])
    | _ ->
        let succeeded, failed =
          pending
          |> List.fold_left
               (fun (succeeded, failed) item ->
                 let _, path, _ = item in
                 let result =
                   Evaluator.run_process ~cwd:directory ~timeout_seconds:12.
                     ~output_limit:1_000_000 (Evaluator.compiler ())
                     [ "-I"; directory; "-open"; "Doclang"; "-c"; path ]
                 in
                 if Evaluator.successful result.status then
                   (item :: succeeded, failed)
                 else (succeeded, (item, String.trim result.stderr) :: failed))
               ([], [])
        in
        if succeeded = [] then
          ( List.rev compiled,
            failed |> List.map snd |> List.sort_uniq String.compare )
        else pass (List.rev_append succeeded compiled) (List.rev_map fst failed)
  in
  pass [] prepared

let imported_modules unit_to_module output =
  let expression = Str.regexp "Doclang__[A-Za-z0-9_']+" in
  let rec scan offset result =
    try
      let _ = Str.search_forward expression output offset in
      let result =
        match List.assoc_opt (Str.matched_string output) unit_to_module with
        | Some module_path -> module_path :: result
        | None -> result
      in
      scan (Str.match_end ()) result
    with Not_found -> List.sort_uniq String.compare result
  in
  scan 0 []

let graph_of_objects directory compiled =
  let unit_to_module =
    compiled
    |> List.map (fun (page, _, _) ->
        ( Module_path.compiler_unit page.Page_index.module_path,
          page.Page_index.module_path ))
  in
  let ocamlobjinfo = tool "ocamlobjinfo" "ocamlobjinfo" in
  compiled
  |> List.map (fun (page, path, _) ->
      let result =
        Evaluator.run_process ~cwd:directory ~timeout_seconds:4.
          ~output_limit:262_144 ocamlobjinfo
          [ Filename.chop_extension path ^ ".cmo" ]
      in
      let module_path = page.Page_index.module_path in
      {
        module_path;
        uses =
          imported_modules unit_to_module result.stdout
          |> List.filter (fun dependency ->
              not (String.equal dependency module_path));
        used_by = [];
      })
  |> reverse

let analyze_unlocked index =
  let directory = Filename.temp_dir "doclang-workspace-" "" in
  Fun.protect
    ~finally:(fun () -> remove_tree directory)
    (fun () ->
      let result =
        Result.bind (write_sources directory index.Page_index.pages)
          (fun (prepared, aliases) ->
            let prelude_path = Filename.concat directory "doclang_prelude.ml" in
            Result.bind (Util.write_file prelude_path Evaluator.prelude)
              (fun () ->
                let prelude =
                  Evaluator.run_process ~cwd:directory ~timeout_seconds:12.
                    ~output_limit:1_000_000 (Evaluator.compiler ())
                    [ "-c"; prelude_path ]
                in
                if not (Evaluator.successful prelude.status) then
                  Error (String.trim prelude.stderr)
                else
                  Result.bind (compile_aliases directory aliases) (fun () ->
                      let compiled, diagnostics =
                        compile_pages directory prepared
                      in
                      Ok (graph_of_objects directory compiled, diagnostics))))
      in
      match result with
      | Error message ->
          {
            ok = false;
            compiler = Evaluator.compiler_identity ();
            diagnostics = [ message ];
            modules = [];
          }
      | Ok (modules, compile_diagnostics) ->
          let diagnostics = compile_diagnostics @ internal_violations modules in
          {
            ok = diagnostics = [];
            compiler = Evaluator.compiler_identity ();
            diagnostics;
            modules;
          })

let analyze ~root ~version index =
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
      Util.with_file_lock (Filename.concat metadata "build.lock") (fun () ->
          let cache_directory = Filename.concat metadata "cache" in
          let cache_key =
            Util.digest (version ^ "\x00" ^ Evaluator.compiler_identity ())
          in
          let cache_path =
            Filename.concat cache_directory
              ("compiler-" ^ cache_key ^ ".marshal")
          in
          let cached =
            match Util.read_file cache_path with
            | Ok source -> (
                try Some (Marshal.from_string source 0 : t) with _ -> None)
            | Error _ -> None
          in
          match cached with
          | Some analysis -> analysis
          | None ->
              let analysis = analyze_unlocked index in
              ignore (Util.ensure_directory cache_directory);
              ignore
                (Util.write_file_atomic cache_path
                   (Marshal.to_string analysis []));
              analysis)

let boundary module_path =
  match String.split_on_char '.' module_path with
  | first :: _ -> first
  | [] -> module_path

let module_json analysis module_path =
  let entry =
    List.find_opt
      (fun entry -> String.equal entry.module_path module_path)
      analysis.modules
  in
  let uses = Option.fold ~none:[] ~some:(fun entry -> entry.uses) entry in
  let used_by = Option.fold ~none:[] ~some:(fun entry -> entry.used_by) entry in
  let boundary_status =
    if used_by = [] then "unused"
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
      ("compilerBacked", `Bool analysis.ok);
      ("compiler", `String analysis.compiler);
      ( "diagnostics",
        `List (List.map (fun message -> `String message) analysis.diagnostics)
      );
    ]
