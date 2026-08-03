type response = {
  status : int;
  content_type : string;
  body : string;
  extra_headers : (string * string) list;
}

type context = {
  project : Project.t;
  assets : string;
  port : int;
  collaboration_port : int;
  (* Externally visible "host:port" when Dox is reached through a reverse proxy
     instead of on loopback, and the collaboration port the browser should
     connect to (a proxy in front of the collaboration service, which itself
     stays on loopback). None / equal-to-local when serving only on loopback. *)
  public_host : string option;
  public_collaboration_port : int;
  (* When true, OxCaml only ever runs in the visitor's browser: the server
     refuses /api/evaluate and compiles without running when validating saves.
     Required for any shared deployment, where server-side execution would let
     every visitor run code as the user running Dox. *)
  browser_execution_only : bool;
  (* "websocket" or "http". Behind a proxy that authenticates with challenges,
     browsers cannot authenticate a WebSocket handshake, so the HTTP transport
     (Server-Sent Events plus POST) is the one that works. *)
  collaboration_transport : string;
  session_token : string;
}

type collaboration_process = {
  pid : int;
  output : in_channel;
  watchdog : out_channel;
  port : int;
  alive : bool ref;
}

let status_text = function
  | 200 -> "OK"
  | 201 -> "Created"
  | 204 -> "No Content"
  | 400 -> "Bad Request"
  | 401 -> "Unauthorized"
  | 403 -> "Forbidden"
  | 404 -> "Not Found"
  | 405 -> "Method Not Allowed"
  | 409 -> "Conflict"
  | 413 -> "Content Too Large"
  | 415 -> "Unsupported Media Type"
  | 500 -> "Internal Server Error"
  | 503 -> "Service Unavailable"
  | _ -> "Unknown"

let json ?(status = 200) value =
  {
    status;
    content_type = "application/json; charset=utf-8";
    body = Yojson.Safe.to_string value;
    extra_headers = [];
  }

let text ?(status = 200) ?(content_type = "text/plain; charset=utf-8") body =
  { status; content_type; body; extra_headers = [] }

let error ?(status = 400) message =
  json ~status (`Assoc [ ("error", `String message) ])

let project_error = function
  | Project.Not_found message -> error ~status:404 message
  | Project.Conflict message -> error ~status:409 message
  | Project.Invalid message -> error ~status:400 message
  | Project.Io message -> error ~status:500 message

let header headers name =
  List.find_map
    (fun (key, value) ->
      if String.equal (String.lowercase_ascii key) (String.lowercase_ascii name)
      then Some value
      else None)
    headers

let read_line_limited channel limit =
  let buffer = Buffer.create (min limit 256) in
  let rec loop length =
    if length > limit then `Too_large
    else
      match input_char channel with
      | '\n' -> `Line (Buffer.contents buffer)
      | character ->
          Buffer.add_char buffer character;
          loop (length + 1)
      | exception End_of_file ->
          if length = 0 then `Eof else `Line (Buffer.contents buffer)
  in
  loop 0

let read_request channel =
  let max_request_line = 8_192 in
  let max_header_bytes = 64_000 in
  let max_headers = 100 in
  let max_body = 16_000_000 in
  match read_line_limited channel max_request_line with
  | `Eof -> Ok None
  | `Too_large -> Error (413, "Request line is too large.")
  | `Line request_line ->
      if String.length request_line > max_request_line then
        Error (413, "Request line is too large.")
      else
        let parts = String.split_on_char ' ' request_line in
        let method_, target, version =
          match parts with
          | [ method_; target; version ] -> (method_, target, version)
          | _ -> ("", "", "")
        in
        if
          String.equal method_ ""
          || not (Util.starts_with ~prefix:"HTTP/1." version)
        then Error (400, "Malformed HTTP request line.")
        else
          let rec read_headers count bytes accumulator =
            if count > max_headers || bytes > max_header_bytes then
              Error (413, "Request headers are too large.")
            else
              match
                read_line_limited channel (max 0 (max_header_bytes - bytes))
              with
              | `Eof -> Error (400, "Truncated HTTP headers.")
              | `Too_large -> Error (413, "Request headers are too large.")
              | `Line ("\r" | "") -> Ok (List.rev accumulator)
              | `Line line -> (
                  let line =
                    if Util.ends_with ~suffix:"\r" line then
                      String.sub line 0 (String.length line - 1)
                    else line
                  in
                  let key, value = Util.split_once ':' line in
                  match value with
                  | None -> Error (400, "Malformed HTTP header.")
                  | Some value ->
                      read_headers (count + 1)
                        (bytes + String.length line)
                        ((String.trim key, String.trim value) :: accumulator))
          in
          Result.bind (read_headers 0 0 []) (fun headers ->
              let content_length =
                match header headers "content-length" with
                | None -> Ok 0
                | Some value -> (
                    match int_of_string_opt value with
                    | Some length when length >= 0 && length <= max_body ->
                        Ok length
                    | Some _ -> Error (413, "Request body is too large.")
                    | None -> Error (400, "Invalid Content-Length header."))
              in
              Result.bind content_length (fun content_length ->
                  try
                    let body =
                      if content_length = 0 then ""
                      else really_input_string channel content_length
                    in
                    Ok (Some (method_, target, headers, body))
                  with End_of_file -> Error (400, "Truncated request body.")))

let hostname_of_host host =
  match String.index_opt host ':' with
  | Some index -> String.sub host 0 index
  | None -> host

let websocket_origins context =
  [
    Printf.sprintf "ws://127.0.0.1:%d" context.collaboration_port;
    Printf.sprintf "ws://localhost:%d" context.collaboration_port;
  ]
  @
  match context.public_host with
  | None -> []
  | Some host ->
      [
        Printf.sprintf "ws://%s:%d" (hostname_of_host host)
          context.public_collaboration_port;
        Printf.sprintf "wss://%s:%d" (hostname_of_host host)
          context.public_collaboration_port;
      ]

let send_response context channel response =
  Printf.fprintf channel "HTTP/1.1 %d %s\r\n" response.status
    (status_text response.status);
  Printf.fprintf channel "Content-Type: %s\r\n" response.content_type;
  Printf.fprintf channel "Content-Length: %d\r\n" (String.length response.body);
  Printf.fprintf channel
    "Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval'; style-src \
     'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; \
     connect-src 'self' %s; base-uri 'none'; form-action 'self'\r\n"
    (String.concat " " (websocket_origins context));
  Printf.fprintf channel "X-Content-Type-Options: nosniff\r\n";
  Printf.fprintf channel "Referrer-Policy: no-referrer\r\n";
  Printf.fprintf channel "Cache-Control: no-store\r\n";
  Printf.fprintf channel "Connection: close\r\n";
  List.iter
    (fun (key, value) -> Printf.fprintf channel "%s: %s\r\n" key value)
    response.extra_headers;
  output_string channel "\r\n";
  output_string channel response.body;
  flush channel

let json_body body =
  try Ok (Yojson.Safe.from_string body)
  with Yojson.Json_error message -> Error ("Invalid JSON: " ^ message)

let string_member name json =
  match Yojson.Safe.Util.member name json with
  | `String value -> Ok value
  | _ -> Error (Printf.sprintf "Expected string field %S." name)

let int_member name json =
  match Yojson.Safe.Util.member name json with
  | `Int value -> Ok value
  | _ -> Error (Printf.sprintf "Expected integer field %S." name)

let list_member name json =
  match Yojson.Safe.Util.member name json with
  | `List values -> Ok values
  | _ -> Error (Printf.sprintf "Expected list field %S." name)

let is_json headers =
  match header headers "content-type" with
  | Some value ->
      Util.starts_with ~prefix:"application/json" (String.lowercase_ascii value)
  | None -> false

let collaboration_request context path value =
  let socket = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
  Fun.protect
    ~finally:(fun () -> try Unix.close socket with Unix.Unix_error _ -> ())
    (fun () ->
      try
        Unix.setsockopt_float socket Unix.SO_RCVTIMEO 5.;
        Unix.setsockopt_float socket Unix.SO_SNDTIMEO 5.;
        Unix.connect socket
          (Unix.ADDR_INET
             (Unix.inet_addr_loopback, context.collaboration_port));
        let input = Unix.in_channel_of_descr (Unix.dup socket) in
        let output = Unix.out_channel_of_descr (Unix.dup socket) in
        let body = Yojson.Safe.to_string value in
        Printf.fprintf output "POST %s HTTP/1.1\r\n" path;
        Printf.fprintf output "Host: 127.0.0.1:%d\r\n"
          context.collaboration_port;
        Printf.fprintf output "Content-Type: application/json\r\n";
        Printf.fprintf output "X-Dox-Token: %s\r\n" context.session_token;
        Printf.fprintf output "Content-Length: %d\r\n" (String.length body);
        Printf.fprintf output "Connection: close\r\n\r\n%s" body;
        flush output;
        let line () =
          match input_line input with
          | value ->
              if Util.ends_with ~suffix:"\r" value then
                String.sub value 0 (String.length value - 1)
              else value
          | exception End_of_file -> ""
        in
        let status_line = line () in
        let status =
          match String.split_on_char ' ' status_line with
          | _ :: value :: _ -> Option.value ~default:0 (int_of_string_opt value)
          | _ -> 0
        in
        let rec headers content_length =
          match line () with
          | "" -> content_length
          | header_line ->
              let key, value = Util.split_once ':' header_line in
              let content_length =
                match value with
                | Some value
                  when String.equal
                         (String.lowercase_ascii (String.trim key))
                         "content-length" ->
                    Option.value ~default:content_length
                      (int_of_string_opt (String.trim value))
                | _ -> content_length
              in
              headers content_length
        in
        let content_length = headers 0 in
        if content_length < 0 || content_length > 16_000_000 then
          failwith "The collaboration response was too large.";
        let response_body =
          if content_length = 0 then ""
          else really_input_string input content_length
        in
        close_in_noerr input;
        close_out_noerr output;
        if status >= 200 && status < 300 then
          try Ok (Yojson.Safe.from_string response_body)
          with Yojson.Json_error message ->
            Error ("Invalid collaboration response: " ^ message)
        else
          let message =
            try
              Yojson.Safe.from_string response_body
              |> Yojson.Safe.Util.member "error"
              |> Yojson.Safe.Util.to_string
            with _ -> response_body
          in
          Error
            (Printf.sprintf "Collaboration request failed (%d): %s" status
               message)
      with Unix.Unix_error (error, operation, _) ->
        Error
          (Printf.sprintf "Collaboration service failed during %s: %s"
             operation (Unix.error_message error))
      | exception_ ->
          Error
            ("Collaboration service failed: " ^ Printexc.to_string exception_))

let require_collaboration context path value continuation =
  match collaboration_request context path value with
  | Ok response -> continuation response
  | Error message -> error ~status:503 message

let rec collaboration_request_retry ?(attempts = 3) context path value =
  match collaboration_request context path value with
  | Ok _ as result -> result
  | Error _ as result when attempts <= 1 -> result
  | Error _ ->
      ignore (Unix.select [] [] [] 0.05);
      collaboration_request_retry ~attempts:(attempts - 1) context path value

let resume_collaboration context lease =
  collaboration_request_retry context "/internal/resume"
    (`Assoc [ ("lease", `String lease) ])

(* The browser pairs the reported collaboration port with location.hostname, so
   the port must match the host this request arrived on: the proxied port for the
   public host, the local one on loopback. Reporting one port for both yields a
   host/port pair that the CSP does not list, and the socket is blocked. *)
let collaboration_port_for (context : context) headers =
  match (context.public_host, header headers "host") with
  | Some public, Some host
    when String.equal (String.lowercase_ascii host) (String.lowercase_ascii public)
    ->
      context.public_collaboration_port
  | _ -> context.collaboration_port

let expected_hosts (context : context) =
  [
    Printf.sprintf "127.0.0.1:%d" context.port;
    Printf.sprintf "localhost:%d" context.port;
  ]
  @
  match context.public_host with
  | None -> []
  | Some host -> [ String.lowercase_ascii host ]

let same_origin (context : context) headers =
  let host_ok =
    match header headers "host" with
    | Some host ->
        List.mem (String.lowercase_ascii host) (expected_hosts context)
    | None -> false
  in
  let origin_ok =
    match header headers "origin" with
    | None -> true
    | Some origin ->
        List.exists
          (fun host ->
            String.equal origin ("http://" ^ host)
            || String.equal origin ("https://" ^ host))
          (expected_hosts context)
  in
  host_ok && origin_ok

let authorized (context : context) headers =
  same_origin context headers
  &&
  match header headers "x-dox-token" with
  | Some token -> String.equal token context.session_token
  | None -> false

let require_active_request context headers continuation =
  if not (same_origin context headers) then
    error ~status:403 "Cross-origin workspace request rejected."
  else if not (authorized context headers) then
    error ~status:401 "Workspace session token is missing or invalid."
  else if not (is_json headers) then
    error ~status:415 "Active workspace requests require application/json."
  else continuation ()

let document_response context parameters =
  match List.assoc_opt "path" parameters with
  | None -> error "Missing path query parameter."
  | Some path -> (
      match Project.snapshot context.project with
      | Error project_error_ -> project_error project_error_
      | Ok snapshot -> (
          match Project.document snapshot path with
          | Error project_error_ -> project_error project_error_
          | Ok document ->
              json
                (`Assoc
                   [
                     ("document", Document.to_json document);
                     ( "project",
                       Project.snapshot_to_json context.project snapshot );
                     ("projectVersion", `String snapshot.version);
                     ("capturedAt", `String snapshot.captured_at);
                   ])))

let page_response context ~cancelled parameters =
  match List.assoc_opt "module" parameters with
  | None -> error "Missing module query parameter."
  | Some module_path -> (
      match Project.direct_page ~cancelled context.project module_path with
      | Error project_error_ -> project_error project_error_
      | Ok page ->
          if cancelled () then raise Evaluator.Cancelled;
          let digest = page.document.version in
          let not_modified =
            match List.assoc_opt "ifDigest" parameters with
            | Some expected -> String.equal expected digest
            | None -> false
          in
          let fields =
            [
              ("module", `String page.module_path);
              ("path", `String page.path);
              ("digest", `String digest);
              ("notModified", `Bool not_modified);
            ]
          in
          let fields =
            if not_modified then fields
            else fields @ [ ("document", Document.to_json page.document) ]
          in
          if cancelled () then raise Evaluator.Cancelled;
          json (`Assoc fields))

let save_page_response context body =
  let open Util in
  let parsed =
    let* request = json_body body in
    let* module_path = string_member "module" request in
    let* source = string_member "source" request in
    let* expected_digest = string_member "expectedDigest" request in
    let* edit_revision = int_member "editRevision" request in
    Ok (module_path, source, expected_digest, edit_revision)
  in
  match parsed with
  | Error message -> error message
  | Ok (module_path, source, expected_digest, edit_revision) -> (
      match
        Project.save_page_source context.project ~module_path ~source
          ~expected_digest ~edit_revision
      with
      | Error project_error_ -> project_error project_error_
      | Ok (document, snapshot, acknowledged_revision) ->
          json
            (`Assoc
               [
                 ("module", `String module_path);
                 ("document", Document.to_json document);
                 ("digest", `String document.version);
                 ("acknowledgedRevision", `Int acknowledged_revision);
                 ("projectVersion", `String snapshot.version);
                 ("project", Project.snapshot_to_json context.project snapshot);
               ]))

let collaboration_open_response context body =
  let open Util in
  match
    let* request = json_body body in
    let* module_path = string_member "module" request in
    Ok module_path
  with
  | Error message -> error message
  | Ok module_path -> (
      match Project.snapshot context.project with
      | Error project_error_ -> project_error project_error_
      | Ok snapshot -> (
          let path = Module_path.source_path module_path in
          match Project.document snapshot path with
          | Error project_error_ -> project_error project_error_
          | Ok document ->
              require_collaboration context "/internal/open"
                (`Assoc
                   [
                     ("module", `String module_path);
                     ("path", `String path);
                     ("source", `String document.source);
                     ("digest", `String document.version);
                     ("projectVersion", `String snapshot.version);
                   ])
                (fun collaboration -> json collaboration)))

let collaboration_flush_response context body =
  match json_body body with
  | Error message -> error message
  | Ok request ->
  require_collaboration context "/internal/flush" request (fun value ->
      match Project.snapshot context.project with
      | Error project_error_ -> project_error project_error_
      | Ok snapshot ->
          let documents = Yojson.Safe.Util.member "documents" value in
          let acknowledged_sources =
            Yojson.Safe.Util.member "acknowledgedSources" value
          in
          json
            (`Assoc
               [
                 ("documents", documents);
                 ("acknowledgedSources", acknowledged_sources);
                 ("project", Project.snapshot_to_json context.project snapshot);
                 ("projectVersion", `String snapshot.version);
               ]))

let ai_collaboration_response context =
  (* Two kinds of agent read this. One runs on the Dox host and can edit
     projectRoot directly; one only has the URL. The filesystem instructions are
     useless to the second kind - projectRoot does not exist on its machine - so
     describe both paths and say which is which. *)
  json
    (`Assoc
       [
         ("name", `String "Dox");
         ("format", `String ".ml.md");
         ("projectRoot", `String context.project.root);
         ( "instructions",
           `List
             [
               `String
                 "Dox mirrors live collaborative pages into ordinary Git working-tree files.";
               `String
                 "If you cannot read projectRoot, you are not on the Dox host: use the HTTP API under \"api\" below and ignore the filesystem instructions.";
               `String
                 "Read the token from GET /api/session, then POST {} as application/json to /api/collaboration/flush with X-Dox-Token before reading files.";
               `String
                 "Edit .ml.md files and .dox-order normally, then use Git diff and commit normally.";
               `String
                 "Dox ingests working-tree edits into open collaborative pages. Resolve any inserted Git-style conflict markers before committing.";
               `String
                 "After filesystem edits, POST the flush again and require a 2xx response before inspecting git diff or committing.";
               `String
                 "Do not edit .dox/collaboration; it stores ignored CRDT recovery state.";
             ] );
         ( "api",
           `Assoc
             [
               ( "notes",
                 `List
                   [
                     `String
                       "Send X-Dox-Token from GET /api/session on every mutating request, and keep the Host and Origin of the URL you were given.";
                     `String
                       "baseProjectVersion is the \"version\" field of GET /api/project; a stale value is rejected with 409, so re-read it and retry.";
                     `String
                       "Pages created this way are mirrored into the Git working tree by Dox itself, so no filesystem access is needed.";
                     `String
                       "Content-Length is required; chunked request bodies are not read.";
                   ] );
               ( "createPage",
                 `Assoc
                   [
                     ("method", `String "POST");
                     ("path", `String "/api/page");
                     ( "body",
                       `Assoc
                         [
                           ("module", `String "<module path, e.g. Notes.Ideas>");
                           ("baseProjectVersion", `String "<from /api/project>");
                         ] );
                   ] );
               ( "createPages",
                 `Assoc
                   [
                     ("method", `String "POST");
                     ("path", `String "/api/pages");
                     ( "body",
                       `Assoc
                         [
                           ("modules", `String "<list of module paths>");
                           ("baseProjectVersion", `String "<from /api/project>");
                         ] );
                   ] );
               ( "writePage",
                 `Assoc
                   [
                     ("method", `String "PUT");
                     ("path", `String "/api/page/source");
                     ( "body",
                       `Assoc
                         [
                           ("module", `String "<module path>");
                           ("source", `String "<full page source>");
                           ( "expectedDigest",
                             `String "<current digest, from /api/page>" );
                           ("editRevision", `String "<integer>");
                         ] );
                   ] );
               ( "readPage",
                 `Assoc
                   [
                     ("method", `String "GET");
                     ("path", `String "/api/page?module=<module path>");
                   ] );
               ( "listPages",
                 `Assoc
                   [
                     ("method", `String "GET"); ("path", `String "/api/project");
                   ] );
             ] );
         ("executionEngine", `String (if context.browser_execution_only then "browser" else "server"));
         ("flushEndpoint", `String "/api/collaboration/flush");
         ("sessionEndpoint", `String "/api/session");
       ])

let create_page_response context body =
  let open Util in
  let parsed =
    let* request = json_body body in
    let* module_path = string_member "module" request in
    let* base_project_version = string_member "baseProjectVersion" request in
    Ok (module_path, base_project_version)
  in
  match parsed with
  | Error message -> error message
  | Ok (module_path, base_project_version) -> (
      match
        Project.create_page context.project ~module_path ~base_project_version
          ~principal:"workspace-user"
      with
      | Error project_error_ -> project_error project_error_
      | Ok (document, _, snapshot) ->
          json ~status:201
            (`Assoc
               [
                 ("module", `String module_path);
                 ("document", Document.to_json document);
                 ("project", Project.snapshot_to_json context.project snapshot);
                 ("projectVersion", `String snapshot.version);
               ]))

let create_pages_response context body =
  let open Util in
  let parsed =
    let* request = json_body body in
    let rec strings result = function
      | [] -> Ok (List.rev result)
      | `String value :: rest -> strings (value :: result) rest
      | _ -> Error "Expected modules to contain only strings."
    in
    let* values = list_member "modules" request in
    let* module_paths = strings [] values in
    let* page_order =
      match Yojson.Safe.Util.member "order" request with
      | `Null -> Ok None
      | `List values -> Result.map Option.some (strings [] values)
      | _ -> Error "Expected order to contain only strings."
    in
    let* base_project_version = string_member "baseProjectVersion" request in
    Ok (module_paths, page_order, base_project_version)
  in
  match parsed with
  | Error message -> error message
  | Ok (module_paths, page_order, base_project_version) -> (
      match
        Project.create_pages ?page_order context.project ~module_paths
          ~base_project_version ~principal:"workspace-user"
      with
      | Error project_error_ -> project_error project_error_
      | Ok (documents, snapshot) ->
          json ~status:201
            (`Assoc
               [
                 ("documents", `List (List.map Document.to_json documents));
                 ("project", Project.snapshot_to_json context.project snapshot);
                 ("projectVersion", `String snapshot.version);
               ]))

let delete_pages_response context body =
  let open Util in
  let parsed =
    let* request = json_body body in
    let rec strings result = function
      | [] -> Ok (List.rev result)
      | `String value :: rest -> strings (value :: result) rest
      | _ -> Error "Expected modules to contain only strings."
    in
    let* values = list_member "modules" request in
    let* module_paths = strings [] values in
    let* page_order =
      match Yojson.Safe.Util.member "order" request with
      | `Null -> Ok None
      | `List values -> Result.map Option.some (strings [] values)
      | _ -> Error "Expected order to contain only strings."
    in
    let* base_project_version = string_member "baseProjectVersion" request in
    Ok (module_paths, page_order, base_project_version)
  in
  match parsed with
  | Error message -> error message
  | Ok (module_paths, page_order, base_project_version) ->
      require_collaboration context "/internal/pause" (`Assoc []) (fun pause ->
          let lease = Yojson.Safe.Util.member "lease" pause |> Yojson.Safe.Util.to_string in
          let resumed = ref false in
          let resume () =
            let result = resume_collaboration context lease in
            if Result.is_ok result then resumed := true;
            result
          in
          Fun.protect
            ~finally:(fun () -> if not !resumed then ignore (resume ()))
            (fun () ->
              match
                Project.delete_pages ?page_order context.project ~module_paths
                  ~base_project_version ~principal:"workspace-user"
              with
              | Error project_error_ ->
                  ignore (resume ());
                  project_error project_error_
              | Ok (snapshot, trash_path) ->
              let paths = List.map Module_path.source_path module_paths in
              let collaboration_warning =
                match
                  collaboration_request_retry context "/internal/tombstone"
                    (`Assoc
                       [
                         ("lease", `String lease);
                         ( "paths",
                           `List
                             (List.map (fun path -> `String path) paths) );
                       ])
                with
                | Ok _ -> (
                    match resume () with
                    | Ok _ -> []
                    | Error message ->
                        [ ("collaborationWarning", `String message) ])
                | Error message -> [ ("collaborationWarning", `String message) ]
              in
              if collaboration_warning <> [] then
                ignore (resume ());
              json
                (`Assoc
                   ([
                         ( "deleted",
                           `List
                             (List.map
                                (fun value -> `String value)
                                module_paths) );
                         ("trashPath", `String trash_path);
                         ( "project",
                           Project.snapshot_to_json context.project snapshot );
                         ("projectVersion", `String snapshot.version);
                       ]
                   @ collaboration_warning))))

let page_order_response context body =
  let open Util in
  let strings field request =
    let* values = list_member field request in
    let rec collect result = function
      | [] -> Ok (List.rev result)
      | `String value :: rest -> collect (value :: result) rest
      | _ -> Error (Printf.sprintf "Expected %s to contain only strings." field)
    in
    collect [] values
  in
  let parsed =
    let* request = json_body body in
    let* module_paths = strings "modules" request in
    let* base_order = strings "baseOrder" request in
    let* base_project_version = string_member "baseProjectVersion" request in
    Ok (module_paths, base_order, base_project_version)
  in
  match parsed with
  | Error message -> error message
  | Ok (module_paths, base_order, base_project_version) -> (
      match
        Project.set_page_order context.project ~module_paths
          ~base_project_version ~base_order
      with
      | Error project_error_ -> project_error project_error_
      | Ok snapshot ->
          json
            (`Assoc
               [
                 ("project", Project.snapshot_to_json context.project snapshot);
                 ("projectVersion", `String snapshot.version);
               ]))

let dependencies_response context ~cancelled parameters =
  ignore cancelled;
  match List.assoc_opt "module" parameters with
  | None -> error "Missing module query parameter."
  | Some module_path -> (
      match Project.snapshot context.project with
      | Error project_error_ -> project_error project_error_
      | Ok snapshot -> (
          match Project.page snapshot module_path with
          | Error project_error_ -> project_error project_error_
          | Ok _ ->
              json
                (`Assoc
                   [
                     ("projectVersion", `String snapshot.version);
                     ( "dependency",
                       Module_graph.to_json snapshot.module_graph module_path );
                   ])))

let module_renames request =
  let open Util in
  let* entries = list_member "renames" request in
  let rec parse result = function
    | [] -> Ok (List.rev result)
    | entry :: rest ->
        let* before = string_member "before" entry in
        let* after = string_member "after" entry in
        parse ({ Project.before; after } :: result) rest
  in
  parse [] entries

let optional_module_order request =
  let rec parse result = function
    | [] -> Ok (Some (List.rev result))
    | `String value :: rest -> parse (value :: result) rest
    | _ -> Error "Expected order to contain only strings."
  in
  match Yojson.Safe.Util.member "order" request with
  | `Null -> Ok None
  | `List values -> parse [] values
  | _ -> Error "Expected order to contain only strings."

let refactor_preview_response context body =
  let open Util in
  match
    let* request = json_body body in
    let* project_version = string_member "projectVersion" request in
    let* renames = module_renames request in
    let* page_order = optional_module_order request in
    Ok (project_version, renames, page_order)
  with
  | Error message -> error message
  | Ok (project_version, renames, page_order) -> (
      match Project.snapshot context.project with
      | Error project_error_ -> project_error project_error_
      | Ok snapshot -> (
          if not (String.equal snapshot.version project_version) then
            error ~status:409 "The project changed before the refactor preview."
          else
            match Project.refactor_preview ?page_order snapshot renames with
            | Error project_error_ -> project_error project_error_
            | Ok preview -> json preview))

let refactor_apply_response context body =
  let open Util in
  match
    let* request = json_body body in
    let* project_version = string_member "projectVersion" request in
    let* preview_id = string_member "previewId" request in
    let* renames = module_renames request in
    let* page_order = optional_module_order request in
    Ok (project_version, preview_id, renames, page_order)
  with
  | Error message -> error message
  | Ok (project_version, preview_id, renames, page_order) ->
      require_collaboration context "/internal/pause" (`Assoc []) (fun pause ->
          let lease = Yojson.Safe.Util.member "lease" pause |> Yojson.Safe.Util.to_string in
          let resumed = ref false in
          let resume () =
            let result = resume_collaboration context lease in
            if Result.is_ok result then resumed := true;
            result
          in
          Fun.protect
            ~finally:(fun () -> if not !resumed then ignore (resume ()))
            (fun () ->
              match
                Project.apply_module_refactor ?page_order context.project
                  ~expected_project_version:project_version
                  ~expected_preview_id:preview_id renames
              with
              | Error project_error_ ->
                  ignore (resume ());
                  project_error project_error_
              | Ok (preview, snapshot, mapping) ->
              let collaboration_renames =
                match mapping with
                | `List values ->
                    `List
                      (List.filter_map
                         (fun value ->
                           match
                             ( Yojson.Safe.Util.member "before" value,
                               Yojson.Safe.Util.member "after" value )
                           with
                           | `String before, `String after ->
                               Some
                                 (`Assoc
                                    [
                                      ( "beforePath",
                                        `String
                                          (Module_path.source_path before) );
                                      ( "afterPath",
                                        `String
                                          (Module_path.source_path after) );
                                      ("beforeModule", `String before);
                                      ("afterModule", `String after);
                                    ])
                           | _ -> None)
                         values)
                | _ -> `List []
              in
              let collaboration_warning =
                match
                  collaboration_request_retry context "/internal/rebind"
                    (`Assoc
                       [
                         ("lease", `String lease);
                         ("renames", collaboration_renames);
                       ])
                with
                | Ok _ -> (
                    match resume () with
                    | Ok _ -> []
                    | Error message ->
                        [ ("collaborationWarning", `String message) ])
                | Error message -> [ ("collaborationWarning", `String message) ]
              in
              if collaboration_warning <> [] then
                ignore (resume ());
              json
                (`Assoc
                   ([
                         ("preview", preview);
                         ("mapping", mapping);
                         ( "project",
                           Project.snapshot_to_json context.project snapshot );
                         ("projectVersion", `String snapshot.version);
                       ]
                   @ collaboration_warning))))

let refactor_rewrite_response context body =
  let open Util in
  match
    let* request = json_body body in
    let* path = string_member "path" request in
    let* source = string_member "source" request in
    let* renames = module_renames request in
    Ok (path, source, renames)
  with
  | Error message -> error message
  | Ok (path, source, renames) -> (
      match Project.snapshot context.project with
      | Error error -> project_error error
      | Ok snapshot ->
          let module_paths =
            Page_index.modules snapshot.page_index
            |> List.map (fun module_path ->
                Option.value ~default:module_path
                  (List.find_map
                     (fun rename ->
                       if String.equal rename.Project.after module_path then
                         Some rename.before
                       else None)
                     renames))
          in
          let document = Document.parse ~path source in
          json
            (`Assoc
               [
                 ( "source",
                   `String
                     (Project.rewrite_document_module_paths ~module_paths
                        renames document) );
               ]))

let evaluate_response context ~cancelled body =
  let open Util in
  let profile phase started =
    if Option.is_some (Sys.getenv_opt "DOX_PROFILE") then
      prerr_endline
        ("DOX_PROFILE "
        ^ Yojson.Safe.to_string
            (`Assoc
               [
                 ("phase", `String phase);
                 ( "durationMs",
                   `Int
                     (int_of_float ((Unix.gettimeofday () -. started) *. 1000.))
                 );
               ]))
  in
  let request_started = Unix.gettimeofday () in
  match
    let* request = json_body body in
    let* path = string_member "path" request in
    let* source = string_member "source" request in
    let* base_project_version = string_member "baseProjectVersion" request in
    let request_code_digest =
      match Yojson.Safe.Util.member "requestCodeDigest" request with
      | `String value when not (String.equal value "") -> Some value
      | _ -> None
    in
    match Project.snapshot context.project with
    | Error project_error_ -> Error (Project.error_message project_error_)
    | Ok snapshot -> (
        profile "snapshot" request_started;
        if not (String.equal snapshot.version base_project_version) then
          Error "The project changed; reload before evaluating this draft."
        else
          let document = Document.parse ~path source in
          let expected_request_code_digest =
            Evaluator.request_code_digest_for_document document
          in
          if
            match request_code_digest with
            | Some supplied ->
                not (String.equal supplied expected_request_code_digest)
            | None -> false
          then Error "The executable-source digest did not match the draft."
          else
            let resolve_started = Unix.gettimeofday () in
            match
              Project.resolve_documents ~cancelled context.project snapshot
                document
            with
            | Error project_error_ ->
                Error (Project.error_message project_error_)
            | Ok documents ->
                profile "resolveDocuments" resolve_started;
                let evaluation_started = Unix.gettimeofday () in
                let evaluation =
                  Evaluator.evaluate_documents ~project_version:snapshot.version
                    ?request_code_digest ~cancelled ~documents ~target:document
                    ()
                in
                profile "evaluateDocuments" evaluation_started;
                Ok (document, evaluation, snapshot.version))
  with
  | Error message -> error ~status:409 message
  | Ok (document, evaluation, project_version) ->
      json
        (`Assoc
           [
             ("document", Document.to_json document);
             ("evaluation", Evaluator.to_json evaluation);
             ("projectVersion", `String project_version);
           ])

let browser_evaluation_plan_response context ~cancelled body =
  let open Util in
  match
    let* request = json_body body in
    let* path = string_member "path" request in
    let* source = string_member "source" request in
    let* base_project_version = string_member "baseProjectVersion" request in
    match Project.snapshot context.project with
    | Error project_error_ -> Error (Project.error_message project_error_)
    | Ok snapshot ->
        if not (String.equal snapshot.version base_project_version) then
          Error "The project changed; reload before evaluating this draft."
        else
          let document = Document.parse ~path source in
          (match
             Project.resolve_documents ~cancelled context.project snapshot
               document
           with
          | Error project_error_ -> Error (Project.error_message project_error_)
          | Ok documents ->
              Ok
                ( document,
                  Evaluator.browser_evaluation_plan ~documents ~target:document,
                  snapshot.version ))
  with
  | Error message -> error ~status:409 message
  | Ok (document, plan, project_version) ->
      json
        (`Assoc
           [ ("document", Document.to_json document);
             ("plan", plan);
             ("projectVersion", `String project_version)
           ])

let browser_evaluation_result_response context ~cancelled body =
  let open Util in
  match
    let* request = json_body body in
    let* path = string_member "path" request in
    let* source = string_member "source" request in
    let* base_project_version = string_member "baseProjectVersion" request in
    let* evaluation_id = string_member "evaluationId" request in
    let result = Yojson.Safe.Util.member "result" request in
    let* stdout = string_member "stdout" result in
    let* stderr = string_member "stderr" result in
    let* events = string_member "events" result in
    let* trace = string_member "trace" result in
    let manifests =
      Yojson.Safe.Util.member "manifests" result
      |> Yojson.Safe.Util.to_list
      |> List.map Yojson.Safe.Util.to_string
    in
    match Project.snapshot context.project with
    | Error project_error_ -> Error (Project.error_message project_error_)
    | Ok snapshot ->
        if not (String.equal snapshot.version base_project_version) then
          Error "The project changed; reload before accepting browser results."
        else
          let document = Document.parse ~path source in
          (match
             Project.resolve_documents ~cancelled context.project snapshot
               document
           with
          | Error project_error_ -> Error (Project.error_message project_error_)
          | Ok documents ->
              let browser_execution : Evaluator.browser_execution =
                { browser_stdout = stdout;
                  browser_stderr = stderr;
                  browser_events = events;
                  browser_trace = trace;
                  browser_manifests = manifests
                }
              in
              let evaluation =
                Evaluator.evaluate_documents ~project_version:snapshot.version
                  ~evaluation_id ~browser_execution ~cancelled ~documents
                  ~target:document ()
              in
              Ok (document, evaluation, snapshot.version))
  with
  | Error message -> error ~status:409 message
  | Ok (document, evaluation, project_version) ->
      json
        (`Assoc
           [ ("document", Document.to_json document);
             ("evaluation", Evaluator.to_json evaluation);
             ("projectVersion", `String project_version)
           ])

let type_at_response context ~cancelled body =
  let open Util in
  let parsed =
    let* request = json_body body in
    let* path = string_member "path" request in
    let* source = string_member "source" request in
    let* line = int_member "line" request in
    let* column = int_member "column" request in
    let* base_project_version = string_member "baseProjectVersion" request in
    if line < 1 || column < 0 then Error "Invalid cursor position."
    else Ok (path, source, line, column, base_project_version)
  in
  match parsed with
  | Error message -> error message
  | Ok (path, source, line, column, base_project_version) -> (
      match Project.snapshot context.project with
      | Error project_error_ -> project_error project_error_
      | Ok snapshot -> (
          if not (String.equal snapshot.version base_project_version) then
            error ~status:409
              "The project changed; reopen the document before querying types."
          else
            let target = Document.parse ~path source in
            match
              Project.resolve_documents ~cancelled context.project snapshot
                target
            with
            | Error project_error_ -> project_error project_error_
            | Ok documents -> (
                match
                  Evaluator.type_at_with_cancel ~cancelled ~documents ~target
                    ~line ~column
                with
                | Error message -> error ~status:503 message
                | Ok info ->
                    json
                      (`Assoc
                         [
                           ( "info",
                             Option.fold ~none:`Null
                               ~some:Evaluator.type_info_to_json info );
                         ]))))

let execution_sites_response context ~cancelled body =
  let open Util in
  let parsed =
    let* request = json_body body in
    let* path = string_member "path" request in
    let* source = string_member "source" request in
    let* base_project_version = string_member "baseProjectVersion" request in
    Ok (path, source, base_project_version)
  in
  match parsed with
  | Error message -> error message
  | Ok (path, source, base_project_version) -> (
      match Project.snapshot context.project with
      | Error project_error_ -> project_error project_error_
      | Ok snapshot -> (
          if not (String.equal snapshot.version base_project_version) then
            error ~status:409
              "The project changed; reopen the document before indexing its \
               execution sites."
          else
            let target = Document.parse ~path source in
            match
              Project.resolve_documents ~cancelled context.project snapshot
                target
            with
            | Error project_error_ -> project_error project_error_
            | Ok documents -> (
                match
                  Evaluator.execution_sites_with_cancel ~cancelled ~documents
                    ~target
                with
                | Error message -> error ~status:503 message
                | Ok sites ->
                    json
                      (`Assoc
                         [
                           ( "sites",
                             `List
                               (List.map Evaluator.execution_site_to_json sites)
                           );
                           ("projectVersion", `String snapshot.version);
                         ]))))

let definition_at_response context ~cancelled body =
  let open Util in
  let parsed =
    let* request = json_body body in
    let* path = string_member "path" request in
    let* source = string_member "source" request in
    let* line = int_member "line" request in
    let* column = int_member "column" request in
    let* base_project_version = string_member "baseProjectVersion" request in
    if line < 1 || column < 0 then Error "Invalid cursor position."
    else Ok (path, source, line, column, base_project_version)
  in
  match parsed with
  | Error message -> error message
  | Ok (path, source, line, column, base_project_version) -> (
      match Project.snapshot context.project with
      | Error project_error_ -> project_error project_error_
      | Ok snapshot -> (
          if not (String.equal snapshot.version base_project_version) then
            error ~status:409
              "The project changed; reopen the document before locating \
               definitions."
          else
            let target = Document.parse ~path source in
            match
              Project.resolve_documents ~cancelled context.project snapshot
                target
            with
            | Error project_error_ -> project_error project_error_
            | Ok documents -> (
                match
                  Evaluator.definition_at_with_cancel ~cancelled ~documents
                    ~target ~line ~column
                with
                | Error message -> error ~status:503 message
                | Ok info ->
                    json
                      (`Assoc
                         [
                           ( "definition",
                             Option.fold ~none:`Null
                               ~some:Evaluator.definition_info_to_json info );
                           ("projectVersion", `String snapshot.version);
                         ]))))

let complete_response context ~cancelled body =
  let open Util in
  let parsed =
    let* request = json_body body in
    let* path = string_member "path" request in
    let* source = string_member "source" request in
    let* line = int_member "line" request in
    let* column = int_member "column" request in
    let* completion_context = string_member "context" request in
    let* base_project_version = string_member "baseProjectVersion" request in
    if line < 1 || column < 0 then Error "Invalid completion position."
    else if String.length completion_context > 256 then
      Error "Completion context is too long."
    else
      Ok (path, source, line, column, completion_context, base_project_version)
  in
  match parsed with
  | Error message -> error message
  | Ok (path, source, line, column, completion_context, base_project_version)
    -> (
      match Project.snapshot context.project with
      | Error project_error_ -> project_error project_error_
      | Ok snapshot -> (
          if not (String.equal snapshot.version base_project_version) then
            error ~status:409
              "The project changed; reopen the document before completing code."
          else
            let target = Document.parse ~path source in
            match
              Project.resolve_documents ~cancelled context.project snapshot
                target
            with
            | Error project_error_ -> project_error project_error_
            | Ok documents -> (
                match
                  Evaluator.complete_at_with_cancel ~cancelled ~documents
                    ~target ~line ~column ~context:completion_context
                with
                | Error message -> error ~status:503 message
                | Ok entries ->
                    json
                      (`Assoc
                         [
                           ( "items",
                             `List
                               (List.map Evaluator.completion_entry_to_json
                                  entries) );
                         ]))))

let save_response context ~cancelled body =
  let open Util in
  let parsed =
    let* request = json_body body in
    let* path = string_member "path" request in
    let* source = string_member "source" request in
    let* base_version = string_member "baseVersion" request in
    let* base_project_version = string_member "baseProjectVersion" request in
    Ok (path, source, base_version, base_project_version)
  in
  match parsed with
  | Error message -> error message
  | Ok (path, source, base_version, base_project_version) -> (
      match Project.snapshot context.project with
      | Error project_error_ -> project_error project_error_
      | Ok snapshot -> (
          let draft = Document.parse ~path source in
          match
            Project.resolve_documents ~cancelled context.project snapshot draft
          with
          | Error project_error_ -> project_error project_error_
          | Ok documents -> (
              let validation =
                Evaluator.evaluate_documents
                  ~project_version:base_project_version
                  ~execute:(not context.browser_execution_only) ~cancelled
                  ~documents ~target:draft ()
              in
              match
                Project.save_document context.project ~path ~source
                  ~base_version ~base_project_version
                  ~principal:"workspace-user" ~validation
              with
              | Error project_error_ -> project_error project_error_
              | Ok (document, change, snapshot) ->
                  let validation =
                    { validation with project_version = Some snapshot.version }
                  in
                  json
                    (`Assoc
                       [
                         ("document", Document.to_json document);
                         ("change", change);
                         ( "project",
                           Project.snapshot_to_json context.project snapshot );
                         ("evaluation", Evaluator.to_json validation);
                       ]))))

let create_response context body =
  let open Util in
  let parsed =
    let* request = json_body body in
    let* path = string_member "path" request in
    let* source = string_member "source" request in
    let* base_project_version = string_member "baseProjectVersion" request in
    Ok (path, source, base_project_version)
  in
  match parsed with
  | Error message -> error message
  | Ok (path, source, base_project_version) -> (
      match
        Project.create_document context.project ~path ~source
          ~base_project_version ~principal:"workspace-user"
      with
      | Error project_error_ -> project_error project_error_
      | Ok (document, change, snapshot) ->
          json ~status:201
            (`Assoc
               [
                 ("document", Document.to_json document);
                 ("change", change);
                 ("project", Project.snapshot_to_json context.project snapshot);
               ]))

let artifact_response context body =
  let open Util in
  let parsed =
    let* request = json_body body in
    let* path = string_member "path" request in
    let* entry = string_member "entry" request in
    let* name = string_member "name" request in
    let* project_version = string_member "projectVersion" request in
    let* document_version = string_member "documentVersion" request in
    Ok (path, entry, name, project_version, document_version)
  in
  match parsed with
  | Error message -> error message
  | Ok (path, entry, name, project_version, document_version) -> (
      match
        Project.build_artifact context.project ~path ~entry ~name
          ~expected_project_version:project_version
          ~expected_document_version:document_version
          ~principal:"workspace-user"
      with
      | Ok manifest -> json ~status:201 manifest
      | Error project_error_ -> project_error project_error_)

let change_response context parameters =
  match List.assoc_opt "id" parameters with
  | None -> error "Missing change id."
  | Some id -> (
      match Project.change_by_id context.project id with
      | Ok change -> json change
      | Error project_error_ -> project_error project_error_)

let content_type path =
  if Util.ends_with ~suffix:".html" path then "text/html; charset=utf-8"
  else if
    Util.ends_with ~suffix:".js" path || Util.ends_with ~suffix:".mjs" path
  then "text/javascript; charset=utf-8"
  else if Util.ends_with ~suffix:".css" path then "text/css; charset=utf-8"
  else if Util.ends_with ~suffix:".svg" path then "image/svg+xml"
  else "application/octet-stream"

let static_response context path =
  let path =
    if String.equal path "/" || Util.starts_with ~prefix:"/page/" path then
      "/index.html"
    else path
  in
  let relative =
    if String.length path > 0 && path.[0] = '/' then
      String.sub path 1 (String.length path - 1)
    else path
  in
  match Util.safe_existing_path ~root:context.assets relative with
  | Error _ -> error ~status:404 "Not found."
  | Ok absolute -> (
      match Util.read_file absolute with
      | Ok body ->
          {
            (text ~content_type:(content_type absolute) body) with
            extra_headers = [ ("Cache-Control", "no-store") ];
          }
      | Error _ -> error ~status:404 "Not found.")

let route context ~cancelled method_ target headers body =
  let path, parameters = Util.query_parameters target in
  match (method_, path) with
  | "GET", "/api/health" ->
      json
        (`Assoc [ ("ok", `Bool true); ("time", `String (Util.timestamp ())) ])
  | "GET", "/api/session" ->
      if same_origin context headers then
        json
          (`Assoc
             [
               ("token", `String context.session_token);
               ("trust", `String "local-launch");
               ( "executionEngine",
                 `String (if context.browser_execution_only then "browser" else "server") );
               ("executionEngineLocked", `Bool context.browser_execution_only);
               ("collaborationTransport", `String context.collaboration_transport);
               ("projectRoot", `String context.project.root);
               ( "collaborationPort",
                 `Int (collaboration_port_for context headers) );
             ])
      else error ~status:403 "Cross-origin workspace request rejected."
  | "GET", "/.well-known/dox-ai.json" -> ai_collaboration_response context
  | "GET", "/api/project" -> (
      match Project.to_json context.project with
      | Ok project -> json project
      | Error project_error_ -> project_error project_error_)
  | "GET", "/api/document" -> document_response context parameters
  | "GET", "/api/page" -> page_response context ~cancelled parameters
  | "GET", "/api/dependencies" ->
      dependencies_response context ~cancelled parameters
  | "GET", "/api/changes" -> (
      match Project.changes context.project with
      | Ok changes -> json (`List changes)
      | Error project_error_ -> project_error project_error_)
  | "GET", "/api/change" -> change_response context parameters
  | "POST", "/api/evaluate" when context.browser_execution_only ->
      error ~status:403
        "This workspace runs OxCaml in the browser only; server-side evaluation \
         is disabled."
  | "POST", "/api/evaluate" ->
      require_active_request context headers (fun () ->
          evaluate_response context ~cancelled body)
  | "POST", "/api/browser-evaluation-plan" ->
      require_active_request context headers (fun () ->
          browser_evaluation_plan_response context ~cancelled body)
  | "POST", "/api/browser-evaluation-result" ->
      require_active_request context headers (fun () ->
          browser_evaluation_result_response context ~cancelled body)
  | "POST", "/api/type-at" ->
      require_active_request context headers (fun () ->
          type_at_response context ~cancelled body)
  | "POST", "/api/execution-sites" ->
      require_active_request context headers (fun () ->
          execution_sites_response context ~cancelled body)
  | "POST", "/api/definition-at" ->
      require_active_request context headers (fun () ->
          definition_at_response context ~cancelled body)
  | "POST", "/api/complete" ->
      require_active_request context headers (fun () ->
          complete_response context ~cancelled body)
  | "PUT", "/api/document" ->
      require_active_request context headers (fun () ->
          save_response context ~cancelled body)
  | "PUT", "/api/page/source" ->
      require_active_request context headers (fun () ->
          save_page_response context body)
  | "POST", "/api/collaboration/open" ->
      require_active_request context headers (fun () ->
          collaboration_open_response context body)
  | "POST", "/api/collaboration/flush" ->
      require_active_request context headers (fun () ->
          collaboration_flush_response context body)
  | "POST", "/api/document" ->
      require_active_request context headers (fun () ->
          create_response context body)
  | "POST", "/api/page" ->
      require_active_request context headers (fun () ->
          create_page_response context body)
  | "POST", "/api/pages" ->
      require_active_request context headers (fun () ->
          create_pages_response context body)
  | "DELETE", "/api/pages" ->
      require_active_request context headers (fun () ->
          delete_pages_response context body)
  | "PUT", "/api/page-order" ->
      require_active_request context headers (fun () ->
          page_order_response context body)
  | "POST", "/api/refactor/preview" ->
      require_active_request context headers (fun () ->
          refactor_preview_response context body)
  | "POST", "/api/refactor/apply" ->
      require_active_request context headers (fun () ->
          refactor_apply_response context body)
  | "POST", "/api/refactor/rewrite" ->
      require_active_request context headers (fun () ->
          refactor_rewrite_response context body)
  | "POST", "/api/artifact" ->
      require_active_request context headers (fun () ->
          artifact_response context body)
  | ("POST" | "PUT" | "DELETE" | "OPTIONS"), _ ->
      error ~status:404 "API endpoint not found."
  | "GET", _ -> static_response context path
  | _ -> error ~status:405 "Method not allowed."

let client_disconnected descriptor () =
  try
    match Unix.select [ descriptor ] [] [] 0. with
    | [], _, _ -> false
    | _ ->
        let byte = Bytes.create 1 in
        Unix.recv descriptor byte 0 1 [ Unix.MSG_PEEK ] = 0
  with
  | Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK | Unix.EINTR), _, _) ->
      false
  | Unix.Unix_error _ -> true

let handle_client context descriptor =
  let input = Unix.in_channel_of_descr descriptor in
  let output_descriptor = Unix.dup descriptor in
  let output = Unix.out_channel_of_descr output_descriptor in
  Fun.protect
    ~finally:(fun () ->
      close_in_noerr input;
      close_out_noerr output)
    (fun () ->
      match read_request input with
      | Error (status, message) ->
          send_response context output (error ~status message)
      | Ok None -> ()
      | Ok (Some (method_, target, headers, body)) ->
          let response =
            try
              route context
                ~cancelled:(client_disconnected descriptor)
                method_ target headers body
            with
            | Evaluator.Cancelled -> text ~status:204 ""
            | exception_ ->
                error ~status:500
                  ("Internal error: " ^ Printexc.to_string exception_)
          in
          send_response context output response)

let reap_workers workers =
  workers
  |> List.filter (fun pid ->
      match Unix.waitpid [ Unix.WNOHANG ] pid with
      | 0, _ -> true
      | _ -> false
      | exception Unix.Unix_error (Unix.EINTR, _, _) -> true
      | exception Unix.Unix_error _ -> false)

let accept_and_reap_workers socket workers =
  let client, address = Unix.accept socket in
  (client, address, reap_workers workers)

let terminate_process ?(timeout = 2.) pid =
  (try Unix.kill pid Sys.sigterm with Unix.Unix_error _ -> ());
  let deadline = Unix.gettimeofday () +. timeout in
  let rec wait () =
    match Unix.waitpid [ Unix.WNOHANG ] pid with
    | 0, _ when Unix.gettimeofday () < deadline ->
        ignore (Unix.select [] [] [] 0.05);
        wait ()
    | 0, _ ->
        (try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ());
        (try ignore (Unix.waitpid [] pid) with Unix.Unix_error _ -> ())
    | _ -> ()
    | exception Unix.Unix_error _ -> ()
  in
  wait ()

let start_collaboration ~root ~assets ~dox_port ~collaboration_port
    ~public_origin ~token =
  let script =
    Filename.concat (Filename.dirname assets) "collaboration/server.mjs"
  in
  if not (Sys.file_exists script) then
    failwith ("Could not find the collaboration service at " ^ script);
  let read_fd, write_fd = Unix.pipe ~cloexec:true () in
  let watchdog_read, watchdog_write = Unix.pipe ~cloexec:true () in
  let environment =
    Array.append (Unix.environment ()) [| "DOX_COLLAB_TOKEN=" ^ token |]
  in
  let arguments =
    [|
      "node";
      script;
      "--root";
      root;
      "--port";
      string_of_int collaboration_port;
      "--dox-port";
      string_of_int dox_port;
      "--origin";
      Printf.sprintf "http://127.0.0.1:%d" dox_port;
      "--origin";
      Printf.sprintf "http://localhost:%d" dox_port;
    |]
  in
  let arguments =
    match public_origin with
    | None -> arguments
    | Some host ->
        Array.append arguments
          [|
            "--origin"; "http://" ^ host; "--origin"; "https://" ^ host;
          |]
  in
  let pid =
    try
      Unix.create_process_env "node" arguments environment watchdog_read
        write_fd Unix.stderr
    with error ->
      Unix.close read_fd;
      Unix.close write_fd;
      Unix.close watchdog_read;
      Unix.close watchdog_write;
      raise error
  in
  Unix.close write_fd;
  Unix.close watchdog_read;
  let output = Unix.in_channel_of_descr read_fd in
  try
    let ready, _, _ = Unix.select [ read_fd ] [] [] 8. in
    if ready = [] then
      failwith "The collaboration service did not start within eight seconds.";
    let ready = Yojson.Safe.from_string (input_line output) in
    let is_ready =
      match Yojson.Safe.Util.member "ready" ready with `Bool value -> value | _ -> false
    in
    let collaboration_port = Yojson.Safe.Util.member "port" ready |> Yojson.Safe.Util.to_int in
    if not is_ready then failwith "The collaboration service did not become ready.";
    {
      pid;
      output;
      watchdog = Unix.out_channel_of_descr watchdog_write;
      port = collaboration_port;
      alive = ref true;
    }
  with error ->
    close_in_noerr output;
    Unix.close watchdog_write;
    terminate_process pid;
    raise error

let stop_collaboration collaboration =
  close_in_noerr collaboration.output;
  close_out_noerr collaboration.watchdog;
  if !(collaboration.alive) then terminate_process collaboration.pid;
  collaboration.alive := false

let collaboration_alive collaboration =
  if not !(collaboration.alive) then false
  else
    match Unix.waitpid [ Unix.WNOHANG ] collaboration.pid with
    | 0, _ -> true
    | _ ->
        collaboration.alive := false;
        false
    | exception Unix.Unix_error _ ->
        collaboration.alive := false;
        false

let flush_collaboration_before_shutdown context socket collaboration =
  if collaboration_alive collaboration then
    match Unix.fork () with
    | 0 ->
        Sys.set_signal Sys.sigint Sys.Signal_ignore;
        Sys.set_signal Sys.sigterm Sys.Signal_ignore;
        Unix.close socket;
        close_in_noerr collaboration.output;
        close_out_noerr collaboration.watchdog;
        let status =
          match collaboration_request context "/internal/flush" (`Assoc []) with
          | Ok _ -> 0
          | Error message ->
              prerr_endline ("Could not flush live edits during shutdown: " ^ message);
              1
        in
        Unix._exit status
    | flusher ->
        let deadline = Unix.gettimeofday () +. 5. in
        let handlers = ref [] in
        let reap_handlers () = handlers := reap_workers !handlers in
        let stop_handlers () =
          List.iter (fun pid -> terminate_process ~timeout:0.2 pid) !handlers;
          handlers := []
        in
        let rec pump () =
          reap_handlers ();
          match Unix.waitpid [ Unix.WNOHANG ] flusher with
          | pid, _ when pid <> 0 -> stop_handlers ()
          | _ when Unix.gettimeofday () >= deadline ->
              terminate_process ~timeout:0.5 flusher;
              stop_handlers ();
              prerr_endline
                "Timed out flushing live edits during shutdown; the durable collaboration snapshot will be recovered on restart."
          | _ ->
              let ready =
                try
                  let ready, _, _ = Unix.select [ socket ] [] [] 0.05 in
                  ready
                with Unix.Unix_error (Unix.EINTR, _, _) -> []
              in
              if ready <> [] then (
                let client, _ = Unix.accept socket in
                Unix.setsockopt_float client Unix.SO_RCVTIMEO 5.;
                Unix.setsockopt_float client Unix.SO_SNDTIMEO 5.;
                match Unix.fork () with
                | 0 ->
                    Sys.set_signal Sys.sigint Sys.Signal_ignore;
                    Sys.set_signal Sys.sigterm Sys.Signal_ignore;
                    Unix.close socket;
                    close_in_noerr collaboration.output;
                    close_out_noerr collaboration.watchdog;
                    (try handle_client context client
                     with exception_ ->
                       prerr_endline
                         ("Shutdown flush request failed: "
                         ^ Printexc.to_string exception_));
                    Unix._exit 0
                | pid ->
                    Unix.close client;
                    handlers := pid :: !handlers);
              pump ()
        in
        pump ()

let serve ~root ~assets ~port ~public_origin ~collaboration_port
    ~public_collaboration_port ~browser_execution_only ~collaboration_transport =
  let project = Project.create root in
  ignore (Evaluator.compiler_identity ());
  (match Project.recover_transactions project with
  | Ok () -> ()
  | Error error ->
      failwith
        ("Could not recover an interrupted transaction: "
        ^ Project.error_message error));
  let initial_snapshot =
    match Project.snapshot project with
    | Ok snapshot -> snapshot
    | Error error ->
        failwith
          ("Could not initialize the compiler workspace: "
          ^ Project.error_message error)
  in
  let assets = try Unix.realpath assets with Unix.Unix_error _ -> assets in
  let session_token = Util.random_token () in
  let coordinator =
    match
      Compiler_workspace.start_coordinator ~root:project.root
        initial_snapshot.page_index
    with
    | Ok coordinator -> coordinator
    | Error message -> failwith ("Could not start the Dune watcher: " ^ message)
  in
  let coordinator_ref = ref coordinator in
  let socket =
    let socket = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
    try
      Unix.set_close_on_exec socket;
      Unix.setsockopt socket Unix.SO_REUSEADDR true;
      Unix.bind socket (Unix.ADDR_INET (Unix.inet_addr_loopback, port));
      Unix.listen socket 64;
      socket
    with error ->
      Unix.close socket;
      Compiler_workspace.stop_coordinator !coordinator_ref;
      raise error
  in
  let collaboration =
    try
      start_collaboration ~root:project.root ~assets ~dox_port:port
        ~collaboration_port ~public_origin ~token:session_token
    with error ->
      Unix.close socket;
      Compiler_workspace.stop_coordinator !coordinator_ref;
      raise error
  in
  let context =
    {
      project;
      assets;
      port;
      collaboration_port = collaboration.port;
      public_host = public_origin;
      browser_execution_only;
      collaboration_transport;
      public_collaboration_port =
        (match public_collaboration_port with
        | Some port -> port
        | None -> collaboration.port);
      session_token;
    }
  in
  Sys.set_signal Sys.sigchld Sys.Signal_default;
  Printf.printf "Dox is running at http://127.0.0.1:%d\n%!" port;
  Printf.printf "Project: %s\n%!" project.root;
  let max_workers = 16 in
  let workers_ref = ref [] in
  let rec loop workers =
    let workers = reap_workers workers in
    workers_ref := workers;
    let client, _, workers = accept_and_reap_workers socket workers in
    workers_ref := workers;
    Unix.setsockopt_float client Unix.SO_RCVTIMEO 10.;
    Unix.setsockopt_float client Unix.SO_SNDTIMEO 10.;
    let coordinator_ready =
      if not (collaboration_alive collaboration) then
        Error "The collaboration service stopped; restart Dox."
      else if Compiler_workspace.coordinator_alive !coordinator_ref then Ok ()
      else (
        Compiler_workspace.detach_coordinator_owner !coordinator_ref;
        match Project.snapshot project with
        | Error error -> Error (Project.error_message error)
        | Ok snapshot -> (
            match
              Compiler_workspace.start_coordinator ~root:project.root
                snapshot.page_index
            with
            | Ok coordinator ->
                coordinator_ref := coordinator;
                Ok ()
            | Error message -> Error message))
    in
    match coordinator_ready with
    | Error message ->
        let output = Unix.out_channel_of_descr client in
        send_response context output
          (error ~status:503
             ("The local compiler coordinator could not restart: " ^ message));
        close_out_noerr output;
        loop workers
    | Ok () when List.length workers >= max_workers ->
        let output = Unix.out_channel_of_descr client in
        send_response context output
          (error ~status:503
             "The local workspace is busy; retry after an evaluation finishes.");
        close_out_noerr output;
        loop workers
    | Ok () -> (
        match Unix.fork () with
        | 0 ->
            Unix.close socket;
            close_out_noerr collaboration.watchdog;
            Compiler_workspace.detach_coordinator_owner !coordinator_ref;
            (try handle_client context client
             with exception_ ->
               prerr_endline ("Request failed: " ^ Printexc.to_string exception_));
            Unix._exit 0
        | pid ->
            Unix.close client;
            workers_ref := pid :: workers;
            loop (pid :: workers))
  in
  let stop _ = raise Exit in
  Sys.set_signal Sys.sigint (Sys.Signal_handle stop);
  Sys.set_signal Sys.sigterm (Sys.Signal_handle stop);
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun pid ->
          try Unix.kill pid Sys.sigterm with Unix.Unix_error _ -> ())
        !workers_ref;
      List.iter
        (fun pid ->
          try ignore (Unix.waitpid [] pid) with Unix.Unix_error _ -> ())
        !workers_ref;
      flush_collaboration_before_shutdown context socket collaboration;
      Unix.close socket;
      Compiler_workspace.stop_coordinator !coordinator_ref;
      stop_collaboration collaboration)
    (fun () -> try loop [] with Exit -> ())
