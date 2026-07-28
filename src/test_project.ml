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
      let direct =
        match Project.direct_page project "Change" with
        | Ok page -> page
        | Error error -> fail (Project.error_message error)
      in
      expect
        (String.equal direct.path "change.live.md"
        && String.equal direct.document.version document.version)
        "direct page read did not return the canonical document";
      let context : Server.context =
        { project; assets = directory; port = 0; session_token = "test" }
      in
      let unchanged_response =
        Server.page_response context
          ~cancelled:(fun () -> false)
          [ ("module", "Change"); ("ifDigest", document.version) ]
      in
      let unchanged_json = Yojson.Safe.from_string unchanged_response.body in
      expect
        (Yojson.Safe.Util.member "notModified" unchanged_json = `Bool true
        && Yojson.Safe.Util.member "document" unchanged_json = `Null
        && Yojson.Safe.Util.member "project" unchanged_json = `Null)
        "conditional page read returned a snapshot or repeated the document";
      let changed_response =
        Server.page_response context
          ~cancelled:(fun () -> false)
          [ ("module", "Change"); ("ifDigest", "different") ]
      in
      let changed_json = Yojson.Safe.from_string changed_response.body in
      expect
        (Yojson.Safe.Util.member "notModified" changed_json = `Bool false
        && Yojson.Safe.Util.member "document" changed_json <> `Null
        && Yojson.Safe.Util.member "projectVersion" changed_json = `Null)
        "changed direct page read did not return only document-local state";
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
      expect
        (Result.is_error (Project.direct_page project "Escape"))
        "direct page read followed a leaf symlink";
      Sys.remove outside_path;
      (match Util.ensure_directory (Filename.concat directory "real") with
      | Ok () -> ()
      | Error message -> fail message);
      (match
         Util.write_file
           (Filename.concat directory "real/page.live.md")
           "# Symlinked parent\n"
       with
      | Ok () -> ()
      | Error message -> fail message);
      Unix.symlink "real" (Filename.concat directory "linked");
      expect
        (Result.is_error (Project.direct_page project "Linked.Page"))
        "direct page read followed a symlinked parent directory";
      let replacement_outside =
        Filename.temp_dir "doclang-direct-page-replacement-outside-" ""
      in
      Fun.protect
        ~finally:(fun () -> remove_tree replacement_outside)
        (fun () ->
          let safe_source = "# Descriptor-anchored page\n" in
          let outside_source = "# Outside replacement\n" in
          let parent = Filename.concat directory "replacement" in
          let parked = Filename.concat directory "replacement-parked" in
          let outside_parent = Filename.concat replacement_outside "inner" in
          (match Util.ensure_directory (Filename.concat parent "inner") with
          | Ok () -> ()
          | Error message -> fail message);
          (match Util.ensure_directory outside_parent with
          | Ok () -> ()
          | Error message -> fail message);
          (match
             Util.write_file
               (Filename.concat parent "inner/page.live.md")
               safe_source
           with
          | Ok () -> ()
          | Error message -> fail message);
          (match
             Util.write_file
               (Filename.concat outside_parent "page.live.md")
               outside_source
           with
          | Ok () -> ()
          | Error message -> fail message);
          let replacement_pid =
            match Unix.fork () with
            | 0 -> (
                let restore () =
                  (try if Sys.file_exists parent then Sys.remove parent
                   with Sys_error _ -> ());
                  if Sys.file_exists parked then
                    try Unix.rename parked parent with Unix.Unix_error _ -> ()
                in
                try
                  for _ = 1 to 2_000 do
                    Unix.rename parent parked;
                    Unix.symlink replacement_outside parent;
                    Sys.remove parent;
                    Unix.rename parked parent
                  done;
                  Unix._exit 0
                with _ ->
                  restore ();
                  Unix._exit 2)
            | pid -> pid
          in
          let escaped = ref false in
          for _ = 1 to 1_000 do
            match Project.direct_page project "Replacement.Inner.Page" with
            | Ok page ->
                if not (String.equal page.document.source safe_source) then
                  escaped := true
            | Error _ -> ()
          done;
          let _, replacement_status = Unix.waitpid [] replacement_pid in
          expect
            (replacement_status = Unix.WEXITED 0)
            "the concurrent parent replacement process failed";
          let final_page =
            match Project.direct_page project "Replacement.Inner.Page" with
            | Ok page -> page
            | Error error -> fail (Project.error_message error)
          in
          expect
            ((not !escaped)
            && String.equal final_page.document.source safe_source)
            "direct page read escaped through a concurrently replaced parent");
      let lock_ready_read, lock_ready_write = Unix.pipe ~cloexec:true () in
      let lock_release_read, lock_release_write = Unix.pipe ~cloexec:true () in
      let lock_holder =
        match Unix.fork () with
        | 0 ->
            Unix.close lock_ready_read;
            Unix.close lock_release_write;
            Util.with_file_lock (Project.lock_path project) (fun () ->
                ignore (Unix.write_substring lock_ready_write "x" 0 1);
                let byte = Bytes.create 1 in
                ignore (Unix.read lock_release_read byte 0 1));
            Unix._exit 0
        | pid -> pid
      in
      Unix.close lock_ready_write;
      Unix.close lock_release_read;
      let byte = Bytes.create 1 in
      ignore (Unix.read lock_ready_read byte 0 1);
      Unix.close lock_ready_read;
      let waiter_read, waiter_write = Unix.pipe ~cloexec:true () in
      let waiters =
        List.init 20 (fun _ ->
            match Unix.fork () with
            | 0 ->
                Unix.close waiter_read;
                Unix.close lock_release_write;
                let cancel_at = Unix.gettimeofday () +. 0.05 in
                let outcome =
                  try
                    ignore
                      (Project.direct_page
                         ~cancelled:(fun () ->
                           Unix.gettimeofday () >= cancel_at)
                         project "Change");
                    "f"
                  with Evaluator.Cancelled -> "c"
                in
                ignore (Unix.write_substring waiter_write outcome 0 1);
                Unix.close waiter_write;
                Unix._exit 0
            | pid -> pid)
      in
      Unix.close waiter_write;
      let outcomes = Bytes.create (List.length waiters) in
      let rec collect offset deadline =
        if offset = Bytes.length outcomes then offset
        else
          let remaining = deadline -. Unix.gettimeofday () in
          if remaining <= 0. then offset
          else
            match Unix.select [ waiter_read ] [] [] remaining with
            | [], _, _ -> offset
            | _ ->
                let count =
                  Unix.read waiter_read outcomes offset
                    (Bytes.length outcomes - offset)
                in
                if count = 0 then offset else collect (offset + count) deadline
      in
      let outcome_count = collect 0 (Unix.gettimeofday () +. 2.) in
      Unix.close waiter_read;
      ignore (Unix.write_substring lock_release_write "x" 0 1);
      Unix.close lock_release_write;
      (try ignore (Unix.waitpid [] lock_holder) with Unix.Unix_error _ -> ());
      List.iter
        (fun pid ->
          try ignore (Unix.waitpid [] pid) with Unix.Unix_error _ -> ())
        waiters;
      expect
        (outcome_count = Bytes.length outcomes
        && Bytes.for_all (Char.equal 'c') outcomes)
        "canceled direct reads remained queued on the project lock";
      let worker_socket = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
      Unix.set_close_on_exec worker_socket;
      Unix.bind worker_socket (Unix.ADDR_INET (Unix.inet_addr_loopback, 0));
      Unix.listen worker_socket 4;
      let worker_address = Unix.getsockname worker_socket in
      let exited_workers =
        List.init 16 (fun _ ->
            match Unix.fork () with 0 -> Unix._exit 0 | pid -> pid)
      in
      let connector =
        match Unix.fork () with
        | 0 ->
            ignore (Unix.select [] [] [] 0.05);
            let socket = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
            Unix.connect socket worker_address;
            Unix.close socket;
            Unix._exit 0
        | pid -> pid
      in
      let accepted, _, live_workers =
        Server.accept_and_reap_workers worker_socket exited_workers
      in
      Unix.close accepted;
      Unix.close worker_socket;
      List.iter
        (fun pid ->
          try ignore (Unix.waitpid [] pid) with Unix.Unix_error _ -> ())
        exited_workers;
      (try ignore (Unix.waitpid [] connector) with Unix.Unix_error _ -> ());
      expect (live_workers = [])
        "workers that exited during accept still consumed the worker cap";
      let recovery_before = "# Before recovery\n" in
      let recovery_after = "# After recovery\n" in
      let recovery_path = Filename.concat directory "recovery.live.md" in
      let recovery_directory =
        Filename.concat directory ".doclang/transactions/recovery-test.files"
      in
      let recovery_quarantine = Filename.concat recovery_directory "document" in
      let recovery_intent =
        Filename.concat directory ".doclang/transactions/recovery-test.json"
      in
      (match Util.write_file recovery_path recovery_before with
      | Ok () -> ()
      | Error message -> fail message);
      (match Util.ensure_directory recovery_directory with
      | Ok () -> ()
      | Error message -> fail message);
      Unix.rename recovery_path recovery_quarantine;
      (match
         Util.write_file recovery_intent
           (Yojson.Safe.to_string
              (`Assoc
                 [
                   ("kind", `String "page-save");
                   ("path", `String "recovery.live.md");
                   ("beforeSource", `String recovery_before);
                   ("afterSource", `String recovery_after);
                   ("quarantine", `String recovery_quarantine);
                   ("change", `Null);
                 ]))
       with
      | Ok () -> ()
      | Error message -> fail message);
      let recovered =
        match Project.direct_page project "Recovery" with
        | Ok page -> page.document
        | Error error -> fail (Project.error_message error)
      in
      expect
        (String.equal recovered.source recovery_after
        && (not (Sys.file_exists recovery_intent))
        && not (Sys.file_exists recovery_quarantine))
        "direct page read did not recover an abandoned page transaction";
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
