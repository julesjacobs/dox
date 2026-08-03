let usage () =
  Printf.eprintf
    "Usage:\n\
    \  dox serve [--root DIR] [--assets DIR] [--port PORT]\n\
    \             [--public-origin HOST:PORT] [--collaboration-port PORT]\n\
    \             [--public-collaboration-port PORT]\n\
    \             [--execution (browser|server)]\n\
    \  dox check FILE\n\
    \  dox audit-data FILE\n\
    \  dox artifact FILE ENTRY OUTPUT\n";
  exit 2

type serve_config = {
  root : string;
  assets : string;
  port : int;
  (* Set --public-origin when Dox is reached through a reverse proxy: it is the
     externally visible "host:port". Without it the workspace rejects any
     request whose Host is not loopback. --collaboration-port pins the
     collaboration service (default 0 picks an ephemeral port) so a proxy can be
     placed in front of it, and --public-collaboration-port is the port the
     browser should use for the WebSocket. *)
  public_origin : string option;
  collaboration_port : int;
  public_collaboration_port : int option;
  (* --execution browser refuses server-side evaluation. Use it for any
     deployment reachable by more than the person who started Dox. *)
  browser_execution_only : bool;
}

let rec serve_options config = function
  | [] ->
      Server.serve ~root:config.root ~assets:config.assets ~port:config.port
        ~public_origin:config.public_origin
        ~collaboration_port:config.collaboration_port
        ~public_collaboration_port:config.public_collaboration_port
        ~browser_execution_only:config.browser_execution_only
  | "--root" :: value :: rest -> serve_options { config with root = value } rest
  | "--assets" :: value :: rest ->
      serve_options { config with assets = value } rest
  | "--port" :: value :: rest -> (
      match int_of_string_opt value with
      | Some port -> serve_options { config with port } rest
      | None -> usage ())
  | "--public-origin" :: value :: rest ->
      if not (String.contains value ':') then usage ()
      else serve_options { config with public_origin = Some value } rest
  | "--collaboration-port" :: value :: rest -> (
      match int_of_string_opt value with
      | Some collaboration_port ->
          serve_options { config with collaboration_port } rest
      | None -> usage ())
  | "--public-collaboration-port" :: value :: rest -> (
      match int_of_string_opt value with
      | Some port ->
          serve_options { config with public_collaboration_port = Some port } rest
      | None -> usage ())
  | "--execution" :: "browser" :: rest ->
      serve_options { config with browser_execution_only = true } rest
  | "--execution" :: "server" :: rest ->
      serve_options { config with browser_execution_only = false } rest
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
      serve_options
        {
          root = Sys.getcwd ();
          assets = Filename.concat (Sys.getcwd ()) "web";
          port = 8080;
          public_origin = None;
          collaboration_port = 0;
          public_collaboration_port = None;
          browser_execution_only = false;
        }
        rest
  | [ _; "check"; path ] -> check path
  | [ _; "audit-data"; path ] -> audit_data path
  | [ _; "artifact"; path; entry; output ] -> artifact path entry output
  | _ -> usage ()
