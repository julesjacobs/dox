let fail message =
  prerr_endline message;
  exit 1

let expect condition message = if not condition then fail message

let remove_tree root =
  let rec remove path =
    if (Unix.lstat path).st_kind = Unix.S_DIR then (
      Sys.readdir path
      |> Array.iter (fun name -> remove (Filename.concat path name));
      Unix.rmdir path)
    else Sys.remove path
  in
  if Sys.file_exists root then remove root

let original =
  "# Change test\n\n\
   ```ocaml name=a\n\
   let a = 1\n\
   ```\n\n\
   ```ocaml name=b\n\
   let b = a + 1\n\
   ```\n"

let changed =
  Str.global_replace (Str.regexp_string "let a = 1") "let a = 2" original

let strings name json =
  Yojson.Safe.Util.member name json
  |> Yojson.Safe.Util.to_list
  |> List.map Yojson.Safe.Util.to_string

let () =
  let directory = Filename.temp_dir "doclang-project-test-" "" in
  Fun.protect
    ~finally:(fun () -> remove_tree directory)
    (fun () ->
      let path = Filename.concat directory "change.live.md" in
      (match Util.write_file path original with
      | Ok () -> ()
      | Error message -> fail message);
      let project = Project.create directory in
      let grouped_before =
        Document.parse ~path:"grouped.live.md"
          "```ocaml\n\
           let observations = [ 1.; 2. ]\n\
           let mean = List.length observations\n\
           ```\n"
      in
      let grouped_after =
        Document.parse ~path:"grouped.live.md"
          "```ocaml\n\
           let observations = [ 1.; 2.; 3. ]\n\
           let mean = List.length observations\n\
           ```\n"
      in
      let grouped_direct =
        Project.changed_definition_names grouped_before grouped_after
      in
      expect
        (grouped_direct = [ "observations" ])
        "a whole code block was incorrectly classified as directly edited";
      expect
        (Project.affected_definition_names grouped_before grouped_after
           grouped_direct
        = [ "mean" ])
        "definition-level impact analysis missed a dependent definition";
      let document =
        match Project.read_document project "change.live.md" with
        | Ok document -> document
        | Error error -> fail (Project.error_message error)
      in
      let snapshot =
        match Project.snapshot project with
        | Ok snapshot -> snapshot
        | Error error -> fail (Project.error_message error)
      in
      let draft = Document.parse ~path:"change.live.md" changed in
      let validation =
        Evaluator.evaluate ~project_version:snapshot.version draft
      in
      let change =
        match
          Project.save_document project ~path:"change.live.md" ~source:changed
            ~base_version:document.version
            ~base_project_version:snapshot.version ~principal:"test" ~validation
        with
        | Ok (_, change, _) -> change
        | Error error -> fail (Project.error_message error)
      in
      expect
        (strings "directEntities" change = [ "a" ])
        "direct edit attribution was incorrect";
      expect
        (strings "affectedEntities" change = [ "b" ])
        "transitive impact attribution was incorrect";
      let change_id =
        Yojson.Safe.Util.member "id" change |> Yojson.Safe.Util.to_string
      in
      let detail =
        match Project.change_by_id project change_id with
        | Ok detail -> detail
        | Error error -> fail (Project.error_message error)
      in
      expect
        (Yojson.Safe.Util.member "beforeSource" detail = `String original)
        "change set did not preserve its before source";
      expect
        (Yojson.Safe.Util.member "afterSource" detail = `String changed)
        "change set did not preserve its after source";
      expect
        (Result.is_error
           (Project.save_document project ~path:"change.live.md"
              ~source:original ~base_version:document.version
              ~base_project_version:snapshot.version ~principal:"test"
              ~validation))
        "stale project version was accepted";
      let outside_path = Filename.temp_file "doclang-outside-" ".live.md" in
      (match Util.write_file outside_path "# Outside\n" with
      | Ok () -> ()
      | Error message -> fail message);
      Unix.symlink outside_path (Filename.concat directory "escape.live.md");
      expect
        (Result.is_error (Project.read_document project "escape.live.md"))
        "symlink escaped the project boundary";
      Sys.remove outside_path;
      (match
         Util.write_file
           (Filename.concat directory "library.live.md")
           "```ocaml name=shared\nlet shared = 41\n```\n"
       with
      | Ok () -> ()
      | Error message -> fail message);
      (match
         Util.write_file
           (Filename.concat directory "importer.live.md")
           "```ocaml name=result\n\
            let answer = Library.shared + 1\n\
            let () = Doc.value ~id:\"result\" ~type_:\"int\" (string_of_int \
            answer)\n\
            ```\n"
       with
      | Ok () -> ()
      | Error message -> fail message);
      let imported_snapshot =
        match Project.snapshot project with
        | Ok snapshot -> snapshot
        | Error error -> fail (Project.error_message error)
      in
      expect
        (Result.is_error
           (Project.create_document project ~path:"./noncanonical.live.md"
              ~source:"# Invalid path\n"
              ~base_project_version:imported_snapshot.version ~principal:"test"))
        "non-canonical project path was accepted";
      let importer =
        match Project.document imported_snapshot "importer.live.md" with
        | Ok document -> document
        | Error error -> fail (Project.error_message error)
      in
      let closure =
        match Project.resolve_documents project imported_snapshot importer with
        | Ok documents -> documents
        | Error error -> fail (Project.error_message error)
      in
      expect
        (List.map (fun document -> document.Document.path) closure
        = [ "library.live.md"; "importer.live.md" ])
        "multi-file dependency closure was not ordered";
      let imported_evaluation =
        Evaluator.evaluate_documents ~project_version:imported_snapshot.version
          ~documents:closure ~target:importer ()
      in
      expect imported_evaluation.ok "multi-file program did not evaluate";
      (match
         Util.write_file
           (Filename.concat directory "failing.live.md")
           "```ocaml name=main\n\
            let main () = ()\n\
            let () = failwith \"validation failure\"\n\
            ```\n"
       with
      | Ok () -> ()
      | Error message -> fail message);
      let failing_snapshot =
        match Project.snapshot project with
        | Ok snapshot -> snapshot
        | Error error -> fail (Project.error_message error)
      in
      let failing_document =
        match Project.document failing_snapshot "failing.live.md" with
        | Ok document -> document
        | Error error -> fail (Project.error_message error)
      in
      expect
        (Result.is_error
           (Project.build_artifact project ~path:"failing.live.md" ~entry:"main"
              ~name:"must-not-publish"
              ~expected_project_version:failing_snapshot.version
              ~expected_document_version:failing_document.version
              ~principal:"test"))
        "artifact was published after failed validation";
      let publication_path =
        Filename.concat directory "publication-race.live.md"
      in
      let quarantine_path =
        Filename.concat directory ".doclang/test-publication-quarantine"
      in
      (match Util.write_file publication_path "external edit" with
      | Ok () -> ()
      | Error message -> fail message);
      expect
        (Result.is_error
           (Project.publish_refactor_target ~path:publication_path
              ~quarantine:quarantine_path ~expected:(Some "old source")
              ~source:"new source"))
        "refactor publication accepted an external edit";
      expect
        (Util.read_file publication_path = Ok "external edit")
        "refactor publication lost an external edit";
      expect
        (not (Sys.file_exists quarantine_path))
        "a rejected publication left a restored quarantine behind";
      (match Util.write_file publication_path "old source" with
      | Ok () -> ()
      | Error message -> fail message);
      (match
         Project.publish_refactor_target ~path:publication_path
           ~quarantine:quarantine_path ~expected:(Some "old source")
           ~source:"new source"
       with
      | Ok () -> ()
      | Error error -> fail (Project.error_message error));
      expect
        (Util.read_file publication_path = Ok "new source"
        && Util.read_file quarantine_path = Ok "old source")
        "refactor publication did not preserve displaced contents";
      (match Project.remove_checked quarantine_path with
      | Ok () -> ()
      | Error message -> fail message);
      print_endline "project tests passed")
