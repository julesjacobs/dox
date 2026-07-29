let fail message =
  prerr_endline message;
  exit 1

let expect condition message = if not condition then fail message
let result = function Ok value -> value | Error message -> fail message

let project_result = function
  | Ok value -> value
  | Error error -> fail (Project.error_message error)

let rec remove_tree path =
  if Sys.file_exists path then
    match (Unix.lstat path).st_kind with
    | Unix.S_DIR ->
        Sys.readdir path
        |> Array.iter (fun name -> remove_tree (Filename.concat path name));
        Unix.rmdir path
    | _ -> Sys.remove path

let write root path source =
  let absolute = Filename.concat root path in
  result (Util.ensure_directory (Filename.dirname absolute));
  result (Util.write_file absolute source)

let outline_entry index path =
  Page_index.line_entries index
  |> List.find (fun entry ->
      Yojson.Safe.Util.member "path" entry
      |> Yojson.Safe.Util.to_string |> String.equal path)

let () =
  expect
    (Module_path.of_source_path "models/statistics.live.md"
    = Ok "Models.Statistics")
    "source path did not decode to a qualified module";
  expect
    (String.equal
       (Module_path.source_path "Models.Statistics")
       "models/statistics.live.md")
    "qualified module did not encode reversibly";
  expect
    (Module_path.of_source_path "httpServer/clientAPI.live.md"
    = Ok "HttpServer.ClientAPI")
    "CamelCase module components did not encode reversibly";
  expect
    (Result.is_error (Module_path.validate "Models.Bad-Name"))
    "invalid module component was accepted";
  expect
    (Compiler_workspace.safe_generated_file "models/statistics.ml"
    && not
         (Compiler_workspace.safe_generated_file
            "../../../../project-file.live.md"))
    "generated source cleanup accepted a path outside its workspace";
  expect
    (Result.is_error
       (Page_index.build
          [
            Document.parse ~path:"doclang_prelude.live.md"
              "# Reserved support module\n";
          ]))
    "the generated Doclang_prelude module identity was not reserved";
  let parent_pages =
    result
      (Page_index.build
         [
           Document.parse ~path:"models.live.md" "# Models\n";
           Document.parse ~path:"models/regression.live.md" "# Regression\n";
           Document.parse ~path:"models/nested.live.md" "# Nested\n";
           Document.parse ~path:"models/nested/child.live.md" "# Child\n";
           Document.parse ~path:"solo.live.md" "# Solo\n";
         ])
  in
  let models = outline_entry parent_pages "Models" in
  expect
    (Yojson.Safe.Util.member "pageModule" models = `String "Models"
    && Yojson.Safe.Util.member "namespace" models = `Bool true
    && Yojson.Safe.Util.member "hasChildren" models = `Bool true)
    "a page could not also represent its child namespace";
  let nested = outline_entry parent_pages "Models.Nested" in
  expect
    (Yojson.Safe.Util.member "pageModule" nested = `String "Models.Nested"
    && Yojson.Safe.Util.member "namespace" nested = `Bool true
    && Yojson.Safe.Util.member "hasChildren" nested = `Bool true)
    "a nested page could not also represent its child namespace";
  let solo = outline_entry parent_pages "Solo" in
  expect
    (Yojson.Safe.Util.member "pageModule" solo = `String "Solo"
    && Yojson.Safe.Util.member "namespace" solo = `Bool false)
    "a leaf page was incorrectly treated as a namespace";
  let literal_index =
    result
      (Page_index.build
         [
           Document.parse ~path:"models.live.md" "# Models\n";
           Document.parse ~path:"models/index.live.md" "# Literal child\n";
         ])
  in
  let literal_index_child = outline_entry literal_index "Models.Index" in
  expect
    (Yojson.Safe.Util.member "pageModule" literal_index_child
    = `String "Models.Index")
    "the Index component retained special compatibility behavior";
  let no_index_documents =
    [
      Document.parse ~path:"catalog/zeta.live.md" "# Zeta\n";
      Document.parse ~path:"catalog/alpha.live.md" "# Alpha\n";
    ]
  in
  let no_index = result (Page_index.build no_index_documents) in
  let catalog = outline_entry no_index "Catalog" in
  expect
    (Yojson.Safe.Util.member "namespace" catalog = `Bool true
    && Yojson.Safe.Util.member "hasChildren" catalog = `Bool true
    && Page_index.modules no_index = [ "Catalog.Alpha"; "Catalog.Zeta" ])
    "a namespace-only row lost its children or invented a page";
  let reordered = result (Page_index.build (List.rev no_index_documents)) in
  expect
    (Page_index.line_entries reordered = Page_index.line_entries no_index)
    "reordering child inputs changed the canonical outline or row attachments";
  let last_child_before =
    result
      (Page_index.build
         [
           Document.parse ~path:"archive.live.md" "# Archive\n";
           Document.parse ~path:"archive/only.live.md" "# Only\n";
         ])
  in
  let last_child_after =
    result
      (Page_index.build
         [ Document.parse ~path:"archive.live.md" "# Archive\n" ])
  in
  let archive_before = outline_entry last_child_before "Archive" in
  let archive_after = outline_entry last_child_after "Archive" in
  expect
    (Yojson.Safe.Util.member "pageModule" archive_before = `String "Archive"
    && Yojson.Safe.Util.member "hasChildren" archive_before = `Bool true
    && Yojson.Safe.Util.member "pageModule" archive_after = `String "Archive"
    && Yojson.Safe.Util.member "hasChildren" archive_after = `Bool false
    && Page_index.modules last_child_after = [ "Archive" ])
    "removing the last child lost or converted its parent page";
  let deep_description =
    Compiler_workspace.manifest_description
      [
        {
          Compiler_workspace.module_path = "A.B.C";
          source_path = "a/b/c.live.md";
          generated_path = Compiler_workspace.generated_path "A.B.C";
          source = "";
        };
      ]
  in
  expect
    (match deep_description with
    | [ entry ] ->
        Util.ends_with ~suffix:"/doclang__A__B__C.cmt"
          entry.Compiler_workspace.cmt
    | _ -> false)
    "the passive Dune target for a deep qualified module was incorrect";
  expect
    (Compiler_workspace.internal_violations
       [
         {
           Compiler_workspace.module_path = "Models.Internal.Secret";
           uses = [];
           used_by = [ "Reports.Use" ];
         };
       ]
    <> [])
    "an Internal namespace boundary violation was accepted";
  let unsafe_root = Filename.temp_dir "doclang-workspace-symlink-test-" "" in
  let outside = Filename.temp_dir "doclang-workspace-outside-test-" "" in
  Fun.protect
    ~finally:(fun () ->
      remove_tree unsafe_root;
      remove_tree outside)
    (fun () ->
      write unsafe_root "a/b.live.md" "# Unsafe\n\n    let value = 1\n";
      result
        (Util.ensure_directory
           (Filename.concat unsafe_root ".doclang/dune-workspace/pages"));
      Unix.symlink outside
        (Filename.concat unsafe_root
           ".doclang/dune-workspace/pages/doclang__A__B.ml");
      let page =
        {
          Compiler_workspace.module_path = "A.B";
          source_path = "a/b.live.md";
          generated_path = Compiler_workspace.generated_path "A.B";
          source = "open Doclang_prelude\nlet value = 1\n";
        }
      in
      expect
        (Result.is_error (Compiler_workspace.sync unsafe_root [ page ]))
        "compiler source generation followed a symlinked parent";
      expect
        (Array.length (Sys.readdir outside) = 0)
        "compiler source generation wrote outside its workspace");
  let concurrent_root =
    Filename.temp_dir "doclang-workspace-concurrent-test-" ""
  in
  Fun.protect
    ~finally:(fun () -> remove_tree concurrent_root)
    (fun () ->
      write concurrent_root "index.live.md"
        "# Concurrent start\n\n    let value = 1\n";
      let concurrent_project = Project.create concurrent_root in
      let concurrent_snapshot =
        project_result (Project.snapshot concurrent_project)
      in
      let result_read, result_write = Unix.pipe ~cloexec:true () in
      let release_read, release_write = Unix.pipe ~cloexec:true () in
      let contenders =
        List.init 2 (fun _ ->
            match Unix.fork () with
            | 0 ->
                Unix.close result_read;
                Unix.close release_write;
                let result_channel = Unix.out_channel_of_descr result_write in
                (match
                   Compiler_workspace.start_coordinator ~root:concurrent_root
                     concurrent_snapshot.page_index
                 with
                | Error _ ->
                    output_string result_channel "loser\n";
                    flush result_channel
                | Ok coordinator ->
                    output_string result_channel "winner\n";
                    flush result_channel;
                    let byte = Bytes.create 1 in
                    ignore (Unix.read release_read byte 0 1);
                    Compiler_workspace.stop_coordinator coordinator);
                close_out_noerr result_channel;
                Unix.close release_read;
                Unix._exit 0
            | pid -> pid)
      in
      Unix.close result_write;
      Unix.close release_read;
      let result_channel = Unix.in_channel_of_descr result_read in
      let outcomes = [ input_line result_channel; input_line result_channel ] in
      close_in_noerr result_channel;
      expect
        (List.sort String.compare outcomes = [ "loser"; "winner" ])
        "concurrent coordinator starts did not select exactly one owner";
      expect
        (match
           Compiler_workspace.connect
             (Compiler_workspace.coordinator_socket concurrent_root)
         with
        | Ok socket ->
            Unix.close socket;
            true
        | Error _ -> false)
        "the losing coordinator start removed the winner's live socket";
      ignore (Unix.write_substring release_write "x" 0 1);
      Unix.close release_write;
      List.iter
        (fun pid ->
          try ignore (Unix.waitpid [] pid) with Unix.Unix_error _ -> ())
        contenders);
  let directory = Filename.temp_dir "doclang-workspace-test-" "" in
  Fun.protect
    ~finally:(fun () -> remove_tree directory)
    (fun () ->
      write directory "models.live.md"
        "# Models\n\n    let description = \"Statistical models\"\n";
      write directory "models/statistics.live.md"
        "# Statistics\n\n    let mean values = List.length values\n";
      write directory "reports/forecast.live.md"
        "# Forecast\n\n\
         See [[Models.Statistics]]. Models.Statistics in ordinary prose stays \
         literal.\n\n\
        \    let label = \"Models.Statistics\"\n\
        \    let quoted = {tag|Models.Statistics|tag}\n\
        \    (* Models.Statistics in a comment *)\n\
        \    let model_description = Models.description\n\
        \    let result = Models.Statistics.mean [1; 2]\n";
      let project = Project.create directory in
      let snapshot = project_result (Project.snapshot project) in
      expect
        (Page_index.modules snapshot.page_index
        = [ "Models"; "Models.Statistics"; "Reports.Forecast" ])
        "page index did not allow a page to own child modules";
      let forecast_module_dependencies =
        Module_graph.dependencies snapshot.module_graph "Reports.Forecast"
      in
      expect
        (forecast_module_dependencies = [ "Models"; "Models.Statistics" ])
        ("module graph missed a qualified reference: "
        ^ String.concat ", " forecast_module_dependencies);
      expect
        (Module_graph.dependents snapshot.module_graph "Models.Statistics"
        = [ "Reports.Forecast" ])
        "reverse module graph missed a dependent";
      expect
        (Page_index.backlinks snapshot.page_index "Models.Statistics"
        = [ "Reports.Forecast" ])
        "page index missed a wiki-link backlink";
      let forecast =
        project_result (Project.page snapshot "Reports.Forecast")
      in
      let qualified_documents =
        project_result (Project.resolve_documents project snapshot forecast)
      in
      let qualified_evaluation =
        Evaluator.evaluate_documents ~project_version:snapshot.version
          ~documents:qualified_documents ~target:forecast ()
      in
      expect qualified_evaluation.ok
        "qualified page modules did not compile and evaluate";
      write directory "models/section.live.md"
        "# Section\n\n    let parent_result = Statistics.mean [1; 2]\n";
      write directory "models/section/consumer.live.md"
        "# Consumer\n\n    let child_result = Statistics.mean [1; 2; 3]\n";
      let nested_namespace_snapshot =
        project_result (Project.snapshot project)
      in
      let evaluate_nested module_path =
        let target =
          project_result (Project.page nested_namespace_snapshot module_path)
        in
        Evaluator.evaluate_documents
          ~project_version:nested_namespace_snapshot.version
          ~documents:
            (project_result
               (Project.resolve_documents project nested_namespace_snapshot
                  target))
          ~target ()
      in
      expect (evaluate_nested "Models.Section").ok
        "a page that became a namespace lost its ancestor imports";
      expect (evaluate_nested "Models.Section.Consumer").ok
        "a nested page lost imports from an ancestor namespace";
      let nested_analysis =
        Compiler_workspace.analyze ~target:"Models.Section.Consumer"
          ~root:directory ~version:nested_namespace_snapshot.version
          nested_namespace_snapshot.page_index
      in
      let nested_dependencies =
        nested_analysis.modules
        |> List.find_opt (fun (entry : Compiler_workspace.module_info) ->
            String.equal entry.module_path "Models.Section.Consumer")
        |> Option.map (fun (entry : Compiler_workspace.module_info) ->
            entry.uses)
        |> Option.value ~default:[]
      in
      expect
        (nested_analysis.ok && List.mem "Models.Statistics" nested_dependencies)
        ("compiler dependency analysis lost an ancestor-scope import: "
        ^ String.concat ", " nested_dependencies
        ^ " ("
        ^ String.concat "; " nested_analysis.diagnostics
        ^ ")");
      Sys.remove (Filename.concat directory "models/section/consumer.live.md");
      Sys.remove (Filename.concat directory "models/section.live.md");
      write directory "reports/shadow.live.md"
        "# Shadow\n\n\
        \    module Models = struct\n\
        \      module Statistics = struct\n\
        \        let mean _ = 99\n\
        \      end\n\
        \    end\n\
        \    let () = Printf.printf \"%d\\n\" (Models.Statistics.mean [])\n";
      let shadow_snapshot = project_result (Project.snapshot project) in
      let shadow =
        project_result (Project.page shadow_snapshot "Reports.Shadow")
      in
      let shadow_documents =
        project_result
          (Project.resolve_documents project shadow_snapshot shadow)
      in
      expect
        (Module_graph.dependencies shadow_snapshot.module_graph "Reports.Shadow"
        = [])
        "a locally shadowed namespace created a workspace dependency";
      let shadow_evaluation =
        Evaluator.evaluate_documents ~project_version:shadow_snapshot.version
          ~documents:shadow_documents ~target:shadow ()
      in
      expect
        (shadow_evaluation.ok && String.equal shadow_evaluation.stdout "99\n")
        "a local module did not shadow the workspace namespace";
      write directory "reports/declaration_order.live.md"
        "# Declaration order\n\n\
        \    let before_shadow = Models.Statistics.mean [1; 2]\n\
        \    module Models = struct end\n";
      let declaration_order_snapshot =
        project_result (Project.snapshot project)
      in
      expect
        (Module_graph.dependencies declaration_order_snapshot.module_graph
           "Reports.Declaration_order"
        = [ "Models.Statistics" ])
        "a reference before a local module declaration lost its dependency";
      let declaration_order =
        project_result
          (Project.page declaration_order_snapshot "Reports.Declaration_order")
      in
      let declaration_order_evaluation =
        Evaluator.evaluate_documents
          ~project_version:declaration_order_snapshot.version
          ~documents:
            (project_result
               (Project.resolve_documents project declaration_order_snapshot
                  declaration_order))
          ~target:declaration_order ()
      in
      expect declaration_order_evaluation.ok
        "a reference before a local module declaration did not compile";
      write directory "reports/nested_shadow.live.md"
        "# Nested shadow\n\n\
        \    module X = struct\n\
        \      module Models = struct end\n\
        \    end\n\
        \    let after_nested = Models.Statistics.mean [1; 2]\n";
      let nested_shadow_snapshot = project_result (Project.snapshot project) in
      let nested_shadow =
        project_result
          (Project.page nested_shadow_snapshot "Reports.Nested_shadow")
      in
      let nested_shadow_evaluation =
        Evaluator.evaluate_documents
          ~project_version:nested_shadow_snapshot.version
          ~documents:
            (project_result
               (Project.resolve_documents project nested_shadow_snapshot
                  nested_shadow))
          ~target:nested_shadow ()
      in
      expect nested_shadow_evaluation.ok
        "a nested local module hid a later workspace dependency";
      write directory "broken.live.md"
        "# Broken\n\n    let this_does_not_parse =\n";
      let partially_broken_snapshot =
        project_result (Project.snapshot project)
      in
      let nested_shadow =
        project_result
          (Project.page partially_broken_snapshot "Reports.Nested_shadow")
      in
      let nested_shadow_with_broken_page =
        Evaluator.evaluate_documents
          ~project_version:partially_broken_snapshot.version
          ~documents:
            (project_result
               (Project.resolve_documents project partially_broken_snapshot
                  nested_shadow))
          ~target:nested_shadow ()
      in
      expect nested_shadow_with_broken_page.ok
        ("an unrelated broken page discarded valid compiler dependencies: "
       ^ nested_shadow_with_broken_page.stderr
        ^ String.concat "\n"
            (List.map
               (fun diagnostic -> diagnostic.Evaluator.message)
               nested_shadow_with_broken_page.diagnostics));
      Sys.remove (Filename.concat directory "broken.live.md");
      write directory "reports/opened.live.md"
        "# Opened\n\n\
        \    open Models\n\
        \    let opened_result = Statistics.mean [1; 2]\n";
      let opened_snapshot = project_result (Project.snapshot project) in
      let opened =
        project_result (Project.page opened_snapshot "Reports.Opened")
      in
      expect
        (Module_graph.dependencies opened_snapshot.module_graph "Reports.Opened"
        = [ "Models"; "Models.Statistics" ])
        "an opened workspace namespace did not create a dependency";
      let opened_evaluation =
        Evaluator.evaluate_documents ~project_version:opened_snapshot.version
          ~documents:
            (project_result
               (Project.resolve_documents project opened_snapshot opened))
          ~target:opened ()
      in
      expect opened_evaluation.ok
        "open Models did not resolve the qualified workspace namespace";
      Sys.remove (Filename.concat directory "reports/opened.live.md");
      let compiler_graph =
        Compiler_workspace.analyze ~root:directory ~version:snapshot.version
          snapshot.page_index
      in
      expect compiler_graph.ok "the compiler-backed workspace analysis failed";
      let forecast_dependencies =
        List.find
          (fun (entry : Compiler_workspace.module_info) ->
            String.equal entry.Compiler_workspace.module_path "Reports.Forecast")
          compiler_graph.modules
      in
      expect
        (forecast_dependencies.uses = [ "Models"; "Models.Statistics" ])
        "the compiler did not report the qualified page dependency";
      let statistics_dependencies =
        List.find
          (fun (entry : Compiler_workspace.module_info) ->
            String.equal entry.module_path "Models.Statistics")
          compiler_graph.modules
      in
      expect
        (statistics_dependencies.used_by = [ "Reports.Forecast" ])
        "the compiler graph did not report a reverse page dependency";
      let statistics =
        project_result (Project.page snapshot "Models.Statistics")
      in
      write directory "notes.live.md" "# Notes\n";
      let changed_source = statistics.source ^ "\nA prose-only autosave.\n" in
      let _, saved_snapshot, acknowledged =
        project_result
          (Project.save_page_source project ~module_path:"Models.Statistics"
             ~source:changed_source ~expected_digest:statistics.version
             ~edit_revision:7)
      in
      expect (acknowledged = 7) "autosave did not acknowledge its revision";
      expect
        (Option.is_some (Page_index.find saved_snapshot.page_index "Notes"))
        "an unrelated external page change was lost during autosave";
      let created, _, created_snapshot =
        project_result
          (Project.create_page project ~module_path:"Models.Linear"
             ~base_project_version:saved_snapshot.version ~principal:"test")
      in
      expect
        (String.equal created.path "models/linear.live.md")
        "nested module creation used the wrong source path";
      let batch_created, batch_snapshot =
        project_result
          (Project.create_pages project ~module_paths:[ "Batch"; "Batch.Child" ]
             ~base_project_version:created_snapshot.version ~principal:"test")
      in
      expect
        (List.map (fun document -> document.Document.path) batch_created
         = [ "batch.live.md"; "batch/child.live.md" ]
        && Option.is_some (Page_index.find batch_snapshot.page_index "Batch")
        && Option.is_some
             (Page_index.find batch_snapshot.page_index "Batch.Child"))
        "batch page creation did not publish a parent and child together";
      expect
        (Result.is_error
           (Project.create_pages project
              ~module_paths:[ "Batch.New"; "Models.Linear" ]
              ~base_project_version:batch_snapshot.version ~principal:"test")
        && not (Sys.file_exists (Filename.concat directory "batch/new.live.md"))
        )
        "a conflicting batch creation published only part of the batch";
      let renames =
        [
          {
            Project.before = "Models.Statistics";
            after = "Analysis.Statistics";
          };
        ]
      in
      let _, renamed_snapshot, _ =
        let preview_id = Project.refactor_preview_id batch_snapshot renames in
        project_result
          (Project.apply_module_refactor project
             ~expected_project_version:batch_snapshot.version
             ~expected_preview_id:preview_id renames)
      in
      expect
        (Option.is_some
           (Page_index.find renamed_snapshot.page_index "Analysis.Statistics"))
        "module refactor did not create the renamed identity";
      expect
        (not
           (Sys.file_exists
              (Filename.concat directory "models/statistics.live.md")))
        "module refactor left the old source path behind";
      let forecast =
        project_result (Project.page renamed_snapshot "Reports.Forecast")
      in
      expect
        (try
           ignore
             (Str.search_forward
                (Str.regexp_string "Analysis.Statistics.mean")
                forecast.source 0);
           true
         with Not_found -> false)
        "module refactor did not rewrite a qualified reference";
      expect
        (try
           ignore
             (Str.search_forward
                (Str.regexp_string "\"Models.Statistics\"")
                forecast.source 0);
           ignore
             (Str.search_forward
                (Str.regexp_string "{tag|Models.Statistics|tag}")
                forecast.source 0);
           ignore
             (Str.search_forward
                (Str.regexp_string
                   "Models.Statistics in ordinary prose stays literal")
                forecast.source 0);
           true
         with Not_found -> false)
        "module refactor rewrote prose, comments, or string literals";
      write directory "alpha.live.md" "# Alpha\n\n    let alpha = 1\n";
      write directory "bravo.live.md" "# Bravo\n\n    let bravo = 2\n";
      let swap_snapshot = project_result (Project.snapshot project) in
      let swap =
        [
          { Project.before = "Alpha"; after = "Bravo" };
          { Project.before = "Bravo"; after = "Alpha" };
        ]
      in
      let _, swapped_snapshot, _ =
        project_result
          (Project.apply_module_refactor project
             ~expected_project_version:swap_snapshot.version
             ~expected_preview_id:
               (Project.refactor_preview_id swap_snapshot swap)
             swap)
      in
      let alpha = project_result (Project.page swapped_snapshot "Alpha") in
      let bravo = project_result (Project.page swapped_snapshot "Bravo") in
      expect
        (try
           ignore
             (Str.search_forward
                (Str.regexp_string "let bravo = 2")
                alpha.source 0);
           true
         with Not_found -> false)
        "a swap refactor clobbered the first module";
      expect
        (try
           ignore
             (Str.search_forward
                (Str.regexp_string "let alpha = 1")
                bravo.source 0);
           true
         with Not_found -> false)
        "a swap refactor clobbered the second module";
      write directory "manual.live.md"
        "# Manual\n\n    let title = \"Manual\"\n";
      write directory "manual/start.live.md"
        "# Start\n\n    let summary = \"Start\"\n";
      let parent_snapshot = project_result (Project.snapshot project) in
      let parent_renames =
        [
          { Project.before = "Manual"; after = "Guides" };
          { Project.before = "Manual.Start"; after = "Guides.Start" };
        ]
      in
      let _, parent_renamed_snapshot, _ =
        project_result
          (Project.apply_module_refactor project
             ~expected_project_version:parent_snapshot.version
             ~expected_preview_id:
               (Project.refactor_preview_id parent_snapshot parent_renames)
             parent_renames)
      in
      expect
        (Option.is_some
           (Page_index.find parent_renamed_snapshot.page_index "Guides")
        && Option.is_some
             (Page_index.find parent_renamed_snapshot.page_index "Guides.Start")
        && Option.is_none
             (Page_index.find parent_renamed_snapshot.page_index "Manual"))
        "namespace refactor did not carry its parent page";
      let guides = outline_entry parent_renamed_snapshot.page_index "Guides" in
      expect
        (Yojson.Safe.Util.member "pageModule" guides = `String "Guides"
        && Yojson.Safe.Util.member "hasChildren" guides = `Bool true)
        "renamed parent page lost its children";
      let handbook_source = "# Handbook\n\n    let title = \"Handbook\"\n" in
      let handbook_start_source =
        "# Start\n\n    let introduction = \"Start\"\n"
      in
      let handbook_advanced_source = "# Advanced\n\n    let level = 2\n" in
      write directory "handbook.live.md" handbook_source;
      write directory "handbook/start.live.md" handbook_start_source;
      write directory "handbook/topics/advanced.live.md"
        handbook_advanced_source;
      let reparent_snapshot = project_result (Project.snapshot project) in
      let reparent_renames =
        [
          { Project.before = "Handbook"; after = "Reference.Handbook" };
          {
            Project.before = "Handbook.Start";
            after = "Reference.Handbook.Start";
          };
          {
            Project.before = "Handbook.Topics.Advanced";
            after = "Reference.Handbook.Topics.Advanced";
          };
        ]
      in
      let _, reparented_snapshot, _ =
        project_result
          (Project.apply_module_refactor project
             ~expected_project_version:reparent_snapshot.version
             ~expected_preview_id:
               (Project.refactor_preview_id reparent_snapshot reparent_renames)
             reparent_renames)
      in
      let reparented_modules =
        Page_index.modules reparented_snapshot.page_index
      in
      expect
        (List.for_all
           (fun module_path -> List.mem module_path reparented_modules)
           [
             "Reference.Handbook";
             "Reference.Handbook.Start";
             "Reference.Handbook.Topics.Advanced";
           ]
        && List.for_all
             (fun module_path -> not (List.mem module_path reparented_modules))
             [ "Handbook"; "Handbook.Start"; "Handbook.Topics.Advanced" ])
        "namespace reparent lost pages or retained old module identities";
      let reparented_handbook =
        outline_entry reparented_snapshot.page_index "Reference.Handbook"
      in
      expect
        (Yojson.Safe.Util.member "pageModule" reparented_handbook
         = `String "Reference.Handbook"
        && Yojson.Safe.Util.member "namespace" reparented_handbook = `Bool true
        && Yojson.Safe.Util.member "hasChildren" reparented_handbook
           = `Bool true)
        "namespace reparent detached its parent page";
      let reparented_handbook_page =
        project_result (Project.page reparented_snapshot "Reference.Handbook")
      in
      let reparented_start =
        project_result
          (Project.page reparented_snapshot "Reference.Handbook.Start")
      in
      let reparented_advanced =
        project_result
          (Project.page reparented_snapshot "Reference.Handbook.Topics.Advanced")
      in
      expect
        (String.equal reparented_handbook_page.source handbook_source
        && String.equal reparented_start.source handbook_start_source
        && String.equal reparented_advanced.source handbook_advanced_source)
        "namespace reparent did not preserve page contents";
      write directory "bad-name.live.md" "# Needs migration\n";
      let migration_snapshot = project_result (Project.snapshot project) in
      expect
        (migration_snapshot.page_index.diagnostics <> [])
        "an invalid existing path did not produce a migration diagnostic";
      expect
        (Option.is_some
           (Page_index.find migration_snapshot.page_index "Analysis.Statistics"))
        "an invalid existing path made valid pages unavailable";
      write directory "a/b/c.live.md" "# Deep page\n\n    let value = 1\n";
      let passive_snapshot = project_result (Project.snapshot project) in
      let coordinator =
        result
          (Compiler_workspace.start_coordinator ~root:directory
             passive_snapshot.page_index)
      in
      Fun.protect
        ~finally:(fun () -> Compiler_workspace.stop_coordinator coordinator)
        (fun () ->
          expect
            (Result.is_error
               (Compiler_workspace.start_coordinator ~root:directory
                  passive_snapshot.page_index))
            "a second server was allowed to share coordinator ownership";
          let analyze () =
            Compiler_workspace.analyze ~target:"A.B.C" ~root:directory
              ~version:passive_snapshot.version passive_snapshot.page_index
          in
          let canceled_pages =
            Compiler_workspace.generated_pages passive_snapshot.page_index
            |> List.map (fun (page : Compiler_workspace.generated_page) ->
                if String.equal page.module_path "A.B.C" then
                  { page with source = "open Doclang_prelude\nlet value =\n" }
                else page)
          in
          let children =
            List.init 12 (fun _ ->
                match Unix.fork () with
                | 0 ->
                    (try
                       ignore
                         (Compiler_workspace.analyze_via_coordinator
                            ~cancelled:(fun () -> true)
                            ~socket_path:coordinator.socket_path ~target:"A.B.C"
                            canceled_pages)
                     with Evaluator.Cancelled -> ());
                    Unix._exit 0
                | pid -> pid)
          in
          List.iter
            (fun pid ->
              try ignore (Unix.waitpid [] pid) with Unix.Unix_error _ -> ())
            children;
          let started = Unix.gettimeofday () in
          let latest_analysis = analyze () in
          expect latest_analysis.ok
            ("a deep qualified module failed through passive Dune RPC: "
            ^ String.concat "\n" latest_analysis.diagnostics);
          expect
            (Unix.gettimeofday () -. started < 8.)
            "canceled compiler drafts backlogged ahead of the latest request";
          let watcher_pid =
            result
              (Util.read_file (Compiler_workspace.watcher_pid_path directory))
            |> String.trim |> int_of_string
          in
          Unix.kill (-watcher_pid) Sys.sigkill;
          ignore (Unix.select [] [] [] 0.05);
          expect (analyze ()).ok
            "the build coordinator did not restart a failed Dune watcher";
          let current_pid = Unix.getpid () in
          result
            (Util.write_file_atomic
               (Compiler_workspace.watcher_pid_path directory)
               (string_of_int current_pid));
          Compiler_workspace.stop_recorded_watcher directory;
          expect
            (try
               Unix.kill current_pid 0;
               true
             with Unix.Unix_error _ -> false)
            "stale watcher cleanup signaled a process it did not own";
          let malicious_page =
            `Assoc
              [
                ("module", `String "A.B.C");
                ("sourcePath", `String "a/b/c.live.md");
                ("generatedPath", `String "../../outside.ml");
                ("source", `String "let value = 2\n");
              ]
          in
          expect
            (Result.is_error
               (Compiler_workspace.validate_pages ~root:directory
                  [ malicious_page ]))
            "the coordinator accepted an arbitrary generated path";
          Compiler_workspace.detach_coordinator_owner coordinator;
          let rec wait_for_owner_exit attempts =
            if
              attempts <= 0
              || not (Compiler_workspace.coordinator_alive coordinator)
            then ()
            else (
              ignore (Unix.select [] [] [] 0.02);
              wait_for_owner_exit (attempts - 1))
          in
          wait_for_owner_exit 100;
          expect
            (not (Compiler_workspace.coordinator_alive coordinator))
            "the coordinator survived the loss of its owning server";
          let replacement =
            result
              (Compiler_workspace.start_coordinator ~root:directory
                 passive_snapshot.page_index)
          in
          Compiler_workspace.stop_coordinator replacement);
      print_endline "workspace tests passed")
