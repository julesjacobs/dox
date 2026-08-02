let usage () =
  Printf.eprintf
    "Usage:\n\
    \  dox serve [--root DIR] [--assets DIR] [--port PORT]\n\
    \  dox check FILE\n\
    \  dox audit-data FILE\n\
    \  dox artifact FILE ENTRY OUTPUT\n";
  exit 2

let rec serve_options root assets port = function
  | [] -> Server.serve ~root ~assets ~port
  | "--root" :: value :: rest -> serve_options value assets port rest
  | "--assets" :: value :: rest -> serve_options root value port rest
  | "--port" :: value :: rest -> (
      match int_of_string_opt value with
      | Some port -> serve_options root assets port rest
      | None -> usage ())
  | _ -> usage ()

let check path =
  let project = Project.create (Sys.getcwd ()) in
  match Project.snapshot project with
  | Ok snapshot -> (
      match Project.document snapshot path with
      | Ok document -> (
          match Project.resolve_documents project snapshot document with
          | Error error ->
              prerr_endline (Project.error_message error);
              exit 1
          | Ok documents ->
              let result =
                Evaluator.evaluate_documents ~project_version:snapshot.version
                  ~documents ~target:document ()
              in
              print_endline
                (Yojson.Safe.pretty_to_string (Evaluator.to_json result));
              if not result.ok then exit 1)
      | Error _ -> (
          match Util.read_file path with
          | Error message ->
              prerr_endline message;
              exit 1
          | Ok source ->
              let document = Document.parse ~path source in
              let result = Evaluator.evaluate document in
              print_endline
                (Yojson.Safe.pretty_to_string (Evaluator.to_json result));
              if not result.ok then exit 1))
  | Error error ->
      prerr_endline (Project.error_message error);
      exit 1

let audit_data path =
  let project = Project.create (Sys.getcwd ()) in
  match Project.snapshot project with
  | Error error ->
      prerr_endline (Project.error_message error);
      exit 1
  | Ok snapshot -> (
      match Project.document snapshot path with
      | Error error ->
          prerr_endline (Project.error_message error);
          exit 1
      | Ok target -> (
          match Project.resolve_documents project snapshot target with
          | Error error ->
              prerr_endline (Project.error_message error);
              exit 1
          | Ok documents ->
              let evaluation =
                Evaluator.evaluate_documents
                  ~project_version:snapshot.version ~documents ~target ()
              in
              print_endline
                (Yojson.Safe.pretty_to_string
                   (`Assoc
                      [
                        ("path", `String target.Document.path);
                        ("source", `String target.Document.source);
                        ("projectVersion", `String snapshot.version);
                        ("evaluation", Evaluator.to_json evaluation);
                      ]));
              if not evaluation.ok then exit 1))

let artifact path entry output =
  match Util.read_file path with
  | Error message ->
      prerr_endline message;
      exit 1
  | Ok source -> (
      let document = Document.parse ~path source in
      match Evaluator.build_artifact ~document ~entry ~output with
      | Ok (source_path, _) ->
          Printf.printf "Built %s from %s\n" output source_path
      | Error message ->
          prerr_endline message;
          exit 1)

let () =
  match Array.to_list Sys.argv with
  | _ :: "serve" :: rest ->
      serve_options (Sys.getcwd ())
        (Filename.concat (Sys.getcwd ()) "web")
        8080 rest
  | [ _; "check"; path ] -> check path
  | [ _; "audit-data"; path ] -> audit_data path
  | [ _; "artifact"; path; entry; output ] -> artifact path entry output
  | _ -> usage ()
