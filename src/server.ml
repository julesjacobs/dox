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
  session_token : string;
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
  let max_body = 2_000_000 in
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

let send_response channel response =
  Printf.fprintf channel "HTTP/1.1 %d %s\r\n" response.status
    (status_text response.status);
  Printf.fprintf channel "Content-Type: %s\r\n" response.content_type;
  Printf.fprintf channel "Content-Length: %d\r\n" (String.length response.body);
  Printf.fprintf channel
    "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src \
     'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; \
     connect-src 'self'; base-uri 'none'; form-action 'self'\r\n";
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

let expected_hosts context =
  [
    Printf.sprintf "127.0.0.1:%d" context.port;
    Printf.sprintf "localhost:%d" context.port;
  ]

let same_origin context headers =
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
          (fun host -> String.equal origin ("http://" ^ host))
          (expected_hosts context)
  in
  host_ok && origin_ok

let authorized context headers =
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
    let* values = list_member "modules" request in
    let* base_project_version = string_member "baseProjectVersion" request in
    let rec strings result = function
      | [] -> Ok (List.rev result)
      | `String value :: rest -> strings (value :: result) rest
      | _ -> Error "Expected modules to contain only strings."
    in
    let* module_paths = strings [] values in
    Ok (module_paths, base_project_version)
  in
  match parsed with
  | Error message -> error message
  | Ok (module_paths, base_project_version) -> (
      match
        Project.create_pages context.project ~module_paths ~base_project_version
          ~principal:"workspace-user"
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

let refactor_preview_response context body =
  let open Util in
  match
    let* request = json_body body in
    let* project_version = string_member "projectVersion" request in
    let* renames = module_renames request in
    Ok (project_version, renames)
  with
  | Error message -> error message
  | Ok (project_version, renames) -> (
      match Project.snapshot context.project with
      | Error project_error_ -> project_error project_error_
      | Ok snapshot -> (
          if not (String.equal snapshot.version project_version) then
            error ~status:409 "The project changed before the refactor preview."
          else
            match Project.refactor_preview snapshot renames with
            | Error project_error_ -> project_error project_error_
            | Ok preview -> json preview))

let refactor_apply_response context body =
  let open Util in
  match
    let* request = json_body body in
    let* project_version = string_member "projectVersion" request in
    let* preview_id = string_member "previewId" request in
    let* renames = module_renames request in
    Ok (project_version, preview_id, renames)
  with
  | Error message -> error message
  | Ok (project_version, preview_id, renames) -> (
      match
        Project.apply_module_refactor context.project
          ~expected_project_version:project_version
          ~expected_preview_id:preview_id renames
      with
      | Error project_error_ -> project_error project_error_
      | Ok (preview, snapshot, mapping) ->
          json
            (`Assoc
               [
                 ("preview", preview);
                 ("mapping", mapping);
                 ("project", Project.snapshot_to_json context.project snapshot);
                 ("projectVersion", `String snapshot.version);
               ]))

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
    match Project.snapshot context.project with
    | Error project_error_ -> Error (Project.error_message project_error_)
    | Ok snapshot -> (
        profile "snapshot" request_started;
        if not (String.equal snapshot.version base_project_version) then
          Error "The project changed; reload before evaluating this draft."
        else
          let document = Document.parse ~path source in
          let resolve_started = Unix.gettimeofday () in
          match
            Project.resolve_documents ~cancelled context.project snapshot
              document
          with
          | Error project_error_ -> Error (Project.error_message project_error_)
          | Ok documents ->
              profile "resolveDocuments" resolve_started;
              let evaluation_started = Unix.gettimeofday () in
              let evaluation =
                Evaluator.evaluate_documents ~project_version:snapshot.version
                  ~cancelled ~documents ~target:document ()
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
                  ~project_version:base_project_version ~cancelled ~documents
                  ~target:draft ()
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
  else if Util.ends_with ~suffix:".js" path then
    "text/javascript; charset=utf-8"
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
               ("projectRoot", `String context.project.root);
             ])
      else error ~status:403 "Cross-origin workspace request rejected."
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
  | "POST", "/api/evaluate" ->
      require_active_request context headers (fun () ->
          evaluate_response context ~cancelled body)
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
  | "POST", "/api/document" ->
      require_active_request context headers (fun () ->
          create_response context body)
  | "POST", "/api/page" ->
      require_active_request context headers (fun () ->
          create_page_response context body)
  | "POST", "/api/pages" ->
      require_active_request context headers (fun () ->
          create_pages_response context body)
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
      | Error (status, message) -> send_response output (error ~status message)
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
          send_response output response)

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

let serve ~root ~assets ~port =
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
  let context =
    { project; assets; port; session_token = Util.random_token () }
  in
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
      if Compiler_workspace.coordinator_alive !coordinator_ref then Ok ()
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
        send_response output
          (error ~status:503
             ("The local compiler coordinator could not restart: " ^ message));
        close_out_noerr output;
        loop workers
    | Ok () when List.length workers >= max_workers ->
        let output = Unix.out_channel_of_descr client in
        send_response output
          (error ~status:503
             "The local workspace is busy; retry after an evaluation finishes.");
        close_out_noerr output;
        loop workers
    | Ok () -> (
        match Unix.fork () with
        | 0 ->
            Unix.close socket;
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
      Unix.close socket;
      List.iter
        (fun pid ->
          try Unix.kill pid Sys.sigterm with Unix.Unix_error _ -> ())
        !workers_ref;
      List.iter
        (fun pid ->
          try ignore (Unix.waitpid [] pid) with Unix.Unix_error _ -> ())
        !workers_ref;
      Compiler_workspace.stop_coordinator !coordinator_ref)
    (fun () -> try loop [] with Exit -> ())
