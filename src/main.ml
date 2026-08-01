let usage () =
  Printf.eprintf
    "Usage:\n\
    \  dox serve [--root DIR] [--assets DIR] [--port PORT]\n\
    \  dox check FILE\n\
    \  dox inspect FILE LINE COLUMN [--summary]\n\
    \  dox inspect-call FILE LINE COLUMN [--occurrence N] [--summary]\n\
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

let print_inspection_summary query =
  let open Yojson.Safe.Util in
  let expression = query |> member "expression" in
  Printf.printf "%s : %s\n"
    (expression |> member "expression" |> to_string)
    (expression |> member "type" |> to_string);
  let occurrences = query |> member "occurrences" |> to_list in
  if occurrences = [] then print_endline "not executed"
  else
    List.iter
      (fun occurrence ->
        let index = occurrence |> member "index" |> to_int in
        let total = occurrence |> member "total" |> to_int in
        let outcome = occurrence |> member "outcome" |> to_string in
        let value =
          occurrence |> member "value" |> to_string_option
          |> Option.value ~default:"…"
        in
        Printf.printf "%d of %d · %s %s\n" index total
          (if String.equal outcome "raise" then "raised" else "=")
          value;
        let breadcrumb =
          occurrence |> member "breadcrumb" |> to_list
          |> List.filter_map (fun call ->
              call |> member "label" |> to_string_option)
        in
        if breadcrumb <> [] then
          Printf.printf "  %s\n" (String.concat " › " breadcrumb);
        occurrence |> member "environment" |> to_list
        |> List.iter (fun binding ->
            Printf.printf "  %s = %s : %s\n"
              (binding |> member "name" |> to_string)
              (binding |> member "value" |> to_string)
              (binding |> member "type" |> to_string)))
      occurrences

let inspect path line column summary =
  let line = int_of_string_opt line in
  let column = int_of_string_opt column in
  match (line, column) with
  | Some line, Some column when line > 0 && column >= 0 -> (
      let project = Project.create (Sys.getcwd ()) in
      let result =
        match Project.snapshot project with
        | Error error -> Error (Project.error_message error)
        | Ok snapshot -> (
            match Project.document snapshot path with
            | Error error -> Error (Project.error_message error)
            | Ok target ->
                Result.bind
                  (Project.resolve_documents project snapshot target
                  |> Result.map_error Project.error_message)
                  (fun documents ->
                    Debugger.query ~documents ~target ~line ~column ()))
      in
      match result with
      | Error message ->
          prerr_endline message;
          exit 1
      | Ok query ->
          if summary then print_inspection_summary query
          else print_endline (Yojson.Safe.pretty_to_string query))
  | _ -> usage ()

let print_invocation_summary invocation =
  let open Yojson.Safe.Util in
  let function_ = invocation |> member "function" in
  let occurrence = invocation |> member "occurrence" |> to_int in
  let occurrence_count = invocation |> member "occurrenceCount" |> to_int in
  let label = function_ |> member "label" |> to_string in
  let value =
    function_ |> member "value" |> to_string_option |> Option.value ~default:"…"
  in
  let type_ = function_ |> member "type" |> to_string in
  let parameters =
    invocation |> member "binders" |> to_list
    |> List.filter (fun binder ->
        binder |> member "kind" |> to_string = "parameter")
    |> List.map (fun binder -> binder |> member "value" |> to_string)
  in
  Printf.printf "%s %d of %d\n" label occurrence occurrence_count;
  Printf.printf "%s%s → %s : %s\n" label
    (if parameters = [] then "" else " " ^ String.concat " " parameters)
    value type_;
  invocation |> member "binders" |> to_list
  |> List.iter (fun binder ->
      Printf.printf "  %d:%d  %s ↦ %s : %s\n"
        (binder |> member "line" |> to_int)
        (binder |> member "column" |> to_int)
        (binder |> member "name" |> to_string)
        (binder |> member "value" |> to_string)
        (binder |> member "type" |> to_string));
  (match invocation |> member "parent" with
  | `Null -> ()
  | parent ->
      Printf.printf "parent  %s → %s\n"
        (parent |> member "label" |> to_string)
        (parent |> member "value" |> to_string_option
        |> Option.value ~default:"…"));
  let children = invocation |> member "children" |> to_list in
  if children <> [] then (
    print_endline "calls";
    List.iter
      (fun child ->
        Printf.printf "  %s → %s\n"
          (child |> member "label" |> to_string)
          (child |> member "value" |> to_string_option
          |> Option.value ~default:"…"))
      children)

let inspect_call path line column occurrence summary =
  let line = int_of_string_opt line in
  let column = int_of_string_opt column in
  match (line, column) with
  | Some line, Some column when line > 0 && column >= 0 -> (
      let project = Project.create (Sys.getcwd ()) in
      let result =
        match Project.snapshot project with
        | Error error -> Error (Project.error_message error)
        | Ok snapshot -> (
            match Project.document snapshot path with
            | Error error -> Error (Project.error_message error)
            | Ok target ->
                Result.bind
                  (Project.resolve_documents project snapshot target
                  |> Result.map_error Project.error_message)
                  (fun documents ->
                    Debugger.query_invocation ~documents ~target ~line ~column
                      ~occurrence ()))
      in
      match result with
      | Error message ->
          prerr_endline message;
          exit 1
      | Ok invocation ->
          if summary then print_invocation_summary invocation
          else print_endline (Yojson.Safe.pretty_to_string invocation))
  | _ -> usage ()

let rec inspect_call_options occurrence summary = function
  | [] -> (occurrence, summary)
  | "--summary" :: rest -> inspect_call_options occurrence true rest
  | "--occurrence" :: value :: rest -> (
      match int_of_string_opt value with
      | Some occurrence when occurrence > 0 ->
          inspect_call_options occurrence summary rest
      | _ -> usage ())
  | _ -> usage ()

let () =
  match Array.to_list Sys.argv with
  | _ :: "serve" :: rest ->
      serve_options (Sys.getcwd ())
        (Filename.concat (Sys.getcwd ()) "web")
        8080 rest
  | [ _; "check"; path ] -> check path
  | [ _; "inspect"; path; line; column ] -> inspect path line column false
  | [ _; "inspect"; path; line; column; "--summary" ] ->
      inspect path line column true
  | _ :: "inspect-call" :: path :: line :: column :: options ->
      let occurrence, summary = inspect_call_options 1 false options in
      inspect_call path line column occurrence summary
  | [ _; "artifact"; path; entry; output ] -> artifact path entry output
  | _ -> usage ()
