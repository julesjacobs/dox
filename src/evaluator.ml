type diagnostic = {
  stage : string;
  severity : string;
  message : string;
  path : string option;
  line : int option;
  column_start : int option;
  column_end : int option;
}

type binding = { name : string; type_ : string }
type view = { sequence : int; kind : string; id : string; content : string }

type block_output = {
  path : string;
  block_id : string;
  stdout : string;
  stderr : string;
}

type inline_result = {
  id : string;
  path : string;
  expression : string;
  line : int;
  column_start : int;
  column_end : int;
  result_column : int;
  type_ : string;
  value : string;
  error : string option;
}

type inline_marker = {
  virtual_path : string;
  document_path : string;
  inline_expression : Document.inline_expression;
}

type trace_event = {
  sequence : int;
  domain_id : int;
  phase : string;
  occurrence_id : string;
  parent_id : string option;
  site_id : string;
  kind : string;
  label : string;
  path : string;
  source_line : int;
  source_column : int;
  source_end_line : int;
  source_end_column : int;
  type_ : string;
  value_complete : bool;
  detail : string;
}

type type_info = {
  expression : string;
  type_ : string;
  start_line : int;
  start_column : int;
  end_line : int;
  end_column : int;
}

type execution_site_range = {
  range_start_line : int;
  range_start_column : int;
  range_end_line : int;
  range_end_column : int;
}

type execution_site = {
  site_id : string;
  site_parent_id : string option;
  site_kind : string;
  site_ghost : bool;
  site_start_line : int;
  site_start_column : int;
  site_end_line : int;
  site_end_column : int;
  site_target : execution_site_range option;
  site_selection : execution_site_range option;
  site_role : string option;
  site_direct : bool;
}

type compiler_token = {
  token_range : execution_site_range;
  token_role : string option;
  token_operator : bool;
}

type compiler_construct = {
  construct_id : string;
  construct_category : string;
  construct_semantic_kind : string;
  construct_generated_path : string;
  construct_start_byte : int;
  construct_end_byte : int;
  construct_start_line : int;
  construct_start_column : int;
  construct_end_line : int;
  construct_end_column : int;
  construct_ghost : bool;
  construct_parent_id : string option;
  construct_owner_scope_id : string;
  construct_lexical_scope_id : string;
  construct_syntax_fingerprint : string;
  construct_lexical_ancestry_fingerprint : string;
}

type compiler_execution_scope = {
  scope_id : string;
  scope_kind : string;
  scope_function_construct_id : string option;
}

type compiler_selector = {
  selector_id : string;
  selector_role : string;
  selector_subject_id : string;
  selector_generated_path : string;
  selector_start_byte : int;
  selector_end_byte : int;
  selector_start_line : int;
  selector_start_column : int;
  selector_end_line : int;
  selector_end_column : int;
  selector_priority : int;
  selector_tie_break_rank : int;
  selector_syntax_fingerprint : string;
}

type compiler_manifest = {
  manifest_unit_name : string;
  manifest_generated_path : string;
  manifest_byte_length : int;
  manifest_source_digest : string;
  manifest_top_level_scope_id : string;
  manifest_execution_scopes : compiler_execution_scope list;
  manifest_constructs : compiler_construct list;
  manifest_selectors : compiler_selector list;
}

type source_map_entry = {
  map_selector_id : string;
  map_generated_path : string;
  map_start_byte : int;
  map_end_byte : int;
  map_document_path : string;
  map_start_utf16 : int;
  map_end_utf16 : int;
}

type compiled_document_units = {
  compiled_signature : string;
  compiled_executable : string;
  compiled_warnings : string;
  compiled_manifests : compiler_manifest list;
}

type definition_info = {
  name : string;
  kind : string;
  module_path : string;
  path : string;
  line : int;
  column : int;
  source : string;
  truncated : bool;
}

type completion_entry = {
  name : string;
  kind : string;
  desc : string;
  deprecated : bool;
}

type result = {
  ok : bool;
  status : string;
  evaluation_id : string;
  request_code_digest : string;
  code_revision_id : string;
  document_version : string;
  document_revision_id : string;
  sources_digest : string;
  extracted_code_digest : string;
  project_digest : string;
  project_version : string option;
  started_at : string;
  compiler : string;
  signature : string;
  bindings : binding list;
  stdout : string;
  stderr : string;
  block_outputs : block_output list;
  inline_results : inline_result list;
  views : view list;
  traces : trace_event list;
  compiler_manifests : compiler_manifest list;
  source_map_entries : source_map_entry list;
  trace_truncated : bool;
  tail_handoffs : int;
  tail_linked_enters : int;
  tail_handoff_outcomes : int;
  tail_handoff_occurrences : string list;
  diagnostics : diagnostic list;
  duration_ms : int;
}

type process_result = {
  status : Unix.process_status;
  stdout : string;
  stderr : string;
  timed_out : bool;
  output_limited : bool;
}

exception Cancelled

let successful = function Unix.WEXITED 0 -> true | _ -> false

(* This transport checksum detects accidental corruption. Revision identity and
   cache correctness use SHA-256 separately; this is not an authentication
   boundary. Keeping the synchronous checksum small avoids adding latency to
   every large execution artifact in the browser. *)
let execution_checksum input =
  let hash = ref 0x811c9dc5l in
  String.iter
    (fun character ->
      hash :=
        Int32.mul
          (Int32.logxor !hash (Int32.of_int (Char.code character)))
          0x01000193l)
    input;
  Printf.sprintf "%08lx" !hash

let execution_canonical_json json =
  let buffer = Buffer.create 4096 in
  let add_length_prefixed prefix value =
    Buffer.add_char buffer prefix;
    Buffer.add_string buffer (string_of_int (String.length value));
    Buffer.add_char buffer ':';
    Buffer.add_string buffer value
  in
  let rec encode = function
    | `Null -> Buffer.add_char buffer 'n'
    | `Bool false -> Buffer.add_string buffer "b0"
    | `Bool true -> Buffer.add_string buffer "b1"
    | `Int value -> add_length_prefixed 'i' (string_of_int value)
    | `Intlit value -> add_length_prefixed 'i' value
    | `Float value ->
        add_length_prefixed 'd' (Printf.sprintf "%.17g" value)
    | `String value -> add_length_prefixed 's' value
    | `List values ->
        Buffer.add_char buffer 'l';
        Buffer.add_string buffer (string_of_int (List.length values));
        Buffer.add_char buffer ':';
        List.iter encode values
    | `Assoc fields ->
        let fields = List.sort (fun (left, _) (right, _) -> String.compare left right) fields in
        Buffer.add_char buffer 'o';
        Buffer.add_string buffer (string_of_int (List.length fields));
        Buffer.add_char buffer ':';
        List.iter
          (fun (name, value) ->
            add_length_prefixed 's' name;
            encode value)
          fields
    | `Tuple values -> encode (`List values)
    | `Variant (name, None) -> encode (`String name)
    | `Variant (name, Some value) -> encode (`List [ `String name; value ])
  in
  encode json;
  Buffer.contents buffer

let environment_with additions =
  let keys = List.map (fun (key, _) -> key ^ "=") additions in
  let inherited =
    Unix.environment () |> Array.to_list
    |> List.filter (fun item ->
        not (List.exists (fun prefix -> Util.starts_with ~prefix item) keys))
  in
  Array.of_list
    (List.map (fun (key, value) -> key ^ "=" ^ value) additions @ inherited)

let file_size path = try (Unix.stat path).st_size with Unix.Unix_error _ -> 0

let read_file_prefix path limit =
  try
    let channel = open_in_bin path in
    Fun.protect
      ~finally:(fun () -> close_in_noerr channel)
      (fun () ->
        let length = min limit (in_channel_length channel) in
        really_input_string channel length)
  with Sys_error _ -> ""

let decode_hex value =
  let nibble = function
    | '0' .. '9' as character -> Char.code character - Char.code '0'
    | 'a' .. 'f' as character -> 10 + Char.code character - Char.code 'a'
    | 'A' .. 'F' as character -> 10 + Char.code character - Char.code 'A'
    | _ -> invalid_arg "invalid hexadecimal character"
  in
  if String.length value mod 2 <> 0 then invalid_arg "odd hexadecimal string";
  String.init (String.length value / 2) (fun index ->
      Char.chr
        ((nibble value.[index * 2] lsl 4) lor nibble value.[(index * 2) + 1]))

let read_compiler_manifest path =
  match Util.read_file path with
  | Error message -> Error message
  | Ok contents -> (
      try
        match String.split_on_char '\n' contents with
        | header :: entries -> (
            match String.split_on_char '\t' header with
            | [ "dox-construct-manifest"; "6"; unit_name;
                top_level_scope_id; generated_path; byte_length;
                source_digest ] ->
                let constructs = ref [] in
                let execution_scopes = ref [] in
                let selectors = ref [] in
                let parse_entry entry =
                  match String.split_on_char '\t' entry with
                  | [ "C"; id; category; semantic_kind; source_path; start_byte; end_byte;
                      start_line; start_column; end_line; end_column; ghost;
                      parent_id; owner_scope_id; lexical_scope_id;
                      syntax_fingerprint; lexical_ancestry_fingerprint ] ->
                      constructs :=
                        {
                          construct_id = decode_hex id;
                          construct_category = category;
                          construct_semantic_kind = semantic_kind;
                          construct_generated_path = decode_hex source_path;
                          construct_start_byte = int_of_string start_byte;
                          construct_end_byte = int_of_string end_byte;
                          construct_start_line = int_of_string start_line;
                          construct_start_column = int_of_string start_column;
                          construct_end_line = int_of_string end_line;
                          construct_end_column = int_of_string end_column;
                          construct_ghost = String.equal ghost "1";
                          construct_parent_id =
                            (if String.equal parent_id "-" then None
                             else Some (decode_hex parent_id));
                          construct_owner_scope_id = decode_hex owner_scope_id;
                          construct_lexical_scope_id =
                            decode_hex lexical_scope_id;
                          construct_syntax_fingerprint = syntax_fingerprint;
                          construct_lexical_ancestry_fingerprint =
                            lexical_ancestry_fingerprint;
                        }
                        :: !constructs
                  | [ "S"; id; kind; function_construct_id ] ->
                      execution_scopes :=
                        {
                          scope_id = decode_hex id;
                          scope_kind = kind;
                          scope_function_construct_id =
                            (if String.equal function_construct_id "-" then None
                             else Some (decode_hex function_construct_id));
                        }
                        :: !execution_scopes
                  | [ "L"; id; role; subject_id; source_path; start_byte;
                      end_byte; start_line; start_column; end_line; end_column;
                      priority; tie_break_rank; syntax_fingerprint ] ->
                      selectors :=
                        {
                          selector_id = decode_hex id;
                          selector_role = role;
                          selector_subject_id = decode_hex subject_id;
                          selector_generated_path = decode_hex source_path;
                          selector_start_byte = int_of_string start_byte;
                          selector_end_byte = int_of_string end_byte;
                          selector_start_line = int_of_string start_line;
                          selector_start_column = int_of_string start_column;
                          selector_end_line = int_of_string end_line;
                          selector_end_column = int_of_string end_column;
                          selector_priority = int_of_string priority;
                          selector_tie_break_rank = int_of_string tie_break_rank;
                          selector_syntax_fingerprint = syntax_fingerprint;
                        }
                        :: !selectors
                  | _ -> invalid_arg "invalid construct row"
                in
                entries
                |> List.filter (fun entry -> not (String.equal entry ""))
                |> List.iter parse_entry;
                Ok
                  {
                    manifest_unit_name = decode_hex unit_name;
                    manifest_generated_path = decode_hex generated_path;
                    manifest_byte_length = int_of_string byte_length;
                    manifest_source_digest = source_digest;
                    manifest_top_level_scope_id =
                      decode_hex top_level_scope_id;
                    manifest_execution_scopes = List.rev !execution_scopes;
                    manifest_constructs = List.rev !constructs;
                    manifest_selectors = List.rev !selectors;
                  }
            | _ -> Error "Unsupported compiler construct manifest header.")
        | [] -> Error "Empty compiler construct manifest."
      with
      | Invalid_argument message | Failure message ->
          Error ("Invalid compiler construct manifest: " ^ message))

let run_process ?cwd ?stdin ?(environment = []) ?(extra_output_paths = [])
    ?(timeout_seconds = 10.) ?(output_limit = 2_000_000)
    ?(cancelled = fun () -> false) program arguments =
  if cancelled () then raise Cancelled;
  let profile_started = Unix.gettimeofday () in
  let stdout_path = Filename.temp_file "dox-stdout-" ".txt" in
  let stderr_path = Filename.temp_file "dox-stderr-" ".txt" in
  let stdin_path =
    Option.map
      (fun contents ->
        let path = Filename.temp_file "dox-stdin-" ".txt" in
        let channel = open_out_bin path in
        Fun.protect
          ~finally:(fun () -> close_out_noerr channel)
          (fun () -> output_string channel contents);
        path)
      stdin
  in
  let stdin_fd =
    Unix.openfile
      (Option.value ~default:"/dev/null" stdin_path)
      [ Unix.O_RDONLY ] 0
  in
  let stdout_fd =
    Unix.openfile stdout_path [ Unix.O_WRONLY; Unix.O_TRUNC ] 0o600
  in
  let stderr_fd =
    Unix.openfile stderr_path [ Unix.O_WRONLY; Unix.O_TRUNC ] 0o600
  in
  let close descriptor =
    try Unix.close descriptor with Unix.Unix_error _ -> ()
  in
  let cleanup_files () =
    Option.iter
      (fun path -> try Sys.remove path with Sys_error _ -> ())
      stdin_path;
    (try Sys.remove stdout_path with Sys_error _ -> ());
    try Sys.remove stderr_path with Sys_error _ -> ()
  in
  try
    let process =
      match Unix.fork () with
      | 0 -> (
          try
            ignore (Unix.setsid ());
            Unix.dup2 stdin_fd Unix.stdin;
            Unix.dup2 stdout_fd Unix.stdout;
            Unix.dup2 stderr_fd Unix.stderr;
            close stdin_fd;
            close stdout_fd;
            close stderr_fd;
            Option.iter Unix.chdir cwd;
            Unix.execvpe program
              (Array.of_list (program :: arguments))
              (environment_with environment)
          with error ->
            prerr_endline
              ("Could not start process: " ^ Printexc.to_string error);
            Unix._exit 127)
      | process -> process
    in
    close stdin_fd;
    close stdout_fd;
    close stderr_fd;
    let deadline = Unix.gettimeofday () +. timeout_seconds in
    let rec wait () =
      match Unix.waitpid [ Unix.WNOHANG ] process with
      | 0, _ ->
          if cancelled () then (
            (try Unix.kill (-process) Sys.sigkill with Unix.Unix_error _ -> ());
            ignore (Unix.waitpid [] process);
            raise Cancelled);
          let timed_out = Unix.gettimeofday () >= deadline in
          let output_limited =
            file_size stdout_path + file_size stderr_path
            + List.fold_left
                (fun total path -> total + file_size path)
                0 extra_output_paths
            > output_limit
          in
          if timed_out || output_limited then (
            (try Unix.kill (-process) Sys.sigkill with Unix.Unix_error _ -> ());
            let _, status = Unix.waitpid [] process in
            (status, timed_out, output_limited))
          else (
            ignore (Unix.select [] [] [] 0.01);
            wait ())
      | _, status ->
          (try Unix.kill (-process) Sys.sigkill with Unix.Unix_error _ -> ());
          (status, false, false)
      | exception Unix.Unix_error (Unix.EINTR, _, _) -> wait ()
    in
    let status, timed_out, output_limited = wait () in
    let output_limited =
      output_limited
      || file_size stdout_path + file_size stderr_path
         + List.fold_left
             (fun total path -> total + file_size path)
             0 extra_output_paths
         > output_limit
    in
    let stdout = read_file_prefix stdout_path output_limit in
    let stderr = read_file_prefix stderr_path output_limit in
    cleanup_files ();
    let result = { status; stdout; stderr; timed_out; output_limited } in
    if Option.is_some (Sys.getenv_opt "DOX_PROFILE") then
      prerr_endline
        ("DOX_PROFILE "
        ^ Yojson.Safe.to_string
            (`Assoc
               [
                 ("phase", `String "process");
                 ("program", `String program);
                 ( "arguments",
                   `List (List.map (fun value -> `String value) arguments) );
                 ( "durationMs",
                   `Int
                     (int_of_float
                        ((Unix.gettimeofday () -. profile_started) *. 1000.)) );
                 ("success", `Bool (successful status));
               ]));
    result
  with error ->
    close stdin_fd;
    close stdout_fd;
    close stderr_fd;
    cleanup_files ();
    raise error

let hex_decode value =
  let nibble = function
    | '0' .. '9' as character -> Char.code character - Char.code '0'
    | 'a' .. 'f' as character -> 10 + Char.code character - Char.code 'a'
    | 'A' .. 'F' as character -> 10 + Char.code character - Char.code 'A'
    | _ -> -1
  in
  if String.length value mod 2 <> 0 then Error "odd-length hex value"
  else
    let buffer = Buffer.create (String.length value / 2) in
    let rec loop index =
      if index >= String.length value then Ok (Buffer.contents buffer)
      else
        let high = nibble value.[index] in
        let low = nibble value.[index + 1] in
        if high < 0 || low < 0 then Error "invalid hex value"
        else (
          Buffer.add_char buffer (Char.chr ((high * 16) + low));
          loop (index + 2))
    in
    loop 0

let trace_event sequence content =
  match String.split_on_char '\x1f' content with
  | [
   phase;
   domain_id;
   occurrence_id;
   parent_id;
   site_id;
   kind;
   label;
   path;
   line;
   column;
   end_line;
   end_column;
   type_;
   value_complete;
   detail;
  ] ->
      Option.bind (int_of_string_opt domain_id) (fun domain_id ->
        Option.bind (int_of_string_opt line) (fun line ->
          Option.bind (int_of_string_opt column) (fun column ->
              Option.bind (int_of_string_opt end_line) (fun end_line ->
                  Option.map
                    (fun end_column ->
                      {
                        sequence;
                        domain_id;
                        phase;
                        occurrence_id;
                        parent_id =
                          (if String.equal parent_id "" then None
                           else Some parent_id);
                        site_id;
                        kind;
                        label;
                        path;
                        source_line = line;
                        source_column = column;
                        source_end_line = end_line;
                        source_end_column = end_column;
                        type_;
                        value_complete = String.equal value_complete "1";
                        detail;
                      })
                    (int_of_string_opt end_column)))))
  | _ -> None

let parse_runtime_events contents =
  String.split_on_char '\n' contents
  |> List.mapi (fun sequence line ->
      if String.equal line "" then None
      else
        match String.split_on_char '\t' line with
        | [ kind; id; content ] -> (
            match (hex_decode id, hex_decode content) with
            | Ok id, Ok content -> Some (sequence, kind, id, content)
            | _ -> None)
        | _ -> None)
  |> List.filter_map Fun.id
  |> List.fold_left
       (fun (views, traces) (sequence, kind, id, content) ->
         if String.equal kind "trace-truncated" then (views, traces)
         else if String.equal kind "observe" then
           match trace_event sequence content with
           | Some event -> (views, event :: traces)
           | None -> (views, traces)
         else ({ sequence; kind; id; content } :: views, traces))
       ([], [])
  |> fun (views, traces) -> (List.rev views, List.rev traces)

let runtime_events_truncated contents =
  String.split_on_char '\n' contents
  |> List.exists (Util.starts_with ~prefix:"trace-truncated\t")

let runtime_events_malformed contents =
  String.split_on_char '\n' contents
  |> List.exists (fun line ->
      if String.equal line ""
         || Util.starts_with ~prefix:"trace-truncated\t" line
      then false
      else
        match String.split_on_char '\t' line with
        | [ kind; id; content ] -> (
            match (hex_decode id, hex_decode content) with
            | Ok _, Ok content when String.equal kind "observe" ->
              Option.is_none (trace_event 0 content)
            | Ok _, Ok _ -> false
            | Error _, _ | _, Error _ -> true)
        | _ -> true)

let tail_relation_detail detail =
  match String.split_on_char ':' detail with
  | [ handoff; remaining ] ->
      Option.bind (int_of_string_opt handoff) (fun handoff ->
          Option.map (fun remaining -> handoff, remaining)
            (int_of_string_opt remaining))
  | _ -> None

let complete_tail_outcomes ~trace_truncated traces =
  let enters = Hashtbl.create (List.length traces) in
  let outcomes = Hashtbl.create (List.length traces) in
  let handoffs = Hashtbl.create 32 in
  let links = Hashtbl.create 32 in
  let malformed = ref false in
  List.iter
    (fun event ->
      if String.equal event.phase "enter" then
        Hashtbl.replace enters event.occurrence_id event
      else if String.equal event.phase "return"
              || String.equal event.phase "raise"
      then Hashtbl.replace outcomes event.occurrence_id event
      else if String.equal event.phase "tail-handoff" then
        match tail_relation_detail event.detail with
        | Some (handoff, remaining) when not (Hashtbl.mem handoffs handoff) ->
            Hashtbl.add handoffs handoff (event, remaining)
        | Some _ | None -> malformed := true
      else if String.equal event.phase "tail-link" then
        match tail_relation_detail event.detail with
        | Some (handoff, remaining) when not (Hashtbl.mem links handoff) ->
            Hashtbl.add links handoff (event, remaining)
        | Some _ | None -> malformed := true)
    traces;
  let targets = Hashtbl.create 32 in
  Hashtbl.iter
    (fun handoff (source, source_remaining) ->
      match Hashtbl.find_opt links handoff with
      | Some (target, target_remaining)
        when source_remaining = target_remaining
             && target.sequence > source.sequence
             && target.parent_id = Some source.occurrence_id ->
          if source_remaining = 0 then
            Hashtbl.replace targets source.occurrence_id target.occurrence_id
      | Some _ -> malformed := true
      | None when not trace_truncated -> malformed := true
      | None -> ())
    handoffs;
  Hashtbl.iter
    (fun handoff _ ->
      if not (Hashtbl.mem handoffs handoff) then malformed := true)
    links;
  let resolving = Hashtbl.create 32 in
  let rec outcome occurrence =
    match Hashtbl.find_opt outcomes occurrence with
    | Some event -> Some event
    | None when Hashtbl.mem resolving occurrence -> None
    | None ->
      Hashtbl.replace resolving occurrence ();
      let resolved =
        Option.bind (Hashtbl.find_opt targets occurrence) outcome
      in
      Hashtbl.remove resolving occurrence;
      resolved
  in
  let next_sequence =
    ref
      (List.fold_left
         (fun maximum event -> max maximum event.sequence)
         (-1) traces
       + 1)
  in
  let completed = ref [] in
  let completed_occurrences = Hashtbl.create 32 in
  let rec complete occurrence =
    if not (Hashtbl.mem outcomes occurrence)
       && not (Hashtbl.mem completed_occurrences occurrence)
    then (
      Hashtbl.replace completed_occurrences occurrence ();
      match Hashtbl.find_opt targets occurrence with
      | None -> ()
      | Some target ->
        if Hashtbl.mem targets target then complete target;
        match Hashtbl.find_opt enters occurrence, outcome occurrence with
        | Some entered, Some returned ->
          let event =
            {
              entered with
              sequence = !next_sequence;
              phase = returned.phase;
              value_complete = returned.value_complete;
              detail = returned.detail;
            }
          in
          incr next_sequence;
          Hashtbl.replace outcomes occurrence event;
          completed := event :: !completed
        | _ -> ())
  in
  targets |> Hashtbl.to_seq_keys |> List.of_seq |> List.sort String.compare
  |> List.iter complete;
  ( List.filter
      (fun event ->
        not
          (String.equal event.phase "tail-handoff"
          || String.equal event.phase "tail-link"))
      traces
    @ List.rev !completed,
    !malformed )

let raw_tail_stats traces =
  let handed_off = Hashtbl.create 32 in
  let tail_handoffs = ref 0 in
  List.iter
    (fun event ->
      if String.equal event.phase "tail-handoff" then (
        incr tail_handoffs;
        Hashtbl.replace handed_off event.occurrence_id ()))
    traces;
  let tail_linked_enters =
    List.fold_left
      (fun count event ->
        if String.equal event.phase "tail-link"
        then count + 1
        else count)
      0 traces
  in
  let tail_handoff_outcomes =
    List.fold_left
      (fun count event ->
        if (String.equal event.phase "return"
            || String.equal event.phase "raise")
           && Hashtbl.mem handed_off event.occurrence_id
        then count + 1
        else count)
      0 traces
  in
  ( !tail_handoffs,
    tail_linked_enters,
    tail_handoff_outcomes,
    handed_off |> Hashtbl.to_seq_keys |> List.of_seq |> List.sort String.compare )

let prelude =
  {|
module Doc = struct
  let hex value =
    let digits = "0123456789abcdef" in
    let output = Bytes.create (String.length value * 2) in
    String.iteri
      (fun index character ->
        let code = Char.code character in
        Bytes.set output (index * 2) digits.[code lsr 4];
        Bytes.set output ((index * 2) + 1) digits.[code land 15])
      value;
    Bytes.unsafe_to_string output

  let event_channel =
    lazy
      (match Sys.getenv_opt "DOCLANG_EVENT_PATH" with
      | Some path ->
          open_out_gen [ Open_wronly; Open_creat; Open_append; Open_binary ] 0o600
            path
      | None -> stderr)

  let emit kind ~id content =
    let channel = Lazy.force event_channel in
    Printf.fprintf channel "%s\t%s\t%s\n%!" kind (hex id) (hex content)

  let html ~id content = emit "html" ~id content
  let text ~id content = emit "text" ~id content
  let value ~id ~type_ content =
    emit "value" ~id (type_ ^ "\x1f" ^ content)
  let status ~id content = emit "status" ~id content
  let link ~id ~label url = emit "link" ~id (label ^ "\x1f" ^ url)
  let trace ~id content = emit "trace" ~id content
end
|}

let merlin () =
  match Sys.getenv_opt "OCAMLMERLIN" with
  | Some path -> path
  | None -> "ocamlmerlin"

let source_line source line =
  if line < 1 then None
  else List.nth_opt (String.split_on_char '\n' source) (line - 1)

let utf8_character string index =
  let length = String.length string in
  let byte offset = Char.code string.[index + offset] in
  let continuation offset =
    index + offset < length && byte offset land 0xc0 = 0x80
  in
  let first = byte 0 in
  if first land 0x80 = 0 then (1, first)
  else if first land 0xe0 = 0xc0 && continuation 1 then
    (2, ((first land 0x1f) lsl 6) lor (byte 1 land 0x3f))
  else if first land 0xf0 = 0xe0 && continuation 1 && continuation 2 then
    ( 3,
      ((first land 0x0f) lsl 12)
      lor ((byte 1 land 0x3f) lsl 6)
      lor (byte 2 land 0x3f) )
  else if
    first land 0xf8 = 0xf0 && continuation 1 && continuation 2 && continuation 3
  then
    ( 4,
      ((first land 0x07) lsl 18)
      lor ((byte 1 land 0x3f) lsl 12)
      lor ((byte 2 land 0x3f) lsl 6)
      lor (byte 3 land 0x3f) )
  else (1, first)

let utf8_byte_column_of_utf16 string column =
  let rec loop byte_column utf16_column =
    if byte_column >= String.length string || utf16_column >= column then
      byte_column
    else
      let bytes, codepoint = utf8_character string byte_column in
      let code_units = if codepoint > 0xffff then 2 else 1 in
      if utf16_column + code_units > column then byte_column
      else loop (byte_column + bytes) (utf16_column + code_units)
  in
  loop 0 0

let utf16_column_of_utf8_byte string column =
  let rec loop byte_column utf16_column =
    if byte_column >= String.length string || byte_column >= column then
      utf16_column
    else
      let bytes, codepoint = utf8_character string byte_column in
      if byte_column + bytes > column then utf16_column
      else
        loop (byte_column + bytes)
          (utf16_column + if codepoint > 0xffff then 2 else 1)
  in
  loop 0 0

let source_indentation document line =
  match source_line document.Document.source line with
  | Some source when Util.starts_with ~prefix:"    " source -> 4
  | _ -> 0

let compiler_source_line document line =
  match source_line document.Document.source line with
  | Some source when Util.starts_with ~prefix:"    " source ->
      String.sub source 4 (String.length source - 4)
  | Some source -> source
  | None -> ""

let source_column_of_merlin document line column =
  let source = compiler_source_line document line in
  source_indentation document line + utf16_column_of_utf8_byte source column

let absolute_source_utf16_offset document line column =
  let lines = String.split_on_char '\n' document.Document.source in
  let editor_line_length source =
    let length = String.length source in
    let length =
      if length > 0 && source.[length - 1] = '\r' then length - 1 else length
    in
    utf16_column_of_utf8_byte source length
  in
  let rec preceding total index = function
    | [] -> None
    | source :: rest ->
        if index = line then Some (total + column)
        else
          preceding
            (total + editor_line_length source + 1)
            (index + 1) rest
  in
  preceding 0 1 lines

let absolute_utf16_offset document line column =
  absolute_source_utf16_offset document line
    (source_indentation document line
    + utf16_column_of_utf8_byte (compiler_source_line document line) column)

let source_map_entries documents inline_markers manifests =
  let document_for_path path =
    List.find_opt
      (fun document -> String.equal document.Document.path path)
      documents
  in
  manifests
  |> List.concat_map (fun manifest ->
      manifest.manifest_selectors
      |> List.filter_map (fun selector ->
          match document_for_path selector.selector_generated_path with
          | Some document -> (
              match
                ( absolute_utf16_offset document selector.selector_start_line
                    selector.selector_start_column,
                  absolute_utf16_offset document selector.selector_end_line
                    selector.selector_end_column )
              with
              | Some start_utf16, Some end_utf16 ->
                  Some
                    {
                      map_selector_id = selector.selector_id;
                      map_generated_path = manifest.manifest_generated_path;
                      map_start_byte = selector.selector_start_byte;
                      map_end_byte = selector.selector_end_byte;
                      map_document_path = document.path;
                      map_start_utf16 = start_utf16;
                      map_end_utf16 = end_utf16;
                    }
              | None, _ | _, None -> None)
          | None -> (
              match
                List.find_opt
                  (fun marker ->
                    String.equal marker.virtual_path
                      selector.selector_generated_path)
                  inline_markers
              with
              | None -> None
              | Some marker -> (
                  match document_for_path marker.document_path with
                  | None -> None
                  | Some marker_document ->
                  let expression = marker.inline_expression in
                  let prefix_length = String.length "let () = try ignore (@(" in
                  let expression_end =
                    prefix_length + String.length expression.expression
                  in
                  if
                    selector.selector_start_line <> 1
                    || selector.selector_end_line <> 1
                    || selector.selector_start_column < prefix_length
                    || selector.selector_end_column > expression_end
                  then None
                  else
                    let column column =
                      expression.column_start
                      + utf16_column_of_utf8_byte expression.expression
                          (column - prefix_length)
                    in
                    match
                      ( absolute_source_utf16_offset marker_document
                          expression.line
                          (column selector.selector_start_column),
                        absolute_source_utf16_offset marker_document
                          expression.line
                          (column selector.selector_end_column) )
                    with
                    | Some start_utf16, Some end_utf16 ->
                        Some
                          {
                            map_selector_id = selector.selector_id;
                            map_generated_path = manifest.manifest_generated_path;
                            map_start_byte = selector.selector_start_byte;
                            map_end_byte = selector.selector_end_byte;
                            map_document_path = marker.document_path;
                            map_start_utf16 = start_utf16;
                            map_end_utf16 = end_utf16;
                          }
                    | None, _ | _, None -> None))))
  |> List.sort (fun left right ->
      let by_path =
        String.compare left.map_generated_path right.map_generated_path
      in
      if by_path <> 0 then by_path
      else
        let by_start = compare left.map_start_byte right.map_start_byte in
        if by_start <> 0 then by_start
        else
          let by_end = compare left.map_end_byte right.map_end_byte in
          if by_end <> 0 then by_end
          else
            let by_document =
              String.compare left.map_document_path right.map_document_path
            in
            if by_document <> 0 then by_document
            else String.compare left.map_selector_id right.map_selector_id)

let normalize_trace_event documents (event : trace_event) =
  match
    List.find_opt
      (fun document -> String.equal document.Document.path event.path)
      documents
  with
  | None -> event
  | Some document ->
      {
        event with
        source_column =
          source_column_of_merlin document event.source_line event.source_column;
        source_end_column =
          source_column_of_merlin document event.source_end_line
            event.source_end_column;
      }

let source_slice_utf16 source start_column end_column =
  let start_byte = utf8_byte_column_of_utf16 source start_column in
  let end_byte = utf8_byte_column_of_utf16 source end_column in
  String.sub source start_byte (max 0 (end_byte - start_byte))

let merlin_target_source document =
  let lines =
    String.split_on_char '\n' document.Document.source |> Array.of_list
  in
  let output = Array.make (Array.length lines) "" in
  document.Document.blocks
  |> List.iter (function
    | Document.Code { source; source_line; kind = Document.Program; _ } ->
        let source =
          match
            Observation.erase ~path:document.path ~start_line:source_line source
          with
          | Ok (source, _) -> source
          | Error _ -> source
        in
        String.split_on_char '\n' source
        |> List.iteri (fun offset line ->
            let index = source_line - 1 + offset in
            if index >= 0 && index < Array.length output then
              output.(index) <- line)
    | _ -> ());
  output |> Array.to_list |> String.concat "\n"

let compiler_token_classification = function
  | Parser.IF -> Some "if", false
  | Parser.THEN -> Some "then", false
  | Parser.ELSE -> Some "else", false
  | Parser.LET -> Some "let", false
  | Parser.REC -> Some "rec", false
  | Parser.FUN | Parser.FUNCTION -> Some "function", false
  | Parser.MATCH -> Some "match", false
  | Parser.WITH -> Some "with", false
  | Parser.TRY -> Some "try", false
  | Parser.WHILE -> Some "while", false
  | Parser.FOR -> Some "for", false
  | Parser.DO -> Some "do", false
  | Parser.DONE -> Some "done", false
  | Parser.IN -> Some "in", false
  | Parser.WHEN -> Some "when", false
  | Parser.OF -> Some "of", false
  | Parser.AS -> Some "as", false
  | Parser.MINUSGREATER -> Some "arrow", false
  | Parser.BAR -> Some "alternative", false
  | Parser.BEGIN | Parser.END -> Some "block-delimiter", false
  | Parser.PLUS | Parser.PLUSDOT | Parser.MINUS | Parser.MINUSDOT
  | Parser.STAR | Parser.EQUAL | Parser.LESS | Parser.GREATER
  | Parser.BARBAR | Parser.AMPERAMPER | Parser.AMPERSAND | Parser.OR
  | Parser.COLONCOLON | Parser.COLONEQUAL | Parser.LESSMINUS
  | Parser.PLUSEQ | Parser.PERCENT | Parser.BANG
  | Parser.INFIXOP0 _ | Parser.INFIXOP1 _ | Parser.INFIXOP2 _
  | Parser.INFIXOP3 _ | Parser.INFIXOP4 _ | Parser.PREFIXOP _ ->
      None, true
  | _ -> None, false

let compiler_tokens document =
  let source = merlin_target_source document in
  let lexbuf = Lexing.from_string source in
  Location.init lexbuf document.Document.path;
  Lexer.init ();
  let rec collect accumulator =
    try
      let token = Lexer.token lexbuf in
      let start = Lexing.lexeme_start_p lexbuf in
      let end_ = Lexing.lexeme_end_p lexbuf in
      let start_line = start.Lexing.pos_lnum in
      let end_line = end_.Lexing.pos_lnum in
      let start_column = start.Lexing.pos_cnum - start.Lexing.pos_bol in
      let end_column = end_.Lexing.pos_cnum - end_.Lexing.pos_bol in
      let role, operator = compiler_token_classification token in
      let entry =
        {
          token_range =
            {
              range_start_line = start_line;
              range_start_column =
                source_column_of_merlin document start_line start_column;
              range_end_line = end_line;
              range_end_column =
                source_column_of_merlin document end_line end_column;
            };
          token_role = role;
          token_operator = operator;
        }
      in
      match token with
      | Parser.EOF -> List.rev accumulator
      | _ -> collect (entry :: accumulator)
    with Lexer.Error _ -> List.rev accumulator
  in
  collect []

let expression_at document ~start_line ~start_column ~end_line ~end_column =
  let lines = String.split_on_char '\n' (merlin_target_source document) in
  let line number =
    Option.value ~default:"" (List.nth_opt lines (number - 1))
  in
  if start_line = end_line then
    let source = line start_line in
    String.sub source start_column (max 0 (end_column - start_column))
    |> String.trim
  else
    let first = line start_line in
    let first =
      String.sub first start_column (String.length first - start_column)
    in
    let rec middle number accumulator =
      if number >= end_line then List.rev accumulator
      else middle (number + 1) (line number :: accumulator)
    in
    let last = String.sub (line end_line) 0 end_column in
    String.concat "\n" ((first :: middle (start_line + 1) []) @ [ last ])
    |> String.trim

let position_member name json =
  let open Yojson.Safe.Util in
  let position = member name json in
  (position |> member "line" |> to_int, position |> member "col" |> to_int)

let type_infos_of_json ~line_offset target json =
  let open Yojson.Safe.Util in
  match json |> member "class" |> to_string_option with
  | Some "return" -> (
      match json |> member "value" |> to_list with
      | values ->
          Ok
            (List.map
               (fun value ->
                 let physical_start_line, start_column =
                   position_member "start" value
                 in
                 let physical_end_line, end_column =
                   position_member "end" value
                 in
                 let start_line = physical_start_line - line_offset in
                 let end_line = physical_end_line - line_offset in
                 let expression =
                   expression_at target ~start_line ~start_column ~end_line
                     ~end_column
                 in
                 let start_column =
                   source_column_of_merlin target start_line start_column
                 in
                 let end_column =
                   source_column_of_merlin target end_line end_column
                 in
                 let type_ = value |> member "type" |> to_string in
                 {
                   expression;
                   type_;
                   start_line;
                   start_column;
                   end_line;
                   end_column;
                 })
               values))
  | Some class_ ->
      Error
        (Printf.sprintf "Merlin returned %s: %s" class_
           (json |> member "value" |> Yojson.Safe.to_string))
  | None -> Error "Merlin returned an invalid response."

let type_info_of_json ~line_offset target json =
  Result.map
    (function [] -> None | info :: _ -> Some info)
    (type_infos_of_json ~line_offset target json)

let newline_count source =
  String.fold_left
    (fun count character ->
      if Char.equal character '\n' then count + 1 else count)
    0 source

let rec namespace_alias_source entries =
  let groups =
    entries
    |> List.filter_map (fun (components, module_path) ->
        match components with
        | [] -> None
        | component :: rest -> Some (component, rest, module_path))
    |> List.fold_left
         (fun groups (component, rest, module_path) ->
           let current =
             Option.value ~default:[] (List.assoc_opt component groups)
           in
           (component, (rest, module_path) :: current)
           :: List.remove_assoc component groups)
         []
    |> List.sort (fun (left, _) (right, _) -> String.compare left right)
  in
  groups
  |> List.map (fun (component, children) ->
      let direct, nested =
        List.partition (fun (rest, _) -> rest = []) children
      in
      match (direct, nested) with
      | [ ([], module_path) ], [] ->
          Printf.sprintf "module %s = %s" component
            (Module_path.compiler_unit module_path)
      | _ ->
          let included =
            match direct with
            | [ ([], module_path) ] ->
                "include " ^ Module_path.compiler_unit module_path ^ "\n"
            | _ -> ""
          in
          Printf.sprintf "module %s = struct\n%s%s\nend" component included
            (namespace_alias_source nested))
  |> String.concat "\n"

type merlin_document_segment = {
  document : Document.t;
  source : string;
  content_line_offset : int;
}

let merlin_wrapped_document module_paths document =
  let module_path =
    Result.to_option (Module_path.of_source_path document.Document.path)
  in
  let aliases =
    module_paths
    |> List.filter (fun candidate ->
        not (Option.equal String.equal module_path (Some candidate)))
    |> List.map (fun candidate -> (Module_path.split candidate, candidate))
    |> namespace_alias_source
  in
  let content = merlin_target_source document in
  match module_path with
  | Some module_path ->
      let prefix =
        Printf.sprintf "module %s = struct\n\n%s\n"
          (Module_path.compiler_unit module_path)
          aliases
      in
      {
        document;
        source = prefix ^ content ^ "\nend\n";
        content_line_offset = newline_count prefix;
      }
  | None -> { document; source = content; content_line_offset = 0 }

let merlin_source ~documents ~target =
  let module_paths =
    documents
    |> List.filter_map (fun (document : Document.t) ->
        Result.to_option (Module_path.of_source_path document.path))
  in
  let imported_documents =
    documents
    |> List.filter (fun document ->
        not (String.equal document.Document.path target.Document.path))
  in
  let imported_segments =
    List.map (merlin_wrapped_document module_paths) imported_documents
  in
  let imported =
    imported_segments
    |> List.map (fun segment -> segment.source)
    |> String.concat "\n"
  in
  let alias_source =
    imported_documents
    |> List.filter_map (fun document ->
        Result.to_option (Module_path.of_source_path document.Document.path))
    |> List.map (fun module_path ->
        (Module_path.split module_path, module_path))
    |> namespace_alias_source
  in
  let local_namespaces =
    match Module_path.of_source_path target.Document.path with
    | Error _ -> ""
    | Ok module_path ->
        Module_path.namespace_prefixes module_path
        |> List.map (fun namespace -> "open " ^ namespace)
        |> String.concat "\n"
        |> fun source -> if String.equal source "" then "" else source ^ "\n"
  in
  let prefix =
    prelude ^ "\n" ^ imported ^ "\n" ^ alias_source ^ "\n" ^ local_namespaces
  in
  (prefix ^ merlin_target_source target, newline_count prefix)

let merlin_source_with_segments ~documents ~target =
  let source, target_line_offset = merlin_source ~documents ~target in
  let module_paths =
    documents
    |> List.filter_map (fun (document : Document.t) ->
        Result.to_option (Module_path.of_source_path document.path))
  in
  let imported_segments =
    documents
    |> List.filter (fun document ->
        not (String.equal document.Document.path target.Document.path))
    |> List.map (merlin_wrapped_document module_paths)
  in
  let first_imported_line = 1 + newline_count (prelude ^ "\n") in
  let rec locate_segments line accumulator = function
    | [] -> List.rev accumulator
    | segment :: rest ->
        let content_start = line + segment.content_line_offset in
        let content_lines =
          1 + newline_count (merlin_target_source segment.document)
        in
        let located =
          (content_start, content_start + content_lines - 1, segment.document)
        in
        locate_segments
          (line + newline_count segment.source + 1)
          (located :: accumulator) rest
  in
  let imported = locate_segments first_imported_line [] imported_segments in
  let target_start = target_line_offset + 1 in
  let target_lines = 1 + newline_count (merlin_target_source target) in
  ( source,
    target_line_offset,
    imported @ [ (target_start, target_start + target_lines - 1, target) ] )

let type_at_with_cancel ~cancelled ~documents ~target ~line ~column =
  let source, line_offset = merlin_source ~documents ~target in
  let column =
    max 0 (column - source_indentation target line)
    |> utf8_byte_column_of_utf16 (compiler_source_line target line)
  in
  let result =
    run_process ~stdin:source ~timeout_seconds:3. ~output_limit:262_144
      ~cancelled (merlin ())
      [
        "single";
        "type-enclosing";
        "-position";
        Printf.sprintf "%d:%d" (line + line_offset) column;
        "-filename";
        target.Document.path;
      ]
  in
  if not (successful result.status) then
    Error
      (if String.equal (String.trim result.stderr) "" then
         "Could not query the OCaml compiler service."
       else String.trim result.stderr)
  else
    try
      Yojson.Safe.from_string result.stdout
      |> type_info_of_json ~line_offset target
    with
    | Yojson.Json_error message -> Error ("Invalid Merlin response: " ^ message)
    | Yojson.Safe.Util.Type_error (message, _) ->
        Error ("Invalid Merlin response: " ^ message)

let type_at ~documents ~target ~line ~column =
  type_at_with_cancel
    ~cancelled:(fun () -> false)
    ~documents ~target ~line ~column

let execution_site_range site =
  {
    range_start_line = site.site_start_line;
    range_start_column = site.site_start_column;
    range_end_line = site.site_end_line;
    range_end_column = site.site_end_column;
  }

let execution_range_contains outer inner =
  (outer.range_start_line < inner.range_start_line
  || (outer.range_start_line = inner.range_start_line
     && outer.range_start_column <= inner.range_start_column))
  &&
  (outer.range_end_line > inner.range_end_line
  || (outer.range_end_line = inner.range_end_line
     && outer.range_end_column >= inner.range_end_column))

let execution_position_compare left_line left_column right_line right_column =
  match Int.compare left_line right_line with
  | 0 -> Int.compare left_column right_column
  | comparison -> comparison

let token_between token left right =
  execution_position_compare token.token_range.range_start_line
    token.token_range.range_start_column left.range_end_line
    left.range_end_column
  >= 0
  && execution_position_compare token.token_range.range_end_line
       token.token_range.range_end_column right.range_start_line
       right.range_start_column
     <= 0

let enrich_execution_sites sites tokens =
  let range_key range =
    Printf.sprintf "%d:%d:%d:%d" range.range_start_line
      range.range_start_column range.range_end_line range.range_end_column
  in
  let sites_by_id = Hashtbl.create (List.length sites) in
  let children_by_parent = Hashtbl.create (List.length sites) in
  let operator_ranges = Hashtbl.create (List.length tokens) in
  let patterns_by_target = Hashtbl.create (List.length sites) in
  List.iter (fun site -> Hashtbl.replace sites_by_id site.site_id site) sites;
  List.iter
    (fun site ->
      Option.iter
        (fun parent_id ->
          Hashtbl.replace children_by_parent parent_id
            (site
            :: Option.value ~default:[]
                 (Hashtbl.find_opt children_by_parent parent_id)))
        site.site_parent_id;
      if String.equal site.site_kind "pattern" then
        Option.iter
          (fun target ->
            let key = range_key target in
            Hashtbl.replace patterns_by_target key
              (site
              :: Option.value ~default:[]
                   (Hashtbl.find_opt patterns_by_target key)))
          site.site_target)
    sites;
  List.iter
    (fun token ->
      if token.token_operator then
        Hashtbl.replace operator_ranges (range_key token.token_range) ())
    tokens;
  let parent site =
    Option.bind site.site_parent_id (Hashtbl.find_opt sites_by_id)
  in
  let is_expression site = String.equal site.site_kind "expression" in
  let is_pattern site = String.equal site.site_kind "pattern" in
  let is_operator_site site =
    Hashtbl.mem operator_ranges (range_key (execution_site_range site))
  in
  let parent_is_operator_application parent_site =
    let children =
      Option.value ~default:[]
        (Hashtbl.find_opt children_by_parent parent_site.site_id)
    in
    List.exists
      (fun child ->
        is_expression child && is_operator_site child)
      children
  in
  let enclosing_definition parent_site =
    let parent_range = execution_site_range parent_site in
    let range_size range =
      ((range.range_end_line - range.range_start_line) * 1_000_000)
      + max 0 (range.range_end_column - range.range_start_column)
    in
    sites
    |> List.filter (fun candidate ->
           is_pattern candidate
           && Option.fold ~none:false
                ~some:(fun selection ->
                  execution_range_contains selection parent_range)
                candidate.site_selection)
    |> List.sort (fun left right ->
           let left_size =
             Option.fold ~none:max_int ~some:range_size
               left.site_selection
           in
           let right_size =
             Option.fold ~none:max_int ~some:range_size
               right.site_selection
           in
           Int.compare left_size right_size)
    |> function
    | definition :: _ -> Some definition
    | [] -> None
  in
  let direct_patterns = Hashtbl.create (List.length sites) in
  let alternatives =
    tokens
    |> List.filter (fun token -> token.token_role = Some "alternative")
    |> List.sort (fun left right ->
           execution_position_compare left.token_range.range_start_line
             left.token_range.range_start_column
             right.token_range.range_start_line
             right.token_range.range_start_column)
    |> Array.of_list
  in
  let alternative_between left right =
    let rec lower_bound low high =
      if low >= high then low
      else
        let middle = (low + high) / 2 in
        let token = alternatives.(middle) in
        if
          execution_position_compare token.token_range.range_start_line
            token.token_range.range_start_column left.range_end_line
            left.range_end_column
          < 0
        then lower_bound (middle + 1) high
        else lower_bound low middle
    in
    let index = lower_bound 0 (Array.length alternatives) in
    index < Array.length alternatives
    && token_between alternatives.(index) left right
  in
  Hashtbl.iter
    (fun target_key candidates ->
      let leaves =
        candidates
        |> List.filter (fun candidate ->
               Option.value ~default:[]
               (Hashtbl.find_opt children_by_parent candidate.site_id)
               |> List.exists (fun child ->
                      is_pattern child
                      && match child.site_target with
                         | Some target ->
                             String.equal (range_key target) target_key
                         | None -> false)
               |> not)
        |> List.sort (fun left right ->
               execution_position_compare left.site_start_line
                 left.site_start_column right.site_start_line
                 right.site_start_column)
      in
      let rec mark_adjacent = function
        | left :: (right :: _ as rest) ->
            if
              alternative_between (execution_site_range left)
                (execution_site_range right)
            then (
              Hashtbl.replace direct_patterns left.site_id true;
              Hashtbl.replace direct_patterns right.site_id true);
            mark_adjacent rest
        | _ -> ()
      in
      mark_adjacent leaves)
    patterns_by_target;
  let is_direct_pattern site = Hashtbl.mem direct_patterns site.site_id in
  let enriched =
    List.map
      (fun site ->
        let direct = is_pattern site && is_direct_pattern site in
        match parent site with
        | Some parent_site
          when is_expression site && is_expression parent_site ->
            let range = execution_site_range site in
            let parent_range = execution_site_range parent_site in
            if is_operator_site site then
              {
                site with
                site_target = Some parent_range;
                site_role = Some "operator";
                site_direct = direct;
              }
            else if
              range.range_start_line = parent_range.range_start_line
              && range.range_start_column = parent_range.range_start_column
              && not (parent_is_operator_application parent_site)
            then
              {
                site with
                site_target = Some parent_range;
                site_role = Some "callee";
                site_direct = direct;
              }
            else { site with site_direct = direct }
        | Some parent_site
          when is_pattern site && is_expression parent_site
               && site.site_target = None
               && Option.is_none site.site_selection -> (
            match
              if parent_site.site_ghost then
                Option.map execution_site_range
                  (enclosing_definition parent_site)
              else Some (execution_site_range parent_site)
            with
            | Some target ->
                {
                  site with
                  site_target = Some target;
                  site_role = Some "lambda-parameter";
                  site_direct = direct;
                }
            | None -> { site with site_direct = direct })
        | Some _ | None -> { site with site_direct = direct })
      sites
  in
  let enriched_by_id = Hashtbl.create (List.length enriched) in
  List.iter
    (fun site -> Hashtbl.replace enriched_by_id site.site_id site)
    enriched;
  let inherited_targets = Hashtbl.create (List.length enriched) in
  let resolving_targets = Hashtbl.create 16 in
  let rec inherited_pattern_target site =
    match Hashtbl.find_opt inherited_targets site.site_id with
    | Some target -> target
    | None when Hashtbl.mem resolving_targets site.site_id -> None
    | None ->
        Hashtbl.replace resolving_targets site.site_id ();
        let target =
          match site.site_target with
          | Some target -> Some (target, site.site_role)
          | None -> (
              match site.site_parent_id with
              | Some parent_id -> (
                  match Hashtbl.find_opt enriched_by_id parent_id with
                  | Some parent_site when is_pattern parent_site ->
                      inherited_pattern_target parent_site
                  | Some _ | None -> None)
              | None -> None)
        in
        Hashtbl.remove resolving_targets site.site_id;
        Hashtbl.replace inherited_targets site.site_id target;
        target
  in
  List.map
    (fun site ->
      if not (is_pattern site) || Option.is_some site.site_target then site
      else
        match inherited_pattern_target site with
        | Some (target, role) ->
            { site with site_target = Some target; site_role = role }
        | None -> site)
    enriched

let execution_range_size range =
  ((range.range_end_line - range.range_start_line) * 1_000_000)
  + max 0 (range.range_end_column - range.range_start_column)

let syntax_execution_sites sites tokens =
  let all_expressions =
    List.filter (fun site -> site.site_kind = "expression") sites
  in
  let expressions = List.filter (fun site -> not site.site_ghost) all_expressions in
  let containing_expression token =
    let containing candidates =
      candidates
      |> List.fold_left
           (fun best site ->
             if
               not
                 (execution_range_contains (execution_site_range site)
                    token.token_range)
             then best
             else
               match best with
               | None -> Some site
               | Some current ->
                   if
                     execution_range_size (execution_site_range site)
                     < execution_range_size (execution_site_range current)
                   then Some site
                   else best)
           None
    in
    let candidates = containing expressions in
    match candidates with
    | Some _ -> candidates
    | None -> containing all_expressions
  in
  let definition_target range =
    sites
    |> List.filter (fun site ->
           site.site_kind = "pattern"
           && site.site_end_line = range.range_start_line
           && Option.fold ~none:false
                ~some:(fun selection ->
                  execution_range_contains selection range
                  && not
                       (List.exists
                          (fun wrapper ->
                            wrapper.site_kind = "expression"
                            && execution_range_size
                                 (execution_site_range wrapper)
                               > execution_range_size range
                            && execution_range_contains selection
                                 (execution_site_range wrapper)
                            && execution_range_contains
                                 (execution_site_range wrapper)
                                 range)
                          sites))
                site.site_selection)
    |> List.sort (fun left right ->
           Int.compare
             (execution_range_size
                (Option.get left.site_selection))
             (execution_range_size
                (Option.get right.site_selection)))
    |> function
    | definition :: _ -> Some (execution_site_range definition)
    | [] -> None
  in
  let function_starts_at range =
    List.exists
      (fun token ->
        token.token_role = Some "function"
        && token.token_range.range_start_line = range.range_start_line
        && token.token_range.range_start_column = range.range_start_column)
      tokens
  in
  let containing_pattern token =
    sites
    |> List.filter (fun site ->
           site.site_kind = "pattern"
           && execution_range_contains (execution_site_range site)
                token.token_range)
    |> List.sort (fun left right ->
           Int.compare
             (execution_range_size (execution_site_range left))
             (execution_range_size (execution_site_range right)))
    |> function
    | pattern :: _ -> Some (execution_site_range pattern)
    | [] -> None
  in
  let starts_after token site =
    execution_position_compare site.site_start_line site.site_start_column
      token.token_range.range_end_line token.token_range.range_end_column
    >= 0
  in
  let next_expression token container =
    expressions
    |> List.fold_left
         (fun best site ->
           if
             not
               (starts_after token site
               && execution_range_contains (execution_site_range container)
                    (execution_site_range site))
           then best
           else
             match best with
             | None -> Some site
             | Some current ->
                 let position =
                   execution_position_compare site.site_start_line
                     site.site_start_column current.site_start_line
                     current.site_start_column
                 in
                 if
                   position < 0
                   || (position = 0
                      && execution_range_size (execution_site_range site)
                         > execution_range_size
                             (execution_site_range current))
                 then Some site
                 else best)
         None
  in
  let next_expression_any token =
    expressions
    |> List.fold_left
         (fun best site ->
           if not (starts_after token site) then best
           else
             match best with
             | None -> Some site
             | Some current ->
                 let position =
                   execution_position_compare site.site_start_line
                     site.site_start_column current.site_start_line
                     current.site_start_column
                 in
                 if
                   position < 0
                   || (position = 0
                      && execution_range_size (execution_site_range site)
                         > execution_range_size
                             (execution_site_range current))
                 then Some site
                 else best)
         None
  in
  let next_pattern_target token container =
    sites
    |> List.fold_left
         (fun best site ->
           if
             not
               (site.site_kind = "pattern" && starts_after token site
               && Option.fold ~none:true
                    ~some:(fun container ->
                      execution_range_contains
                        (execution_site_range container)
                        (execution_site_range site))
                    container
               && Option.is_some site.site_target)
           then best
           else
             match best with
             | None -> Some site
             | Some current ->
                 if
                   execution_position_compare site.site_start_line
                     site.site_start_column current.site_start_line
                     current.site_start_column
                   < 0
                 then Some site
                 else best)
         None
    |> fun site -> Option.bind site (fun site -> site.site_target)
  in
  let preceding_pattern_target token container =
    sites
    |> List.fold_left
         (fun best site ->
           if
             not
               (site.site_kind = "pattern"
               && execution_position_compare site.site_end_line
                    site.site_end_column token.token_range.range_start_line
                    token.token_range.range_start_column
                  <= 0
               && Option.fold ~none:true
                    ~some:(fun container ->
                      execution_range_contains
                        (execution_site_range container)
                        (execution_site_range site))
                    container
               && Option.is_some site.site_target)
           then best
           else
             match best with
             | None -> Some site
             | Some current ->
                 if
                   execution_position_compare site.site_end_line
                     site.site_end_column current.site_end_line
                     current.site_end_column
                   > 0
                 then Some site
                 else best)
         None
    |> fun site -> Option.bind site (fun site -> site.site_target)
  in
  let gap_selection token role target =
    if
      List.mem role
        [ "then"; "else"; "in"; "when"; "do"; "arrow" ]
      && execution_position_compare token.token_range.range_end_line
           token.token_range.range_end_column target.range_start_line
           target.range_start_column
         <= 0
    then
      Some
        {
          range_start_line = token.token_range.range_start_line;
          range_start_column = token.token_range.range_start_column;
          range_end_line = target.range_start_line;
          range_end_column = target.range_start_column;
        }
    else None
  in
  let target_for token role =
    let container = containing_expression token in
    let target =
      match role with
      | "as" -> containing_pattern token
      | "arrow" -> preceding_pattern_target token container
      | "alternative" ->
          Option.bind container (fun container ->
              next_pattern_target token (Some container))
      | "then" | "else" | "in" | "when" | "do" ->
          Option.bind container (fun container ->
              Option.map execution_site_range
                (next_expression token container))
      | _ -> (
          match container with
          | None ->
              if role = "let" || role = "rec" then
                Option.map execution_site_range (next_expression_any token)
              else None
          | Some container ->
              Some (execution_site_range container))
    in
    Option.map
      (fun target ->
        if
          role = "function"
          || ((role = "let" || role = "rec") && function_starts_at target)
        then Option.value ~default:target (definition_target target)
        else target)
      target
  in
  tokens
  |> List.filter_map (fun token ->
         Option.bind token.token_role (fun role ->
             let target = target_for token role in
             if
               Option.is_none target
               && (String.equal role "arrow"
                  || String.equal role "alternative")
             then None
             else
               let range = token.token_range in
               Some
                 {
                   site_id =
                     Printf.sprintf "syntax:%s:%d:%d:%d:%d" role
                       range.range_start_line range.range_start_column
                       range.range_end_line range.range_end_column;
                   site_parent_id = None;
                   site_kind = "syntax";
                   site_ghost = false;
                   site_start_line = range.range_start_line;
                   site_start_column = range.range_start_column;
                   site_end_line = range.range_end_line;
                   site_end_column = range.range_end_column;
                   site_target = target;
                   site_selection =
                     Option.bind target (gap_selection token role);
                   site_role = Some role;
                   site_direct = false;
                 }))

let execution_sites_with_cancel ~cancelled ~documents ~target =
  let source, line_offset = merlin_source ~documents ~target in
  let result =
    run_process ~stdin:source ~timeout_seconds:3. ~output_limit:8_000_000
      ~cancelled (merlin ())
      [ "single"; "dump"; "-what"; "browse"; "-filename"; target.Document.path ]
  in
  if not (successful result.status) then
    Error
      (if String.equal (String.trim result.stderr) "" then
         "Could not query the OCaml compiler service."
       else String.trim result.stderr)
  else
    try
      let open Yojson.Safe.Util in
      let json = Yojson.Safe.from_string result.stdout in
      match json |> member "class" |> to_string_option with
      | Some "return" ->
          let target_line_count = 1 + newline_count target.Document.source in
          let range node =
            let physical_start_line, start_column = position_member "start" node in
            let physical_end_line, end_column = position_member "end" node in
            let start_line = physical_start_line - line_offset in
            let end_line = physical_end_line - line_offset in
            if
              start_line >= 1 && end_line >= start_line
              && end_line <= target_line_count
            then
              Some
                {
                  range_start_line = start_line;
                  range_start_column =
                    source_column_of_merlin target start_line start_column;
                  range_end_line = end_line;
                  range_end_column =
                    source_column_of_merlin target end_line end_column;
                }
            else None
          in
          let node_kind node =
            node |> member "kind" |> to_string_option
            |> Option.value ~default:""
          in
          let site_id kind range =
            Printf.sprintf "%s:%d:%d:%d:%d" kind range.range_start_line
              range.range_start_column range.range_end_line
              range.range_end_column
          in
          let rec collect pattern_target selection parent_id accumulator node =
            let kind = node |> member "kind" |> to_string_option in
            let site =
              match (kind, range node) with
              | Some kind, Some site_range
                when Util.starts_with ~prefix:"expression" kind
                     || Util.starts_with ~prefix:"pattern" kind ->
                  let is_pattern = Util.starts_with ~prefix:"pattern" kind in
                  let site_kind =
                    if is_pattern then "pattern" else "expression"
                  in
                  Some
                    {
                      site_id = site_id site_kind site_range;
                      site_parent_id = parent_id;
                      site_kind;
                      site_ghost =
                        (node |> member "ghost" |> to_bool_option
                        |> Option.value ~default:false);
                      site_start_line = site_range.range_start_line;
                      site_start_column = site_range.range_start_column;
                      site_end_line = site_range.range_end_line;
                      site_end_column = site_range.range_end_column;
                      site_target =
                        (if is_pattern then pattern_target else None);
                      site_selection =
                        (if is_pattern then selection else None);
                      site_role = None;
                      site_direct = false;
                    }
              | _ -> None
            in
            let accumulator =
              Option.fold ~none:accumulator
                ~some:(fun site -> site :: accumulator)
                site
            in
            let child_parent_id =
              Option.fold ~none:parent_id
                ~some:(fun site -> Some site.site_id)
                site
            in
            let children = node |> member "children" |> to_list in
            if String.equal (node_kind node) "case" then
              let target =
                children
                |> List.filter_map (fun child ->
                    if Util.starts_with ~prefix:"expression" (node_kind child)
                    then range child
                    else None)
                |> List.rev
                |> function
                | [] -> None
                | target :: _ -> Some target
              in
              let selection = range node in
              children
              |> List.fold_left
                   (fun accumulator child ->
                     let child_target =
                       if Util.starts_with ~prefix:"pattern" (node_kind child)
                       then target
                       else None
                     in
                     let child_selection =
                       if Util.starts_with ~prefix:"pattern" (node_kind child)
                       then selection
                       else None
                     in
                     collect child_target child_selection child_parent_id
                       accumulator child)
                   accumulator
            else if String.equal (node_kind node) "value_binding" then
              let selection = range node in
              children
              |> List.fold_left
                   (fun accumulator child ->
                     let child_selection =
                       if Util.starts_with ~prefix:"pattern" (node_kind child)
                       then selection
                       else None
                     in
                     collect None child_selection child_parent_id accumulator
                       child)
                   accumulator
            else
              children
              |> List.fold_left
                   (collect
                      (match kind with
                      | Some kind when Util.starts_with ~prefix:"pattern" kind
                        ->
                         pattern_target
                      | Some _ | None -> None)
                      None
                      child_parent_id)
                   accumulator
          in
          let sites =
            json |> member "value" |> to_list
            |> List.fold_left (collect None None None) []
            |> List.rev
          in
          let tokens = compiler_tokens target in
          let sites = enrich_execution_sites sites tokens in
          Ok (sites @ syntax_execution_sites sites tokens)
      | Some class_ ->
          Error
            (Printf.sprintf "Merlin returned %s while indexing execution sites."
               class_)
      | None -> Error "Merlin returned an invalid execution-site index."
    with
    | Yojson.Json_error message -> Error ("Invalid Merlin response: " ^ message)
    | Yojson.Safe.Util.Type_error (message, _) ->
        Error ("Invalid Merlin response: " ^ message)

let execution_site_to_json site =
  `Assoc
    [
      ("id", `String site.site_id);
      ( "parentId",
        Option.fold ~none:`Null ~some:(fun id -> `String id) site.site_parent_id
      );
      ("kind", `String site.site_kind);
      ("ghost", `Bool site.site_ghost);
      ( "role",
        Option.fold ~none:`Null ~some:(fun role -> `String role)
          site.site_role );
      ("direct", `Bool site.site_direct);
      ("startLine", `Int site.site_start_line);
      ("startColumn", `Int site.site_start_column);
      ("endLine", `Int site.site_end_line);
      ("endColumn", `Int site.site_end_column);
      ( "target",
        Option.fold ~none:`Null
          ~some:(fun target ->
            `Assoc
              [
                ("startLine", `Int target.range_start_line);
                ("startColumn", `Int target.range_start_column);
                ("endLine", `Int target.range_end_line);
                ("endColumn", `Int target.range_end_column);
              ])
          site.site_target );
      ( "selection",
        Option.fold ~none:`Null
          ~some:(fun selection ->
            `Assoc
              [
                ("startLine", `Int selection.range_start_line);
                ("startColumn", `Int selection.range_start_column);
                ("endLine", `Int selection.range_end_line);
                ("endColumn", `Int selection.range_end_column);
              ])
          site.site_selection );
    ]

let execution_expression_at_with_cancel ~cancelled ~documents ~target ~line
    ~column =
  let source, line_offset = merlin_source ~documents ~target in
  let merlin_column =
    max 0 (column - source_indentation target line)
    |> utf8_byte_column_of_utf16 (compiler_source_line target line)
  in
  let result =
    run_process ~stdin:source ~timeout_seconds:3. ~output_limit:262_144
      ~cancelled (merlin ())
      [
        "single";
        "type-enclosing";
        "-position";
        Printf.sprintf "%d:%d" (line + line_offset) merlin_column;
        "-filename";
        target.Document.path;
      ]
  in
  if not (successful result.status) then
    Error
      (if String.equal (String.trim result.stderr) "" then
         "Could not query the OCaml compiler service."
       else String.trim result.stderr)
  else
    try
      Result.map
        (fun infos ->
          let same_start left right =
            left.start_line = right.start_line
            && left.start_column = right.start_column
          in
          let is_operator expression =
            let expression = String.trim expression in
            let rec loop index seen =
              if index >= String.length expression then seen
              else
                match expression.[index] with
                | ' ' | '(' | ')' -> loop (index + 1) seen
                | '+' | '-' | '*' | '/' | '=' | '<' | '>' | ':' | '@' | '^'
                | '|' | '&' | '!' | '?' | '~' ->
                    loop (index + 1) true
                | _ -> false
            in
            loop 0 false
          in
          let rec select = function
            | first :: (_ :: _ as rest) when is_operator first.expression ->
                select rest
            | first :: (second :: _ as rest)
              when same_start first second
                   && String.contains first.type_ '-'
                   && String.contains first.type_ '>' ->
                select rest
            | first :: _ -> Some first
            | [] -> None
          in
          select infos)
        (Yojson.Safe.from_string result.stdout
        |> type_infos_of_json ~line_offset target)
    with
    | Yojson.Json_error message -> Error ("Invalid Merlin response: " ^ message)
    | Yojson.Safe.Util.Type_error (message, _) ->
        Error ("Invalid Merlin response: " ^ message)

let strip_common_indentation lines =
  let indentation line =
    let rec loop index =
      if index < String.length line && Char.equal line.[index] ' ' then
        loop (index + 1)
      else index
    in
    loop 0
  in
  let common =
    lines
    |> List.filter (fun line -> not (String.equal (String.trim line) ""))
    |> List.map indentation |> List.fold_left min max_int
  in
  let common = if common = max_int then 0 else common in
  List.map
    (fun line ->
      String.sub line
        (min common (String.length line))
        (max 0 (String.length line - common)))
    lines

let definition_preview document (definition : Document.definition) =
  let block_end =
    document.Document.blocks
    |> List.find_map (function
      | Document.Code { id; position; _ }
        when String.equal id definition.Document.block_id ->
          Some position.line_end
      | _ -> None)
    |> Option.value ~default:definition.line
  in
  let next_definition =
    document.definitions
    |> List.filter_map (fun (candidate : Document.definition) ->
        if
          String.equal candidate.Document.block_id definition.block_id
          && candidate.line > definition.line
        then Some candidate.line
        else None)
    |> List.sort Int.compare
    |> function
    | [] -> None
    | first :: _ -> Some first
  in
  let last_line =
    min block_end (Option.value ~default:(block_end + 1) next_definition - 1)
  in
  let preview_last = min last_line (definition.line + 9) in
  let all_lines = String.split_on_char '\n' document.source |> Array.of_list in
  let lines =
    List.init
      (max 0 (preview_last - definition.line + 1))
      (fun offset ->
        let index = definition.line - 1 + offset in
        if index >= 0 && index < Array.length all_lines then all_lines.(index)
        else "")
    |> strip_common_indentation
  in
  let source = String.concat "\n" lines |> String.trim in
  let source, character_truncated =
    if String.length source > 900 then
      (String.sub source 0 900 |> String.trim, true)
    else (source, false)
  in
  (source, preview_last < last_line || character_truncated)

let definition_info_of_json ~documents ~target json =
  let open Yojson.Safe.Util in
  match json |> member "class" |> to_string_option with
  | Some "return" -> (
      match json |> member "value" with
      | `Assoc _ as value -> (
          match
            ( value |> member "file" |> to_string_option,
              value |> member "pos" |> member "line" |> to_int_option,
              value |> member "pos" |> member "col" |> to_int_option )
          with
          | Some file, Some physical_line, Some column
            when String.equal file target.Document.path -> (
              let _, _, segments =
                merlin_source_with_segments ~documents ~target
              in
              match
                List.find_opt
                  (fun (first, last, _) ->
                    physical_line >= first && physical_line <= last)
                  segments
              with
              | None -> Ok None
              | Some (first, _, document) ->
                  let line = physical_line - first + 1 in
                  let definition =
                    List.find_opt
                      (fun (candidate : Document.definition) ->
                        candidate.Document.line = line)
                      document.Document.definitions
                  in
                  Option.fold ~none:(Ok None)
                    ~some:(fun definition ->
                      match Module_path.of_source_path document.path with
                      | Error _ -> Ok None
                      | Ok module_path ->
                          let source, truncated =
                            definition_preview document definition
                          in
                          Ok
                            (Some
                               {
                                 name = definition.name;
                                 kind = definition.kind;
                                 module_path;
                                 path = document.path;
                                 line;
                                 column =
                                   source_column_of_merlin document line column;
                                 source;
                                 truncated;
                               }))
                    definition)
          | _ -> Ok None)
      | `String _ -> Ok None
      | _ -> Error "Merlin returned an invalid definition location.")
  | Some class_ ->
      Error
        (Printf.sprintf "Merlin returned %s: %s" class_
           (json |> member "value" |> Yojson.Safe.to_string))
  | None -> Error "Merlin returned an invalid response."

let definition_at_with_cancel ~cancelled ~documents ~target ~line ~column =
  let source, line_offset, _ = merlin_source_with_segments ~documents ~target in
  let column =
    max 0 (column - source_indentation target line)
    |> utf8_byte_column_of_utf16 (compiler_source_line target line)
  in
  let result =
    run_process ~stdin:source ~timeout_seconds:3. ~output_limit:262_144
      ~cancelled (merlin ())
      [
        "single";
        "locate";
        "-position";
        Printf.sprintf "%d:%d" (line + line_offset) column;
        "-filename";
        target.Document.path;
      ]
  in
  if not (successful result.status) then
    Error
      (if String.equal (String.trim result.stderr) "" then
         "Could not query the OCaml compiler service."
       else String.trim result.stderr)
  else
    try
      Yojson.Safe.from_string result.stdout
      |> definition_info_of_json ~documents ~target
    with
    | Yojson.Json_error message -> Error ("Invalid Merlin response: " ^ message)
    | Yojson.Safe.Util.Type_error (message, _) ->
        Error ("Invalid Merlin response: " ^ message)

let completion_entry_of_json json =
  let open Yojson.Safe.Util in
  match
    (json |> member "name", json |> member "kind", json |> member "desc")
  with
  | `String name, `String kind, `String desc ->
      let deprecated =
        match json |> member "deprecated" with
        | `Bool value -> value
        | _ -> false
      in
      Some { name; kind; desc; deprecated }
  | _ -> None

let completion_entries_of_json json =
  let open Yojson.Safe.Util in
  match json |> member "class" with
  | `String "return" -> (
      match json |> member "value" |> member "entries" with
      | `List entries -> Ok (List.filter_map completion_entry_of_json entries)
      | _ -> Error "Merlin returned invalid completion entries.")
  | _ ->
      let message =
        match json |> member "value" with
        | `String value -> value
        | value -> Yojson.Safe.to_string value
      in
      Error ("Merlin could not complete this expression: " ^ message)

let complete_at_with_cancel ~cancelled ~documents ~target ~line ~column ~context
    =
  let source, line_offset = merlin_source ~documents ~target in
  let column =
    max 0 (column - source_indentation target line)
    |> utf8_byte_column_of_utf16 (compiler_source_line target line)
  in
  let result =
    run_process ~stdin:source ~timeout_seconds:3. ~output_limit:1_000_000
      ~cancelled (merlin ())
      [
        "single";
        "complete-prefix";
        "-position";
        Printf.sprintf "%d:%d" (line + line_offset) column;
        "-prefix";
        context;
        "-filename";
        target.Document.path;
      ]
  in
  if not (successful result.status) then
    Error
      (if String.equal (String.trim result.stderr) "" then
         "Could not query OCaml completions."
       else String.trim result.stderr)
  else
    try Yojson.Safe.from_string result.stdout |> completion_entries_of_json with
    | Yojson.Json_error message -> Error ("Invalid Merlin response: " ^ message)
    | Yojson.Safe.Util.Type_error (message, _) ->
        Error ("Invalid Merlin response: " ^ message)

let type_info_to_json info =
  `Assoc
    [
      ("expression", `String info.expression);
      ("type", `String info.type_);
      ("startLine", `Int info.start_line);
      ("startColumn", `Int info.start_column);
      ("endLine", `Int info.end_line);
      ("endColumn", `Int info.end_column);
    ]

let definition_info_to_json (info : definition_info) =
  `Assoc
    [
      ("name", `String info.name);
      ("kind", `String info.kind);
      ("module", `String info.module_path);
      ("path", `String info.path);
      ("line", `Int info.line);
      ("column", `Int info.column);
      ("source", `String info.source);
      ("truncated", `Bool info.truncated);
    ]

let completion_entry_to_json (entry : completion_entry) =
  `Assoc
    [
      ("name", `String entry.name);
      ("kind", `String entry.kind);
      ("type", `String entry.desc);
      ("deprecated", `Bool entry.deprecated);
    ]

let artifact_prelude =
  {|
module Doc = struct
  let html ~id:_ _ = ()
  let text ~id:_ _ = ()
  let value ~id:_ ~type_:_ _ = ()
  let status ~id:_ _ = ()
  let link ~id:_ ~label:_ _ = ()
  let trace ~id:_ _ = ()
end
|}

let rec find_local_compiler directory remaining =
  if remaining < 0 then None
  else
    let candidate = Filename.concat directory "_toolchain/oxcaml/bin/ocamlc" in
    if Sys.file_exists candidate then Some candidate
    else
      let parent = Filename.dirname directory in
      if String.equal parent directory then None
      else find_local_compiler parent (remaining - 1)

let compiler () =
  match Sys.getenv_opt "OCAMLC" with
  | Some path -> path
  | None -> (
      let executable =
        if Filename.is_relative Sys.executable_name then
          Filename.concat (Sys.getcwd ()) Sys.executable_name
        else Sys.executable_name
      in
      match find_local_compiler (Filename.dirname executable) 8 with
      | Some local -> local
      | None -> (
          match find_local_compiler (Sys.getcwd ()) 8 with
          | Some local -> local
          | None -> "ocamlc"))

let ocamlrun () =
  match Sys.getenv_opt "OCAMLRUN" with
  | Some path -> path
  | None ->
      let candidate =
        Filename.concat (Filename.dirname (compiler ())) "ocamlrun"
      in
      if Sys.file_exists candidate then candidate else "ocamlrun"

let compiler_identity_value =
  lazy
    (let path = compiler () in
     let executable_digest executable =
       match Util.read_file executable with
       | Ok contents -> Util.sha256 contents
       | Error _ -> "unreadable"
     in
     let version =
       run_process ~timeout_seconds:2. ~output_limit:16_384 path [ "-version" ]
     in
     if successful version.status && not version.output_limited then
       String.concat " "
         [
           path;
           String.trim version.stdout;
           executable_digest path;
           executable_digest (ocamlrun ());
         ]
     else path ^ " (version unavailable) " ^ executable_digest path)

let compiler_identity () = Lazy.force compiler_identity_value

let artifact_builder_identity () =
  Util.sha256
    ("dox-artifact-v2\000" ^ compiler_identity () ^ "\000unix.cma\000"
   ^ artifact_prelude)

let rec remove_temp_directory directory =
  (try
     Sys.readdir directory
     |> Array.iter (fun name ->
         let path = Filename.concat directory name in
         try
           if Sys.is_directory path then remove_temp_directory path
           else Sys.remove path
         with Sys_error _ | Unix.Unix_error _ -> ())
   with Sys_error _ -> ());
  try Unix.rmdir directory with Unix.Unix_error _ -> ()

let strip_prelude_signature signature =
  let lines = String.split_on_char '\n' signature in
  let rec loop skipping accumulator = function
    | [] -> String.concat "\n" (List.rev accumulator)
    | line :: rest
      when (not skipping) && Util.starts_with ~prefix:"module Doc :" line ->
        loop true accumulator rest
    | line :: rest when skipping && String.equal (String.trim line) "end" ->
        loop false accumulator rest
    | _ :: rest when skipping -> loop true accumulator rest
    | line :: rest -> loop false (line :: accumulator) rest
  in
  loop false [] lines |> String.trim

let binding_re =
  Str.regexp "^val[ \t]+\\([A-Za-z_][A-Za-z0-9_']*\\)[ \t]*:[ \t]*\\(.+\\)$"

let bindings signature =
  String.split_on_char '\n' signature
  |> List.filter_map (fun line ->
      if Str.string_match binding_re line 0 then
        Some
          {
            name = Str.matched_group 1 line;
            type_ = Str.matched_group 2 line |> String.trim;
          }
      else None)

let location_re =
  Str.regexp
    "File \"\\([^\"]+\\)\", line \\([0-9]+\\), characters \
     \\([0-9]+\\)-\\([0-9]+\\):"

let diagnostic ~stage ~severity message =
  try
    let _ = Str.search_forward location_re message 0 in
    {
      stage;
      severity;
      message;
      path = Some (Str.matched_group 1 message);
      line = int_of_string_opt (Str.matched_group 2 message);
      column_start = int_of_string_opt (Str.matched_group 3 message);
      column_end = int_of_string_opt (Str.matched_group 4 message);
    }
  with Not_found ->
    {
      stage;
      severity;
      message;
      path = None;
      line = None;
      column_start = None;
      column_end = None;
    }

let process_failure ~stage result =
  if result.timed_out then
    diagnostic ~stage ~severity:"error"
      (Printf.sprintf "%s timed out." (String.capitalize_ascii stage))
  else if result.output_limited then
    diagnostic ~stage ~severity:"error"
      (Printf.sprintf "%s exceeded the output limit."
         (String.capitalize_ascii stage))
  else
    let message =
      if String.equal result.stderr "" then result.stdout else result.stderr
    in
    diagnostic ~stage ~severity:"error" message

let compile_source ~directory ~source ~cancelled =
  let path = Filename.concat directory "document.ml" in
  let executable = Filename.concat directory "document.byte" in
  match Util.write_file path source with
  | Error message ->
      Error (diagnostic ~stage:"prepare" ~severity:"error" message)
  | Ok () ->
      let signature =
        run_process ~timeout_seconds:12. ~cancelled (compiler ())
          [ "-I"; "+unix"; "-i"; path ]
      in
      if (not (successful signature.status)) || signature.output_limited then
        Error (process_failure ~stage:"compile" signature)
      else
        let compilation =
          run_process ~timeout_seconds:12. ~cancelled (compiler ())
            [ "-g"; "-I"; "+unix"; "unix.cma"; path; "-o"; executable ]
        in
        if (not (successful compilation.status)) || compilation.output_limited
        then Error (process_failure ~stage:"compile" compilation)
        else
          let warnings =
            [ signature.stderr; compilation.stderr ]
            |> List.filter (fun output ->
                not (String.equal (String.trim output) ""))
            |> String.concat "\n"
          in
          Ok (strip_prelude_signature signature.stdout, executable, warnings)

type block_marker = { index : int; path : string; block_id : string }

let block_marker evaluation_id index phase =
  Printf.sprintf "\030DOX:%s:%d:%c\031" evaluation_id index phase

let instrumented_compilation_source evaluation_id documents target =
  let next_index = ref 0 in
  let next_inline_index = ref 0 in
  let markers = ref [] in
  let inline_markers = ref [] in
  let document_source (document : Document.t) =
    let block_sources =
      document.blocks
      |> List.filter_map (function
        | Document.Code { id; source; source_line; kind = Document.Program; _ }
          ->
            let index = !next_index in
            incr next_index;
            markers :=
              { index; path = document.path; block_id = id } :: !markers;
            let start_marker = block_marker evaluation_id index 'S' in
            let end_marker = block_marker evaluation_id index 'E' in
            Some
              (Printf.sprintf
                 "# 1 %S\n\
                  let () = output_string stdout %S; flush stdout; \
                  output_string stderr %S; flush stderr;;\n\
                  # %d %S\n\
                  %s\n\
                  ;;\n\
                  # 1 %S\n\
                  let () = flush stdout; output_string stdout %S; flush \
                  stdout; flush stderr; output_string stderr %S; flush stderr;;\n"
                 "<dox-block-boundary>" start_marker start_marker source_line
                 document.path source "<dox-block-boundary>" end_marker
                 end_marker)
        | _ -> None)
    in
    let inline_sources =
      Document.inline_expressions document
      |> List.map (fun inline_expression ->
          let index = !next_inline_index in
          incr next_inline_index;
          let virtual_path =
            Printf.sprintf "<dox-inline:%s:%d>" evaluation_id index
          in
          inline_markers :=
            { virtual_path; document_path = document.path; inline_expression }
            :: !inline_markers;
          Printf.sprintf "# 1 %S\nlet () = try ignore (@(%s)) with _ -> ()\n"
            virtual_path inline_expression.expression)
    in
    ( document,
      "open Dox_prelude\n" ^ String.concat "\n" (block_sources @ inline_sources)
    )
  in
  ignore target;
  let sources = List.map document_source documents in
  (sources, List.rev !markers, List.rev !inline_markers)

let compile_document_units ?(prelude_source = prelude) ?entry
    ?(environment = []) ~directory ~sources ~target ~cancelled () =
  let emit_manifests =
    List.assoc_opt "DOX_TRACE_ALL" environment = Some "1"
  in
  let unit_name document =
    match Module_path.of_source_path document.Document.path with
    | Ok module_path -> Module_path.compiler_unit module_path
    | Error _ -> "Dox__Page_" ^ Util.digest document.path
  in
  let modules =
    sources
    |> List.filter_map (fun (document, _) ->
        Result.to_option (Module_path.of_source_path document.Document.path))
  in
  let prepared =
    sources
    |> List.map (fun (document, source) ->
        let module_path =
          Result.to_option (Module_path.of_source_path document.Document.path)
        in
        let source = Module_path.rewrite_qualified_references ~modules source in
        let source =
          match module_path with
          | None -> source
          | Some module_path ->
              Module_path.ancestor_open_source module_path ^ source
        in
        let source =
          match module_path with
          | None -> source
          | Some module_path ->
              source ^ "\n" ^ Module_path.alias_source modules module_path
        in
        let path =
          Filename.concat directory
            (String.uncapitalize_ascii (unit_name document) ^ ".ml")
        in
        (document, path, source))
  in
  let aliases =
    Module_path.alias_units modules @ Module_path.scope_alias_units modules
    |> List.filter (fun (unit_name, _) ->
        not
          (List.exists
             (fun module_path ->
               String.equal unit_name (Module_path.compiler_unit module_path))
             modules))
    |> List.map (fun (unit_name, source) ->
        ( Filename.concat directory (String.uncapitalize_ascii unit_name ^ ".ml"),
          source ))
  in
  let write_result =
    Result.bind
      (Util.write_file
         (Filename.concat directory "dox_prelude.ml")
         prelude_source)
      (fun () ->
        Result.bind
          (prepared
          |> List.fold_left
               (fun result (_, path, source) ->
                 Result.bind result (fun () -> Util.write_file path source))
               (Ok ()))
          (fun () ->
            aliases
            |> List.fold_left
                 (fun result (path, source) ->
                   Result.bind result (fun () -> Util.write_file path source))
                 (Ok ())))
  in
  let compile ?(environment = []) arguments =
    run_process ~cwd:directory ~environment ~timeout_seconds:12. ~cancelled
      ~output_limit:1_000_000 (compiler ()) arguments
  in
  match write_result with
  | Error message ->
      Error (diagnostic ~stage:"prepare" ~severity:"error" message)
  | Ok () -> (
      let prelude_result = compile [ "-c"; "dox_prelude.ml" ] in
      if not (successful prelude_result.status) then
        Error (process_failure ~stage:"compile" prelude_result)
      else
        let alias_error =
          aliases
          |> List.find_map (fun (path, _) ->
              let result =
                compile
                  [
                    "-w"; "-49"; "-no-alias-deps"; "-c"; Filename.basename path;
                  ]
              in
              if successful result.status then None else Some result)
        in
        match alias_error with
        | Some result -> Error (process_failure ~stage:"compile" result)
        | None ->
            let rec compile_pass compiled pending warnings =
              match pending with
              | [] -> Ok (compiled, warnings)
              | _ ->
                  let succeeded, failed, warnings =
                    pending
                    |> List.fold_left
                         (fun (succeeded, failed, warnings) item ->
                           let _, path, _ = item in
                           let manifest_path = path ^ ".dox-constructs" in
                           let compile_environment =
                             if emit_manifests then
                               ("DOX_EXECUTION_MANIFEST", manifest_path)
                               :: environment
                             else environment
                           in
                           let result =
                             compile ~environment:compile_environment
                               [
                                 "-g";
                                 "-I";
                                 "+unix";
                                 "-I";
                                 directory;
                                 "-no-alias-deps";
                                 "-open";
                                 "Dox";
                                 "-c";
                                 Filename.basename path;
                               ]
                           in
                           if successful result.status then
                             ( item :: succeeded,
                               failed,
                               result.stderr :: warnings )
                           else (succeeded, (item, result) :: failed, warnings))
                         ([], [], warnings)
                  in
                  if succeeded = [] then
                    let _, result = List.hd failed in
                    Error (process_failure ~stage:"compile" result)
                  else
                    compile_pass
                      (compiled @ List.rev succeeded)
                      (List.rev_map fst failed) warnings
            in
            Result.bind (compile_pass [] prepared [])
              (fun (compiled, warnings) ->
                let manifests =
                  if not emit_manifests then Ok []
                  else
                    compiled
                    |> List.fold_left
                         (fun result (_, path, _) ->
                           Result.bind result (fun manifests ->
                               Result.map
                                 (fun manifest -> manifest :: manifests)
                                 (read_compiler_manifest
                                    (path ^ ".dox-constructs"))))
                         (Ok [])
                    |> Result.map List.rev
                    |> Result.map_error (fun message ->
                        diagnostic ~stage:"compile" ~severity:"error" message)
                in
                Result.bind manifests (fun manifests ->
                let target_path =
                  compiled
                  |> List.find_map (fun (document, path, _) ->
                      if
                        String.equal document.Document.path target.Document.path
                      then Some (Filename.basename path)
                      else None)
                  |> Option.get
                in
                let signature =
                  compile [ "-I"; directory; "-open"; "Dox"; "-i"; target_path ]
                in
                if not (successful signature.status) then
                  Error (process_failure ~stage:"compile" signature)
                else
                  let executable = Filename.concat directory "document.byte" in
                  let objects =
                    compiled
                    |> List.map (fun (_, path, _) ->
                        Filename.chop_extension (Filename.basename path)
                        ^ ".cmo")
                  in
                  let driver =
                    match entry with
                    | None -> Ok []
                    | Some entry ->
                        let source =
                          Printf.sprintf "open %s\nlet () = %s ()\n"
                            (unit_name target) entry
                        in
                        Result.bind
                          (Util.write_file
                             (Filename.concat directory "driver.ml")
                             source
                          |> Result.map_error (fun message ->
                              diagnostic ~stage:"prepare" ~severity:"error"
                                message))
                          (fun () ->
                            let result =
                              compile
                                [
                                  "-I";
                                  directory;
                                  "-open";
                                  "Dox";
                                  "-c";
                                  "driver.ml";
                                ]
                            in
                            if successful result.status then Ok [ "driver.cmo" ]
                            else Error (process_failure ~stage:"compile" result))
                  in
                  Result.bind driver (fun driver ->
                      let linked =
                        compile
                          ([
                             "-g";
                             "-I";
                             "+unix";
                             "-I";
                             directory;
                             "unix.cma";
                             "dox_prelude.cmo";
                           ]
                          @ objects @ driver @ [ "-o"; executable ])
                      in
                      if not (successful linked.status) then
                        Error (process_failure ~stage:"compile" linked)
                      else
                        Ok
                          {
                            compiled_signature = signature.stdout;
                            compiled_executable = executable;
                            compiled_warnings =
                              signature.stderr :: linked.stderr :: warnings
                              |> List.filter (fun value ->
                                  not (String.equal (String.trim value) ""))
                              |> String.concat "\n";
                            compiled_manifests = manifests;
                          }))))

let split_block_output evaluation_id markers output =
  let marker_prefix = Printf.sprintf "\030DOX:%s:" evaluation_id in
  let marker_re =
    Str.regexp
      (Str.quote marker_prefix ^ "\\([0-9]+\\):\\([SE]\\)" ^ Str.quote "\031")
  in
  let captured =
    Array.init (List.length markers) (fun _ -> Buffer.create 128)
  in
  let clean = Buffer.create (String.length output) in
  let unowned = Buffer.create 64 in
  let rec loop offset active =
    try
      let marker_start = Str.search_forward marker_re output offset in
      let marker_end = Str.match_end () in
      let segment = String.sub output offset (marker_start - offset) in
      Buffer.add_string clean segment;
      (match active with
      | Some index when index >= 0 && index < Array.length captured ->
          Buffer.add_string captured.(index) segment
      | _ -> Buffer.add_string unowned segment);
      let index = int_of_string (Str.matched_group 1 output) in
      let phase = Str.matched_group 2 output in
      let next_active =
        if String.equal phase "S" then Some index
        else
          match active with
          | Some current when current = index -> None
          | _ -> active
      in
      loop marker_end next_active
    with Not_found -> (
      let segment = String.sub output offset (String.length output - offset) in
      Buffer.add_string clean segment;
      match active with
      | Some index when index >= 0 && index < Array.length captured ->
          Buffer.add_string captured.(index) segment
      | _ -> Buffer.add_string unowned segment)
  in
  loop 0 None;
  if Array.length captured > 0 && Buffer.length unowned > 0 then
    Buffer.add_string
      captured.(Array.length captured - 1)
      (Buffer.contents unowned);
  (Buffer.contents clean, Array.map Buffer.contents captured)

let inline_marker_for_path inline_markers path =
  List.find_opt
    (fun marker -> String.equal marker.virtual_path path)
    inline_markers

let inline_diagnostic_message marker message =
  let message =
    Str.global_replace
      (Str.regexp_string marker.virtual_path)
      marker.document_path message
  in
  match String.split_on_char '\n' message with
  | first :: rest when Util.starts_with ~prefix:"File \"" first ->
      String.concat "\n" rest
  | _ -> message

let normalize_inline_diagnostic inline_markers (diagnostic : diagnostic) =
  match diagnostic.path with
  | Some path -> (
      match inline_marker_for_path inline_markers path with
      | None -> diagnostic
      | Some marker ->
          let expression = marker.inline_expression in
          {
            diagnostic with
            message = inline_diagnostic_message marker diagnostic.message;
            path = Some marker.document_path;
            line = Some expression.line;
            column_start = Some expression.column_start;
            column_end = Some expression.column_end;
          })
  | None -> diagnostic

let inline_results inline_markers (traces : trace_event list)
    (diagnostics : diagnostic list) =
  inline_markers
  |> List.filter_map (fun marker ->
      let expression = marker.inline_expression in
      let event =
        List.find_opt
          (fun (event : trace_event) ->
            String.equal event.path marker.virtual_path
            && String.equal event.kind "expression"
            && (String.equal event.phase "return"
               || String.equal event.phase "raise"))
          (List.rev traces)
      in
      let diagnostic =
        List.find_opt
          (fun (diagnostic : diagnostic) ->
            match diagnostic.path with
            | Some path -> String.equal path marker.virtual_path
            | None -> false)
          diagnostics
      in
      match (event, diagnostic) with
      | Some event, _ ->
          Some
            {
              id = expression.id;
              path = marker.document_path;
              expression = expression.expression;
              line = expression.line;
              column_start = expression.column_start;
              column_end = expression.column_end;
              result_column = expression.result_column;
              type_ = event.type_;
              value =
                (if String.equal event.phase "return" then event.detail else "");
              error =
                (if String.equal event.phase "raise" then Some event.detail
                 else None);
            }
      | None, Some diagnostic ->
          Some
            {
              id = expression.id;
              path = marker.document_path;
              expression = expression.expression;
              line = expression.line;
              column_start = expression.column_start;
              column_end = expression.column_end;
              result_column = expression.result_column;
              type_ = "";
              value = "";
              error = Some (inline_diagnostic_message marker diagnostic.message);
            }
      | None, None -> None)

let without_inline_trace_trees inline_markers (traces : trace_event list) =
  let virtual_path path =
    List.exists
      (fun marker -> String.equal marker.virtual_path path)
      inline_markers
  in
  let roots =
    traces
    |> List.filter_map (fun (event : trace_event) ->
        if virtual_path event.path && event.parent_id = None then
          Some event.occurrence_id
        else None)
  in
  let rec expand removed =
    let next =
      traces
      |> List.fold_left
           (fun ids (event : trace_event) ->
             match event.parent_id with
             | Some parent
               when List.mem parent ids
                    && not (List.mem event.occurrence_id ids) ->
                 event.occurrence_id :: ids
             | None | Some _ -> ids)
           removed
    in
    if List.length next = List.length removed then next else expand next
  in
  let removed = expand roots in
  List.filter
    (fun (event : trace_event) -> not (List.mem event.occurrence_id removed))
    traces

let normalize_inline_trace_event inline_markers (event : trace_event) =
  match inline_marker_for_path inline_markers event.path with
  | None -> event
  | Some marker ->
      let expression = marker.inline_expression in
      let prefix_length = String.length "let () = try ignore (@(" in
      let column column =
        expression.column_start
        + utf16_column_of_utf8_byte expression.expression
            (max 0 (column - prefix_length))
      in
      {
        event with
        path = marker.document_path;
        source_line = expression.line;
        source_column = column event.source_column;
        source_end_line = expression.line;
        source_end_column = column event.source_end_column;
      }

let add_identity_field buffer value =
  Buffer.add_string buffer (string_of_int (String.length value));
  Buffer.add_char buffer ':';
  Buffer.add_string buffer value

let source_identity ~domain entries =
  let buffer = Buffer.create 4096 in
  add_identity_field buffer domain;
  entries
  |> List.sort (fun (left, _) (right, _) -> String.compare left right)
  |> List.iter (fun (path, parts) ->
      add_identity_field buffer path;
      add_identity_field buffer (string_of_int (List.length parts));
      List.iter
        (fun (kind, value) ->
          add_identity_field buffer kind;
          add_identity_field buffer value)
        parts);
  Util.sha256 (Buffer.contents buffer)

let trim_identity_source source =
  if String.ends_with ~suffix:"\n" source then
    String.sub source 0 (String.length source - 1)
  else source

let request_code_digest_for_document (document : Document.t) =
  let parts =
    Document.execution_identity_parts document
    |> List.map (fun (kind, source) -> (kind, trim_identity_source source))
  in
  source_identity ~domain:"dox-executable-source-v1" [ (document.path, parts) ]

let document_revision_id (document : Document.t) =
  source_identity ~domain:"dox-document-source-v1"
    [ (document.path, [ ("source", document.source) ]) ]

let project_digest ~documents ~(target : Document.t) =
  documents
  |> List.filter (fun document ->
      not (String.equal document.Document.path target.Document.path))
  |> List.map (fun document ->
      ( document.Document.path,
        [ ("compilation", Document.compilation_source document) ] ))
  |> source_identity ~domain:"dox-project-source-v1"

let evaluate_documents ?project_version ?request_code_digest
    ?(cancelled = fun () -> false)
    ~documents ~target () =
  let started = Unix.gettimeofday () in
  let started_at = Util.timestamp () in
  let evaluation_id =
    Util.random_token () |> fun token -> String.sub token 0 24
  in
  let ordered_documents =
    List.sort
      (fun left right -> String.compare left.Document.path right.path)
      documents
  in
  let document_revision_id = document_revision_id target in
  let sources_digest =
    ordered_documents
    |> List.map (fun document ->
        (document.Document.path, [ ("source", document.Document.source) ]))
    |> source_identity ~domain:"dox-project-documents-v1"
  in
  let compilation_entries =
    ordered_documents
    |> List.map (fun document ->
        ( document.Document.path,
          [ ("compilation", Document.compilation_source document) ] ))
  in
  let extracted_code_digest =
    source_identity ~domain:"dox-extracted-code-v1" compilation_entries
  in
  (* The project digest identifies compiler inputs outside the edited target.
     It deliberately excludes the target source, whose identity is carried by
     [request_code_digest]. This makes A -> B -> A artifact reuse valid even
     after either draft was autosaved, without allowing dependency changes to
     reuse an artifact. *)
  let project_digest = project_digest ~documents:ordered_documents ~target in
  let code_revision_id =
    source_identity ~domain:"dox-code-revision-v1"
      (("\000compiler", [ ("identity", compiler_identity ()) ])
      :: compilation_entries)
  in
  let computed_request_code_digest = request_code_digest_for_document target in
  let request_code_digest =
    Option.value ~default:computed_request_code_digest request_code_digest
  in
  let directory = Filename.temp_dir "dox-eval-" "" in
  let event_path = Filename.concat directory "events" in
  let trace_path = Filename.concat directory "trace-events" in
  let document_sources, block_markers, inline_markers =
    instrumented_compilation_source evaluation_id documents target
  in
  let parse_diagnostics =
    documents
    |> List.concat_map (fun (document : Document.t) ->
        List.map
          (fun issue ->
            {
              stage = "parse";
              severity = issue.Document.severity;
              message = issue.message;
              path = Some document.path;
              line = Some issue.line;
              column_start = None;
              column_end = None;
            })
          document.Document.issues)
  in
  let evaluated =
    Fun.protect
      ~finally:(fun () ->
        match Sys.getenv_opt "DOX_KEEP_EVAL_DIR" with
        | Some ("1" | "true") -> prerr_endline ("DOX_EVAL_DIR " ^ directory)
        | None | Some _ -> remove_temp_directory directory)
      (fun () ->
        if cancelled () then raise Cancelled;
        if
          List.exists
            (fun diagnostic -> String.equal diagnostic.severity "error")
            parse_diagnostics
        then
          ("invalid", "", "", "", [], [], [], false, 0, 0, 0,
           [], parse_diagnostics)
        else
          match
            compile_document_units
              ~environment:[ ("DOX_TRACE_ALL", "1") ]
              ~directory ~sources:document_sources ~target ~cancelled ()
          with
          | Error compilation ->
              ("compile-error", "", "", "", [], [], [], false, 0, 0, 0,
               [], [ compilation ])
          | Ok compiled ->
              let runtime =
                run_process ~timeout_seconds:5. ~cancelled
                  ~environment:
                    [
                      ("DOCLANG_EVENT_PATH", event_path);
                      ("DOCLANG_TRACE_PATH", trace_path);
                    ]
                  ~extra_output_paths:[ event_path ]
                  (ocamlrun ()) [ compiled.compiled_executable ]
              in
              let view_events = read_file_prefix event_path 2_000_000 in
              let trace_events = read_file_prefix trace_path 12_200_000 in
              let trace_malformed = runtime_events_malformed trace_events in
              let raw_trace_truncated =
                runtime_events_truncated trace_events || trace_malformed
              in
              let views, _ = parse_runtime_events view_events in
              let _, traces = parse_runtime_events trace_events in
              let multiple_trace_domains =
                traces
                |> List.map (fun event -> event.domain_id)
                |> List.sort_uniq Int.compare
                |> List.length
                |> fun count -> count > 1
              in
              let tail_handoffs, tail_linked_enters, tail_handoff_outcomes,
                  tail_handoff_occurrences =
                raw_tail_stats traces
              in
              let traces, tail_relations_malformed =
                complete_tail_outcomes ~trace_truncated:raw_trace_truncated
                  traces
              in
              let trace_truncated =
                raw_trace_truncated || tail_relations_malformed
              in
              let traces = List.map (normalize_trace_event documents) traces in
              let warning_diagnostics =
                (if String.equal compiled.compiled_warnings "" then []
                 else
                   [
                     diagnostic ~stage:"compile" ~severity:"warning"
                       compiled.compiled_warnings;
                   ])
                @ (if trace_malformed || tail_relations_malformed then
                    [
                      diagnostic ~stage:"runtime" ~severity:"warning"
                        "Execution data was incomplete because runtime trace relations were malformed.";
                    ]
                  else [])
                @ if multiple_trace_domains then
                    [
                      diagnostic ~stage:"runtime" ~severity:"error"
                        "Execution tracing currently supports one OCaml domain; this program produced events on multiple domains.";
                    ]
                  else []
              in
              if multiple_trace_domains then
                ( "runtime-error",
                  compiled.compiled_signature,
                  runtime.stdout,
                  runtime.stderr,
                  views,
                  traces,
                  compiled.compiled_manifests,
                  true,
                  tail_handoffs,
                  tail_linked_enters,
                  tail_handoff_outcomes,
                  tail_handoff_occurrences,
                  warning_diagnostics )
              else if successful runtime.status && not runtime.output_limited then
                ( "ready",
                  compiled.compiled_signature,
                  runtime.stdout,
                  runtime.stderr,
                  views,
                  traces,
                  compiled.compiled_manifests,
                  trace_truncated,
                  tail_handoffs,
                  tail_linked_enters,
                  tail_handoff_outcomes,
                  tail_handoff_occurrences,
                  warning_diagnostics )
              else
                ( (if runtime.timed_out then "timed-out"
                   else if runtime.output_limited then "output-limited"
                   else "runtime-error"),
                  compiled.compiled_signature,
                  runtime.stdout,
                  runtime.stderr,
                  views,
                  traces,
                  compiled.compiled_manifests,
                  trace_truncated,
                  tail_handoffs,
                  tail_linked_enters,
                  tail_handoff_outcomes,
                  tail_handoff_occurrences,
                  warning_diagnostics
                  @ [ process_failure ~stage:"runtime" runtime ] ))
  in
  let status, signature, stdout, stderr, views, traces, compiler_manifests,
      trace_truncated, tail_handoffs, tail_linked_enters,
      tail_handoff_outcomes, tail_handoff_occurrences, diagnostics =
    evaluated
  in
  let inline_results = inline_results inline_markers traces diagnostics in
  let traces = List.map (normalize_inline_trace_event inline_markers) traces in
  let diagnostics =
    List.map (normalize_inline_diagnostic inline_markers) diagnostics
  in
  let stdout, block_stdouts =
    split_block_output evaluation_id block_markers stdout
  in
  let stderr, block_stderrs =
    split_block_output evaluation_id block_markers stderr
  in
  let block_outputs =
    block_markers
    |> List.filter_map (fun marker ->
        let stdout = block_stdouts.(marker.index) in
        let stderr = block_stderrs.(marker.index) in
        if String.equal stdout "" && String.equal stderr "" then None
        else
          Some
            { path = marker.path; block_id = marker.block_id; stdout; stderr })
  in
  let duration_ms = int_of_float ((Unix.gettimeofday () -. started) *. 1000.) in
  let source_map_entries =
    source_map_entries documents inline_markers compiler_manifests
  in
  {
    ok = String.equal status "ready";
    status;
    evaluation_id;
    request_code_digest;
    code_revision_id;
    document_version = target.Document.version;
    document_revision_id;
    sources_digest;
    extracted_code_digest;
    project_digest;
    project_version;
    started_at;
    compiler = compiler_identity ();
    signature;
    bindings = bindings signature;
    stdout;
    stderr;
    block_outputs;
    inline_results;
    views;
    traces;
    compiler_manifests;
    source_map_entries;
    trace_truncated;
    tail_handoffs;
    tail_linked_enters;
    tail_handoff_outcomes;
    tail_handoff_occurrences;
    diagnostics;
    duration_ms;
  }

let evaluate ?project_version document =
  evaluate_documents ?project_version ~documents:[ document ] ~target:document
    ()

let diagnostic_to_json diagnostic =
  `Assoc
    [
      ("stage", `String diagnostic.stage);
      ("severity", `String diagnostic.severity);
      ("message", `String diagnostic.message);
      ( "path",
        Option.fold ~none:`Null ~some:(fun path -> `String path) diagnostic.path
      );
      ( "line",
        Option.fold ~none:`Null ~some:(fun line -> `Int line) diagnostic.line );
      ( "columnStart",
        Option.fold ~none:`Null
          ~some:(fun column -> `Int column)
          diagnostic.column_start );
      ( "columnEnd",
        Option.fold ~none:`Null
          ~some:(fun column -> `Int column)
          diagnostic.column_end );
    ]

let binding_to_json (binding : binding) =
  `Assoc [ ("name", `String binding.name); ("type", `String binding.type_) ]

let view_to_json (view : view) =
  `Assoc
    [
      ("sequence", `Int view.sequence);
      ("kind", `String view.kind);
      ("id", `String view.id);
      ("content", `String view.content);
    ]

let block_output_to_json (output : block_output) =
  `Assoc
    [
      ("path", `String output.path);
      ("blockId", `String output.block_id);
      ("stdout", `String output.stdout);
      ("stderr", `String output.stderr);
    ]

let inline_result_to_json (result : inline_result) =
  `Assoc
    [
      ("id", `String result.id);
      ("path", `String result.path);
      ("expression", `String result.expression);
      ("line", `Int result.line);
      ("columnStart", `Int result.column_start);
      ("columnEnd", `Int result.column_end);
      ("resultColumn", `Int result.result_column);
      ("type", `String result.type_);
      ("value", `String result.value);
      ( "error",
        Option.fold ~none:`Null ~some:(fun error -> `String error) result.error
      );
    ]

let trace_event_to_json (event : trace_event) =
  `Assoc
    [
      ("sequence", `Int event.sequence);
      ("domainId", `Int event.domain_id);
      ("phase", `String event.phase);
      ("occurrenceId", `String event.occurrence_id);
      ( "parentId",
        Option.fold ~none:`Null
          ~some:(fun parent -> `String parent)
          event.parent_id );
      ("siteId", `String event.site_id);
      ("kind", `String event.kind);
      ("label", `String event.label);
      ("path", `String event.path);
      ("line", `Int event.source_line);
      ("column", `Int event.source_column);
      ("endLine", `Int event.source_end_line);
      ("endColumn", `Int event.source_end_column);
      ("type", `String event.type_);
      ("valueComplete", `Bool event.value_complete);
      ("detail", `String event.detail);
    ]

let compiler_construct_to_json construct =
  `Assoc
    [
      ("id", `String construct.construct_id);
      ("category", `String construct.construct_category);
      ("semanticKind", `String construct.construct_semantic_kind);
      ("sourcePath", `String construct.construct_generated_path);
      ("startByte", `Int construct.construct_start_byte);
      ("endByte", `Int construct.construct_end_byte);
      ("startLine", `Int construct.construct_start_line);
      ("startColumn", `Int construct.construct_start_column);
      ("endLine", `Int construct.construct_end_line);
      ("endColumn", `Int construct.construct_end_column);
      ("ghost", `Bool construct.construct_ghost);
      ( "parentId",
        Option.fold ~none:`Null
          ~some:(fun id -> `String id)
          construct.construct_parent_id );
      ("ownerScopeId", `String construct.construct_owner_scope_id);
      ("lexicalScopeId", `String construct.construct_lexical_scope_id);
      ("syntaxFingerprint", `String construct.construct_syntax_fingerprint);
      ( "lexicalAncestryFingerprint",
        `String construct.construct_lexical_ancestry_fingerprint );
    ]

let compiler_execution_scope_to_json scope =
  `Assoc
    [
      ("id", `String scope.scope_id);
      ("kind", `String scope.scope_kind);
      ( "functionConstructId",
        Option.fold ~none:`Null
          ~some:(fun id -> `String id)
          scope.scope_function_construct_id );
    ]

let compiler_selector_to_json selector =
  `Assoc
    [
      ("id", `String selector.selector_id);
      ("role", `String selector.selector_role);
      ("subjectId", `String selector.selector_subject_id);
      ("sourcePath", `String selector.selector_generated_path);
      ("startByte", `Int selector.selector_start_byte);
      ("endByte", `Int selector.selector_end_byte);
      ("startLine", `Int selector.selector_start_line);
      ("startColumn", `Int selector.selector_start_column);
      ("endLine", `Int selector.selector_end_line);
      ("endColumn", `Int selector.selector_end_column);
      ("priority", `Int selector.selector_priority);
      ("tieBreakRank", `Int selector.selector_tie_break_rank);
      ("syntaxFingerprint", `String selector.selector_syntax_fingerprint);
    ]

let compiler_manifest_to_json manifest =
  `Assoc
    [
      ("unitName", `String manifest.manifest_unit_name);
      ("generatedPath", `String manifest.manifest_generated_path);
      ("byteLength", `Int manifest.manifest_byte_length);
      ("sourceDigest", `String manifest.manifest_source_digest);
      ("topLevelScopeId", `String manifest.manifest_top_level_scope_id);
      ( "executionScopes",
        `List
          (List.map compiler_execution_scope_to_json
             manifest.manifest_execution_scopes) );
      ( "constructs",
        `List
          (List.map compiler_construct_to_json manifest.manifest_constructs) );
      ( "selectors",
        `List (List.map compiler_selector_to_json manifest.manifest_selectors) );
    ]

let user_execution_traces manifests traces =
  let sites = Hashtbl.create 256 in
  List.iter
    (fun manifest ->
      List.iter
        (fun construct ->
          Hashtbl.replace sites construct.construct_id ())
        manifest.manifest_constructs)
    manifests;
  List.filter
    (fun (event : trace_event) -> Hashtbl.mem sites event.site_id)
    traces

let mapped_selector_ids source_map_entries =
  let ids = Hashtbl.create 256 in
  List.iter
    (fun entry -> Hashtbl.replace ids entry.map_selector_id ())
    source_map_entries;
  ids

let compiler_static_program_to_json ?mapped_selector_ids ~code_revision_id
    ~compiler_inputs_digest manifests =
  let construct_fingerprint id =
    manifests
    |> List.find_map (fun manifest ->
        manifest.manifest_constructs
        |> List.find_map (fun construct ->
            if String.equal construct.construct_id id then
              Some construct.construct_syntax_fingerprint
            else None))
    |> Option.value ~default:""
  in
  let compilation_units =
    manifests
    |> List.map (fun manifest ->
        `Assoc
          [
            ("id", `String manifest.manifest_unit_name);
            ("modulePath", `String manifest.manifest_unit_name);
            ("generatedPath", `String manifest.manifest_generated_path);
            ("byteLength", `Int manifest.manifest_byte_length);
            ("sourceDigest", `String manifest.manifest_source_digest);
            ("topLevelScopeId", `String manifest.manifest_top_level_scope_id);
          ])
  in
  let execution_scopes =
    manifests
    |> List.concat_map (fun manifest ->
        manifest.manifest_execution_scopes
        |> List.map (fun scope ->
            `Assoc
              ([
                 ("id", `String scope.scope_id);
                 ("kind", `String scope.scope_kind);
                 ("unitId", `String manifest.manifest_unit_name);
               ]
              @
              match scope.scope_function_construct_id with
              | None -> []
              | Some id ->
                  [
                    ("functionConstructId", `String id);
                    ("functionFingerprint", `String (construct_fingerprint id));
                  ])))
  in
  let constructs =
    manifests
    |> List.concat_map (fun manifest ->
        manifest.manifest_constructs
        |> List.map (fun construct ->
            `Assoc
              [
                ("id", `String construct.construct_id);
                ("category", `String construct.construct_category);
                ("semanticKind", `String construct.construct_semantic_kind);
                ( "compilerRange",
                  `Assoc
                    [
                      ("generatedPath", `String manifest.manifest_generated_path);
                      ("startByte", `Int construct.construct_start_byte);
                      ("endByte", `Int construct.construct_end_byte);
                    ] );
                ( "parentId",
                  Option.fold ~none:`Null
                    ~some:(fun id -> `String id)
                    construct.construct_parent_id );
                ("ownerScopeId", `String construct.construct_owner_scope_id);
                ( "lexicalScopeId",
                  `String construct.construct_lexical_scope_id );
                ( "syntaxFingerprint",
                  `String construct.construct_syntax_fingerprint );
                ( "lexicalAncestryFingerprint",
                  `String construct.construct_lexical_ancestry_fingerprint );
                ("ghost", `Bool construct.construct_ghost);
              ]))
  in
  let selectors =
    manifests
    |> List.concat_map (fun manifest ->
        manifest.manifest_selectors
        |> List.filter (fun selector ->
            match mapped_selector_ids with
            | None -> true
            | Some ids -> Hashtbl.mem ids selector.selector_id)
        |> List.map (fun selector ->
            `Assoc
              [
                ("id", `String selector.selector_id);
                ( "compilerRange",
                  `Assoc
                    [
                      ("generatedPath", `String manifest.manifest_generated_path);
                      ("startByte", `Int selector.selector_start_byte);
                      ("endByte", `Int selector.selector_end_byte);
                    ] );
                ("subjectId", `String selector.selector_subject_id);
                ("role", `String selector.selector_role);
                ("priority", `Int selector.selector_priority);
                ("tieBreakRank", `Int selector.selector_tie_break_rank);
                ( "syntaxFingerprint",
                  `String selector.selector_syntax_fingerprint );
              ]))
  in
  `Assoc
    [
      ("codeRevisionId", `String code_revision_id);
      ("compilerInputsDigest", `String compiler_inputs_digest);
      ("compilationUnits", `List compilation_units);
      ("executionScopes", `List execution_scopes);
      ("constructs", `List constructs);
      ("selectors", `List selectors);
    ]

let normalized_execution_to_json manifests (traces : trace_event list)
    ~tail_handoff_occurrences ~trace_truncated =
  let final_sequence =
    List.fold_left
      (fun maximum (event : trace_event) -> max maximum event.sequence)
      0 traces
  in
  let enters = Hashtbl.create 256 in
  let outcomes = Hashtbl.create 256 in
  let call_attempt_opens = ref [] in
  let call_attempt_outcomes = Hashtbl.create 256 in
  let call_attempt_consumptions = ref [] in
  let closure_creations = ref [] in
  let activation_closures = Hashtbl.create 256 in
  let writes = ref [] in
  let parameters = ref [] in
  List.iter
    (fun event ->
      match event.phase with
      | "enter" -> Hashtbl.replace enters event.occurrence_id event
      | "return" | "raise" ->
          Hashtbl.replace outcomes event.occurrence_id event
      | "call-attempt-open" -> call_attempt_opens := event :: !call_attempt_opens
      | "call-attempt-return" | "call-attempt-raise" ->
          Hashtbl.replace call_attempt_outcomes event.occurrence_id event
      | "call-attempt-consumed" ->
          call_attempt_consumptions := event :: !call_attempt_consumptions
      | "closure-created" -> closure_creations := event :: !closure_creations
      | "activation-closure" ->
          Hashtbl.replace activation_closures event.occurrence_id event.detail
      | "write" -> writes := event :: !writes
      | "parameter" -> parameters := event :: !parameters
      | _ -> ())
    traces;
  let construct_manifest = Hashtbl.create 256 in
  let scope_by_construct = Hashtbl.create 256 in
  let function_scope_by_construct = Hashtbl.create 256 in
  List.iter
    (fun manifest ->
      List.iter
        (fun scope ->
          Option.iter
            (fun construct_id ->
              Hashtbl.replace function_scope_by_construct construct_id
                scope.scope_id)
            scope.scope_function_construct_id)
        manifest.manifest_execution_scopes;
      List.iter
        (fun construct ->
          Hashtbl.replace construct_manifest construct.construct_id manifest;
          Hashtbl.replace scope_by_construct construct.construct_id
            construct.construct_owner_scope_id)
        manifest.manifest_constructs)
    manifests;
  let root_activation_id manifest =
    "activation:top:" ^ manifest.manifest_unit_name
  in
  let manifest_for_site site_id = Hashtbl.find_opt construct_manifest site_id in
  let activation_scope_for_construct construct_id =
    match Hashtbl.find_opt function_scope_by_construct construct_id with
    | Some scope_id -> scope_id
    | None ->
      Hashtbl.find_opt scope_by_construct construct_id
      |> Option.value ~default:"unknown-scope"
  in
  let fallback_manifest = match manifests with manifest :: _ -> Some manifest | [] -> None in
  let manifest_for_event (event : trace_event) =
    match manifest_for_site event.site_id with
    | Some _ as manifest -> manifest
    | None -> fallback_manifest
  in
  let rec enclosing_function occurrence_id =
    Option.bind (Hashtbl.find_opt enters occurrence_id) (fun event ->
        if String.equal event.kind "function" then Some event
        else Option.bind event.parent_id enclosing_function)
  in
  let rec enclosing_call occurrence_id =
    Option.bind (Hashtbl.find_opt enters occurrence_id) (fun event ->
        if String.equal event.kind "call" then Some event
        else Option.bind event.parent_id enclosing_call)
  in
  let activation_id_for_event (event : trace_event) =
    let function_ =
      match enclosing_function event.occurrence_id with
      | Some _ as function_ -> function_
      | None -> Option.bind event.parent_id enclosing_function
    in
    match function_ with
    | Some function_ -> "activation:" ^ function_.occurrence_id
    | None ->
        manifest_for_event event
        |> Option.map root_activation_id
        |> Option.value ~default:"activation:top:unknown"
  in
  let captured_value (event : trace_event) =
    let complete = event.value_complete in
    `Assoc
      [
        ("type", `String event.type_);
        ("display", `String event.detail);
        ( "fingerprint",
          if complete then `String (Util.digest (event.type_ ^ "\000" ^ event.detail))
          else `Null );
        ("complete", `Bool complete);
      ]
  in
  let incomplete_outcome =
    `Assoc
      [
        ("kind", `String "incomplete");
        ("value", `Null);
        ("source", `String "truncated");
      ]
  in
  let outcome occurrence_id =
    match Hashtbl.find_opt outcomes occurrence_id with
    | Some event ->
        `Assoc
          [
            ("kind", `String event.phase);
            ("value", captured_value event);
            ("source", `String "runtime");
          ]
    | None -> incomplete_outcome
  in
  let call_attempt_outcome occurrence_id =
    let event =
      match Hashtbl.find_opt call_attempt_outcomes occurrence_id with
      | Some event -> Some event
      | None -> Hashtbl.find_opt outcomes occurrence_id
    in
    match event with
    | Some event ->
        `Assoc
          [
            ( "kind",
              `String
                (if String.equal event.phase "call-attempt-raise"
                    || String.equal event.phase "raise"
                 then "raise" else "return") );
            ("value", captured_value event);
            ("source", `String "call-attempt");
          ]
    | None -> incomplete_outcome
  in
  let occurrence_kind (event : trace_event) =
    match event.kind with
    | "function" -> "function"
    | "call" -> "call"
    | "pattern" -> "pattern"
    | "binding" -> "binder"
    | "boundary" -> "boundary"
    | _ -> "expression"
  in
  let enter_events =
    Hashtbl.to_seq_values enters |> List.of_seq
    |> List.sort (fun left right -> Int.compare left.sequence right.sequence)
  in
  let same_activation (left : trace_event) (right : trace_event) =
    String.equal (activation_id_for_event left) (activation_id_for_event right)
  in
  let occurrence_json (event : trace_event) =
    let parent_occurrence_id =
      if String.equal event.kind "function" then None
      else
        Option.bind event.parent_id (fun parent_id ->
            Option.bind (Hashtbl.find_opt enters parent_id) (fun parent ->
                if same_activation event parent then Some parent_id else None))
    in
    `Assoc
      [
        ("id", `String event.occurrence_id);
        ("constructId", `String event.site_id);
        ("activationId", `String (activation_id_for_event event));
        ( "parentOccurrenceId",
          Option.fold ~none:`Null
            ~some:(fun id -> `String id)
            parent_occurrence_id );
        ("kind", `String (occurrence_kind event));
        ("enteredAt", `Int event.sequence);
        ( "outcomeAt",
          Option.fold ~none:`Null
            ~some:(fun outcome -> `Int outcome.sequence)
            (Hashtbl.find_opt outcomes event.occurrence_id) );
        ("outcome", outcome event.occurrence_id);
      ]
  in
  let parameter_occurrence_id (event : trace_event) =
    Printf.sprintf "%s:parameter:%d" event.occurrence_id event.sequence
  in
  let parameter_json (event : trace_event) =
    `Assoc
      [
        ("id", `String (parameter_occurrence_id event));
        ("constructId", `String event.site_id);
        ("activationId", `String ("activation:" ^ event.occurrence_id));
        ("parentOccurrenceId", `String event.occurrence_id);
        ("kind", `String "parameter");
        ("enteredAt", `Int event.sequence);
        ("outcomeAt", `Int event.sequence);
        ( "outcome",
          `Assoc
            [
              ("kind", `String "return");
              ("value", captured_value event);
              ("source", `String "runtime");
            ] );
      ]
  in
  let parameters = List.rev !parameters in
  let all_occurrence_entries =
    List.map
      (fun event ->
        ( event.occurrence_id,
          activation_id_for_event event,
          event.sequence,
          occurrence_json event ))
      enter_events
    @ List.map
        (fun event ->
          ( parameter_occurrence_id event,
            "activation:" ^ event.occurrence_id,
            event.sequence,
            parameter_json event ))
        parameters
  in
  let occurrences_for_activation activation_id =
    all_occurrence_entries
    |> List.filter (fun (_, owner, _, _) -> String.equal owner activation_id)
    |> List.sort (fun (_, _, left, _) (_, _, right, _) -> Int.compare left right)
  in
  let function_events =
    List.filter
      (fun (event : trace_event) -> String.equal event.kind "function")
      enter_events
  in
  let callsite_for_function (event : trace_event) =
    Option.bind event.parent_id enclosing_call
  in
  let attempt_occurrence_for_consumption (consumed : trace_event) =
    Option.bind consumed.parent_id enclosing_call
    |> Option.map (fun (call : trace_event) -> call.occurrence_id)
  in
  let consumed_attempt_for_function (event : trace_event) =
    Option.bind
      (List.find_opt
         (fun consumed ->
           String.equal consumed.occurrence_id event.occurrence_id)
         !call_attempt_consumptions)
      attempt_occurrence_for_consumption
  in
  let function_activation_json (event : trace_event) =
    let activation_id = "activation:" ^ event.occurrence_id in
    let callsite = callsite_for_function event in
    let dynamic_parent =
      match Option.bind event.parent_id enclosing_function with
      | Some parent -> Some ("activation:" ^ parent.occurrence_id)
      | None -> Option.map activation_id_for_event callsite
    in
    let owned = occurrences_for_activation activation_id in
    let parameter_ids =
      parameters
      |> List.filter (fun parameter ->
          String.equal parameter.occurrence_id event.occurrence_id)
      |> List.map parameter_occurrence_id
    in
    let outcome_event = Hashtbl.find_opt outcomes event.occurrence_id in
    let outcome_fingerprint =
      Option.bind outcome_event (fun returned ->
          match captured_value returned with
          | `Assoc fields -> (
              match List.assoc_opt "fingerprint" fields with
              | Some (`String fingerprint) -> Some fingerprint
              | _ -> None)
          | _ -> None)
    in
    `Assoc
      [
        ("id", `String activation_id);
        ( "scopeId",
          `String (activation_scope_for_construct event.site_id) );
        ("functionOccurrenceId", `String event.occurrence_id);
        ("functionConstructId", `String event.site_id);
        ( "closureId",
          match Hashtbl.find_opt activation_closures event.occurrence_id with
          | Some id when not (String.equal id "") -> `String ("closure:" ^ id)
          | Some _ | None -> `Null );
        ( "dynamicParentId",
          Option.fold ~none:`Null
            ~some:(fun id -> `String id)
            dynamic_parent );
        ( "callsiteOccurrenceId",
          Option.fold ~none:`Null
            ~some:(fun (callsite : trace_event) ->
              `String callsite.occurrence_id)
            callsite );
        ( "consumedCallAttemptId",
          Option.fold ~none:`Null
            ~some:(fun occurrence_id -> `String ("attempt:" ^ occurrence_id))
            (consumed_attempt_for_function event) );
        ( "occurrenceIds",
          `List (List.map (fun (id, _, _, _) -> `String id) owned) );
        ("parameterOccurrenceIds", `List (List.map (fun id -> `String id) parameter_ids));
        ("enteredAt", `Int event.sequence);
        ( "outcomeAt",
          Option.fold ~none:`Null
            ~some:(fun returned -> `Int returned.sequence)
            outcome_event );
        ("outcome", outcome event.occurrence_id);
        ( "signature",
          `Assoc
            [
              ("functionKey", `String event.site_id);
              ( "callsiteKey",
                Option.fold ~none:`Null
                  ~some:(fun (callsite : trace_event) ->
                    `String callsite.site_id)
                  callsite );
              ( "parameterFingerprints",
                `List
                  (parameters
                  |> List.filter (fun parameter ->
                      String.equal parameter.occurrence_id event.occurrence_id)
                  |> List.map (fun parameter ->
                      match captured_value parameter with
                      | `Assoc fields ->
                          Option.value ~default:`Null
                            (List.assoc_opt "fingerprint" fields)
                      | _ -> `Null)) );
              ( "outcomeFingerprint",
                Option.fold ~none:`Null
                  ~some:(fun fingerprint -> `String fingerprint)
                  outcome_fingerprint );
            ] );
      ]
  in
  let root_activation_json manifest =
    let activation_id = root_activation_id manifest in
    let owned = occurrences_for_activation activation_id in
    let entered_at =
      match owned with (_, _, sequence, _) :: _ -> sequence | [] -> 0
    in
    let outcome_at, outcome, outcome_fingerprint =
      if trace_truncated then
        ( `Null,
          `Assoc
            [
              ("kind", `String "incomplete");
              ("value", `Null);
              ("source", `String "truncated");
            ],
          `Null )
      else
        ( `Int final_sequence,
          `Assoc
            [
              ("kind", `String "return");
              ( "value",
                `Assoc
                  [
                    ("type", `String "unit");
                    ("display", `String "()");
                    ("fingerprint", `String (Util.digest "unit\000()"));
                    ("complete", `Bool true);
                  ] );
              ("source", `String "runtime");
            ],
          `String (Util.digest "unit\000()") )
    in
    `Assoc
      [
        ("id", `String activation_id);
        ("scopeId", `String manifest.manifest_top_level_scope_id);
        ("functionOccurrenceId", `Null);
        ("functionConstructId", `Null);
        ("closureId", `Null);
        ("dynamicParentId", `Null);
        ("callsiteOccurrenceId", `Null);
        ("consumedCallAttemptId", `Null);
        ( "occurrenceIds",
          `List (List.map (fun (id, _, _, _) -> `String id) owned) );
        ("parameterOccurrenceIds", `List []);
        ("enteredAt", `Int entered_at);
        ("outcomeAt", outcome_at);
        ("outcome", outcome);
        ( "signature",
          `Assoc
            [
              ("functionKey", `String manifest.manifest_unit_name);
              ("callsiteKey", `Null);
              ("parameterFingerprints", `List []);
              ("outcomeFingerprint", outcome_fingerprint);
            ] );
      ]
  in
  let producer_ids (call : trace_event) =
    List.rev !call_attempt_consumptions
    |> List.filter_map (fun consumed ->
        match attempt_occurrence_for_consumption consumed with
        | Some occurrence_id when String.equal occurrence_id call.occurrence_id ->
            Some ("activation:" ^ consumed.occurrence_id)
        | Some _ | None -> None)
  in
  let call_attempt_json (opened : trace_event) =
    let call =
      Hashtbl.find_opt enters opened.occurrence_id
      |> Option.value ~default:opened
    in
    let returned =
      match Hashtbl.find_opt call_attempt_outcomes call.occurrence_id with
      | Some event -> Some event
      | None -> Hashtbl.find_opt outcomes call.occurrence_id
    in
    `Assoc
      [
        ("id", `String ("attempt:" ^ call.occurrence_id));
        ("ownerActivationId", `String (activation_id_for_event call));
        ("callOccurrenceId", `String call.occurrence_id);
        ( "tail",
          `Bool (List.mem call.occurrence_id tail_handoff_occurrences) );
        ("openedAt", `Int opened.sequence);
        ("producerActivationIds", `List (List.map (fun id -> `String id) (producer_ids call)));
        ( "outcomeAt",
          Option.fold ~none:`Null
            ~some:(fun event -> `Int event.sequence)
            returned );
        ("outcome", call_attempt_outcome call.occurrence_id);
      ]
  in
  let call_events =
    List.rev !call_attempt_opens
    |> List.filter (fun opened ->
        match Hashtbl.find_opt enters opened.occurrence_id with
        | Some event -> String.equal event.kind "call"
        | None -> false)
  in
  let closure_json (event : trace_event) =
    let origin_activation_id =
      Option.bind event.parent_id (fun parent_id ->
          Option.map activation_id_for_event (Hashtbl.find_opt enters parent_id))
    in
    `Assoc
      [
        ("id", `String ("closure:" ^ event.occurrence_id));
        ("functionConstructId", `String event.site_id);
        ("createdAt", `Int event.sequence);
        ( "originActivationId",
          Option.fold ~none:`Null ~some:(fun id -> `String id)
            origin_activation_id );
      ]
  in
  let closure_provenance_json (event : trace_event) =
    match String.split_on_char ':' event.detail with
    | [ "derived"; source_id ] ->
        Some
          (`Assoc
            [
              ("closureId", `String ("closure:" ^ event.occurrence_id));
              ("sequence", `Int event.sequence);
              ("kind", `String "derived");
              ("activationId", `Null);
              ("callsiteOccurrenceId", `Null);
              ("sourceClosureId", `String ("closure:" ^ source_id));
            ])
    | _ -> None
  in
  let closure_creations = List.rev !closure_creations in
  let writes =
    List.rev !writes
    |> List.map (fun (event : trace_event) ->
        `Assoc
          [
            ("id", `String ("write:" ^ event.occurrence_id));
            ("sequence", `Int event.sequence);
            ("activationId", `String (activation_id_for_event event));
            ("constructId", `String event.site_id);
            ("operation", `String event.label);
            ("targetId", `Null);
            ("oldValue", `Null);
            ("newValue", captured_value event);
          ])
  in
  `Assoc
    [
      ( "occurrences",
        `List (List.map (fun (_, _, _, json) -> json) all_occurrence_entries) );
      ( "activations",
        `List
          (List.map root_activation_json manifests
          @ List.map function_activation_json function_events) );
      ("closures", `List (List.map closure_json closure_creations));
      ( "closureProvenance",
        `List (List.filter_map closure_provenance_json closure_creations) );
      ("callAttempts", `List (List.map call_attempt_json call_events));
      ("writes", `List writes);
    ]

let execution_artifact_to_json result =
  if not result.ok then `Null
  else
    let traces =
      user_execution_traces result.compiler_manifests result.traces
    in
    let compiler_inputs_digest =
      source_identity ~domain:"dox-compiler-input-v1"
        [ ("\000compiler", [ ("identity", result.compiler) ]) ]
    in
    let mapped_selector_ids = mapped_selector_ids result.source_map_entries in
    let static_program =
      compiler_static_program_to_json
        ~mapped_selector_ids
        ~code_revision_id:result.code_revision_id ~compiler_inputs_digest
        result.compiler_manifests
    in
    let execution =
      normalized_execution_to_json result.compiler_manifests traces
        ~tail_handoff_occurrences:result.tail_handoff_occurrences
        ~trace_truncated:result.trace_truncated
    in
    let final_sequence =
      List.fold_left
        (fun maximum event -> max maximum event.sequence)
        0 traces
    in
    let terminal_without_checksum =
      `Assoc
        ([
           ( "kind",
             `String
               (if result.trace_truncated then "truncated" else "complete") );
           ("finalSequence", `Int final_sequence);
         ]
        @ if result.trace_truncated then [ ("reason", `String "size-limit") ]
          else [])
    in
    let terminal_checksum =
      terminal_without_checksum |> execution_canonical_json
      |> execution_checksum
    in
    let terminal =
      match terminal_without_checksum with
      | `Assoc fields -> `Assoc (fields @ [ ("checksum", `String terminal_checksum) ])
      | _ -> assert false
    in
    let source_maps =
      let entry_to_json entry =
        `Assoc
          [
            ("selectorId", `String entry.map_selector_id);
            ("generatedPath", `String entry.map_generated_path);
            ("startByte", `Int entry.map_start_byte);
            ("endByte", `Int entry.map_end_byte);
            ("documentPath", `String entry.map_document_path);
            ("startUtf16", `Int entry.map_start_utf16);
            ("endUtf16", `Int entry.map_end_utf16);
          ]
      in
      `Assoc
        [
          ("documentRevisionId", `String result.document_revision_id);
          ("codeRevisionId", `String result.code_revision_id);
          ("sourcesDigest", `String result.sources_digest);
          ("extractedCodeDigest", `String result.extracted_code_digest);
          ("entries", `List (List.map entry_to_json result.source_map_entries));
        ]
    in
    let fields =
      [
        ("schemaVersion", `Int 1);
        ("evaluationId", `String result.evaluation_id);
        ("requestCodeDigest", `String result.request_code_digest);
        ( "projectDigest",
          `String result.project_digest );
        ("codeRevisionId", `String result.code_revision_id);
        ("compilerInputsDigest", `String compiler_inputs_digest);
        ("staticProgram", static_program);
        ("sourceMaps", source_maps);
        ("execution", execution);
        ("terminal", terminal);
      ]
    in
    let artifact_checksum =
      `Assoc fields |> execution_canonical_json |> execution_checksum
    in
    `Assoc (fields @ [ ("artifactChecksum", `String artifact_checksum) ])

let to_json result =
  let compiler_inputs_digest =
    source_identity ~domain:"dox-compiler-input-v1"
      [ ("\000compiler", [ ("identity", result.compiler) ]) ]
  in
  let traces =
    user_execution_traces result.compiler_manifests result.traces
  in
  `Assoc
    [
      ("ok", `Bool result.ok);
      ("status", `String result.status);
      ("evaluationId", `String result.evaluation_id);
      ("codeRevisionId", `String result.code_revision_id);
      ("documentVersion", `String result.document_version);
      ( "projectVersion",
        Option.fold ~none:`Null
          ~some:(fun version -> `String version)
          result.project_version );
      ("projectDigest", `String result.project_digest);
      ("startedAt", `String result.started_at);
      ("compiler", `String result.compiler);
      ("signature", `String result.signature);
      ("bindings", `List (List.map binding_to_json result.bindings));
      ("stdout", `String result.stdout);
      ("stderr", `String result.stderr);
      ( "blockOutputs",
        `List (List.map block_output_to_json result.block_outputs) );
      ( "inlineResults",
        `List (List.map inline_result_to_json result.inline_results) );
      ("views", `List (List.map view_to_json result.views));
      ("traces", `List (List.map trace_event_to_json traces));
      ( "compilerManifests",
        `List (List.map compiler_manifest_to_json result.compiler_manifests) );
      ( "staticProgram",
        compiler_static_program_to_json
          ~mapped_selector_ids:(mapped_selector_ids result.source_map_entries)
          ~code_revision_id:result.code_revision_id
          ~compiler_inputs_digest
          result.compiler_manifests );
      ("executionArtifact", execution_artifact_to_json result);
      ("traceTruncated", `Bool result.trace_truncated);
      ("tailHandoffs", `Int result.tail_handoffs);
      ("tailLinkedEnters", `Int result.tail_linked_enters);
      ("tailHandoffOutcomes", `Int result.tail_handoff_outcomes);
      ("diagnostics", `List (List.map diagnostic_to_json result.diagnostics));
      ("durationMs", `Int result.duration_ms);
    ]

let build_artifact_documents ~documents ~entry ~output =
  let directory = Filename.dirname output in
  let source_path = output ^ ".ml" in
  let source_for (document : Document.t) =
    "open Dox_prelude\n" ^ Document.compilation_source document
  in
  match Util.ensure_directory directory with
  | Error message -> Error message
  | Ok () ->
      let target = List.hd (List.rev documents) in
      let build_directory =
        Filename.temp_dir ~temp_dir:directory ".build-" ""
      in
      Fun.protect
        ~finally:(fun () -> remove_temp_directory build_directory)
        (fun () ->
          let sources =
            List.map (fun document -> (document, source_for document)) documents
          in
          match
            compile_document_units ~prelude_source:artifact_prelude ~entry
              ~directory:build_directory ~sources ~target
              ~cancelled:(fun () -> false)
              ()
          with
          | Error diagnostic -> Error diagnostic.message
          | Ok compiled -> (
              match Util.read_file compiled.compiled_executable with
              | Error message -> Error message
              | Ok bytes -> (
                  match Util.write_file output bytes with
                  | Error message -> Error message
                  | Ok () ->
                      Unix.chmod output 0o755;
                      let generated =
                        Printf.sprintf
                          "(* Generated from %s and its qualified module \
                           dependencies. *)\n\
                           open %s\n\
                           let () = %s ()\n"
                          target.Document.path
                          (match
                             Module_path.of_source_path target.Document.path
                           with
                          | Ok module_path ->
                              Module_path.compiler_unit module_path
                          | Error _ -> "Dox__Page_" ^ Util.digest target.path)
                          entry
                      in
                      Result.map
                        (fun () -> (source_path, compiled.compiled_warnings))
                        (Util.write_file source_path generated))))

let build_artifact ~document ~entry ~output =
  build_artifact_documents ~documents:[ document ] ~entry ~output
