type local = { name : string; type_ : string; value : string }

type frame = {
  index : int;
  module_ : string;
  path : string;
  line : int;
  column : int;
}

type stop = {
  time : int;
  module_ : string;
  path : string;
  line : int;
  column : int;
  frames : frame list;
  locals : local list;
}

type query_event = {
  sequence : int;
  phase : string;
  occurrence_id : string;
  parent_id : string option;
  kind : string;
  label : string;
  path : string;
  line : int;
  column : int;
  end_line : int;
  end_column : int;
  type_ : string;
  detail : string;
  debugger_time : int option;
}

let debugger () =
  match Sys.getenv_opt "OCAMLDEBUG" with
  | Some path -> path
  | None ->
      let candidate =
        Filename.concat (Filename.dirname (Evaluator.compiler ())) "ocamldebug"
      in
      if Sys.file_exists candidate then candidate else "ocamldebug"

let unit_name (document : Document.t) =
  match Module_path.of_source_path document.path with
  | Ok module_path -> Module_path.compiler_unit module_path
  | Error _ -> "Dox__Page_" ^ Util.digest document.path

let keywords =
  [
    "and";
    "as";
    "assert";
    "begin";
    "class";
    "constraint";
    "do";
    "done";
    "downto";
    "else";
    "end";
    "exception";
    "external";
    "false";
    "for";
    "fun";
    "function";
    "functor";
    "if";
    "in";
    "include";
    "inherit";
    "initializer";
    "lazy";
    "let";
    "match";
    "method";
    "module";
    "mutable";
    "new";
    "nonrec";
    "object";
    "of";
    "open";
    "or";
    "private";
    "rec";
    "sig";
    "struct";
    "then";
    "to";
    "true";
    "try";
    "type";
    "val";
    "virtual";
    "when";
    "while";
    "with";
  ]

let local_candidates documents =
  let seen = Hashtbl.create 64 in
  let names = ref [] in
  let add name =
    if
      (not (String.equal name "_"))
      && (not (List.mem name keywords))
      && (not (Hashtbl.mem seen name))
      && List.length !names < 32
    then (
      Hashtbl.add seen name ();
      names := name :: !names)
  in
  let identifier = Str.regexp "[a-z_][A-Za-z0-9_']*" in
  let add_identifiers source =
    let cursor = ref 0 in
    try
      while true do
        let start = Str.search_forward identifier source !cursor in
        let finish = Str.match_end () in
        let before =
          start = 0
          ||
          match source.[start - 1] with
          | 'a' .. 'z' | 'A' .. 'Z' | '0' .. '9' | '_' | '\'' -> false
          | _ -> true
        in
        if before then add (Str.matched_string source);
        cursor := max (start + 1) finish
      done
    with Not_found -> ()
  in
  let declaration =
    Str.regexp
      "\\b\\(let\\|and\\)[ \t]+\\(rec[ \t]+\\)?@?\\([a-z_][A-Za-z0-9_']*\\)"
  in
  let fun_parameters = Str.regexp "\\bfun[ \t]+\\(.+\\)[ \t]+->" in
  List.iter
    (fun (document : Document.t) ->
      List.iter
        (function
          | Document.Code { source; kind = Document.Program; _ } ->
              source |> String.split_on_char '\n'
              |> List.iter (fun line ->
                  (try
                     ignore (Str.search_forward declaration line 0);
                     add (Str.matched_group 3 line);
                     let after_name = Str.match_end () in
                     match String.index_from_opt line after_name '=' with
                     | Some equals ->
                         add_identifiers
                           (String.sub line after_name (equals - after_name))
                     | None -> ()
                   with Not_found -> ());
                  (try
                     ignore (Str.search_forward fun_parameters line 0);
                     add_identifiers (Str.matched_group 1 line)
                   with Not_found -> ());
                  match String.index_opt line '|' with
                  | None -> ()
                  | Some bar -> (
                      match
                        Str.search_forward (Str.regexp "->") line (bar + 1)
                      with
                      | arrow ->
                          add_identifiers
                            (String.sub line (bar + 1) (arrow - bar - 1))
                      | exception Not_found -> ()))
          | _ -> ())
        document.blocks)
    documents;
  List.rev !names

type event_address = {
  address : string;
  character_start : int;
  character_end : int;
  kind : string;
}

let event_addresses ?character_range output =
  let event =
    Str.regexp
      "^[ \t]*\\([0-9]+\\):[ \t]+\\([0-9]+\\)[ \
       \t]+\\(-?[0-9]+\\)-\\(-?[0-9]+\\)[ \t]+\\([^ \t\r\n\
       ]+\\)"
  in
  let parsed =
    output |> String.split_on_char '\n'
    |> List.filter_map (fun line ->
        if Str.string_match event line 0 then
          let kind = Str.matched_group 5 line in
          if Util.starts_with ~prefix:"pseudo" kind then None
          else
            Some
              {
                address =
                  Str.matched_group 1 line ^ ":" ^ Str.matched_group 2 line;
                character_start = int_of_string (Str.matched_group 3 line);
                character_end = int_of_string (Str.matched_group 4 line);
                kind;
              }
        else None)
  in
  let selected =
    match character_range with
    | None -> parsed
    | Some (character_start, character_end) ->
        let exact =
          List.filter
            (fun event ->
              event.character_start = character_start
              && event.character_end = character_end)
            parsed
        in
        let after =
          List.filter
            (fun event -> Util.starts_with ~prefix:"after" event.kind)
            exact
        in
        if after <> [] then after else if exact <> [] then exact else parsed
  in
  selected
  |> List.map (fun event -> event.address)
  |> List.sort_uniq String.compare

let compiled_character_range directory (target : Document.t)
    (probe : Evaluator.type_info option) =
  match probe with
  | None -> None
  | Some probe -> (
      let path =
        Filename.concat directory
          (String.uncapitalize_ascii (unit_name target) ^ ".ml")
      in
      match Util.read_file path with
      | Error _ -> None
      | Ok source ->
          let directive =
            Str.regexp "^[ \t]*#[ \t]+\\([0-9]+\\)[ \t]+\"\\([^\"]+\\)\""
          in
          let logical_path = ref "" in
          let logical_line = ref 1 in
          let physical_offset = ref 0 in
          let start = ref None in
          let finish = ref None in
          source |> String.split_on_char '\n'
          |> List.iter (fun text ->
              if Str.string_match directive text 0 then (
                logical_line := int_of_string (Str.matched_group 1 text);
                logical_path := Str.matched_group 2 text)
              else (
                if String.equal !logical_path target.path then (
                  if !logical_line = probe.start_line then
                    start :=
                      Some
                        (!physical_offset
                        + max 0
                            (probe.start_column
                            - Evaluator.source_indentation target
                                probe.start_line));
                  if !logical_line = probe.end_line then
                    finish :=
                      Some
                        (!physical_offset
                        + max 0
                            (probe.end_column
                            - Evaluator.source_indentation target probe.end_line
                            )));
                incr logical_line);
              physical_offset := !physical_offset + String.length text + 1);
          Option.bind !start (fun start ->
              Option.map (fun finish -> (start, finish)) !finish))

let substring_between source left right =
  let left_regexp = Str.regexp_string left in
  let right_regexp = Str.regexp_string right in
  try
    let left_start = Str.search_forward left_regexp source 0 in
    let content_start = left_start + String.length left in
    let right_start = Str.search_forward right_regexp source content_start in
    Some (String.sub source content_start (right_start - content_start))
  with Not_found -> None

let document_for_path documents path =
  List.find_opt
    (fun (document : Document.t) -> String.equal document.path path)
    documents

let inline_source_prefix = "let () = try ignore (@("

let normalize_position documents inline_markers path line column =
  match document_for_path documents path with
  | None -> (
      match Evaluator.inline_marker_for_path inline_markers path with
      | None -> (path, line, column)
      | Some marker ->
          let expression = marker.Evaluator.inline_expression in
          let relative_column =
            if line = 1 then max 0 (column - String.length inline_source_prefix)
            else 0
          in
          let byte_column =
            expression.column_start
            + min (String.length expression.expression) relative_column
          in
          let display_column =
            match document_for_path documents marker.document_path with
            | None -> byte_column
            | Some document -> (
                match Evaluator.source_line document.source expression.line with
                | None -> byte_column
                | Some source ->
                    Evaluator.utf16_column_of_utf8_byte source byte_column)
          in
          (marker.document_path, expression.line, display_column))
  | Some document ->
      (path, line, Evaluator.source_column_of_merlin document line column)

let display_module documents path fallback =
  match document_for_path documents path with
  | None -> fallback
  | Some document -> (
      match Module_path.of_source_path document.path with
      | Ok module_path -> module_path
      | Error _ -> fallback)

let parse_frames documents inline_markers details =
  let regexp =
    Str.regexp
      "^#\\([0-9]+\\)[ \t]+\\([^ \t]+\\)[ \
       \t]+\\(.+\\):\\([0-9]+\\):\\([0-9]+\\)$"
  in
  details |> String.split_on_char '\n'
  |> List.filter_map (fun raw_line ->
      let line =
        if Util.starts_with ~prefix:"(ocd) " raw_line then
          String.sub raw_line 6 (String.length raw_line - 6)
        else raw_line
      in
      if Str.string_match regexp line 0 then
        let index = int_of_string (Str.matched_group 1 line) in
        let module_ = Str.matched_group 2 line in
        let path = Str.matched_group 3 line in
        let source_line = int_of_string (Str.matched_group 4 line) in
        let source_column = int_of_string (Str.matched_group 5 line) in
        let path, source_line, source_column =
          normalize_position documents inline_markers path source_line
            source_column
        in
        if Option.is_none (document_for_path documents path) then None
        else
          Some
            {
              index;
              module_ = display_module documents path module_;
              path;
              line = source_line;
              column = source_column;
            }
      else None)

let parse_locals candidates details =
  candidates
  |> List.filter_map (fun name ->
      let regexp =
        Str.regexp
          ("(ocd) " ^ Str.quote name
         ^ ":[ \t]*\\([^=\r\n]+\\)[ \t]*=[ \t]*\\([^\r\n]+\\)")
      in
      try
        ignore (Str.search_forward regexp details 0);
        Some
          {
            name;
            type_ = String.trim (Str.matched_group 1 details);
            value = String.trim (Str.matched_group 2 details);
          }
      with Not_found -> None)

let parse_stop documents inline_markers candidates output index =
  let begin_marker = Printf.sprintf "DOX_DEBUG_BEGIN_%d" index in
  let data_marker = Printf.sprintf "DOX_DEBUG_DATA_%d" index in
  let end_marker = Printf.sprintf "DOX_DEBUG_END_%d" index in
  match
    ( substring_between output begin_marker data_marker,
      substring_between output data_marker end_marker )
  with
  | Some run, Some details -> (
      let time_regexp =
        Str.regexp
          "Time:[ \t]*\\([0-9]+\\)[ \t]*-[^\r\n]*module[ \t]+\\([^ \t\r\n]+\\)"
      in
      let frames = parse_frames documents inline_markers details in
      if not (Str.string_match (Str.regexp ".*") run 0) then None
      else
        try
          ignore (Str.search_forward time_regexp run 0);
          let time = int_of_string (Str.matched_group 1 run) in
          let _debugger_module = Str.matched_group 2 run in
          match frames with
          | [] -> None
          | first :: _ ->
              Some
                {
                  time;
                  module_ = first.module_;
                  path = first.path;
                  line = first.line;
                  column = first.column;
                  frames;
                  locals = parse_locals candidates details;
                }
        with Not_found -> None)
  | _ -> None

let frame_to_json frame =
  `Assoc
    [
      ("index", `Int frame.index);
      ("module", `String frame.module_);
      ("path", `String frame.path);
      ("line", `Int frame.line);
      ("column", `Int frame.column);
    ]

let local_to_json local =
  `Assoc
    [
      ("name", `String local.name);
      ("type", `String local.type_);
      ("value", `String local.value);
    ]

let stop_to_json stop =
  `Assoc
    [
      ("time", `Int stop.time);
      ("module", `String stop.module_);
      ("path", `String stop.path);
      ("line", `Int stop.line);
      ("column", `Int stop.column);
      ("frames", `List (List.map frame_to_json stop.frames));
      ("locals", `List (List.map local_to_json stop.locals));
    ]

let normalize_trace_event documents inline_markers
    (event : Evaluator.trace_event) =
  let path, source_line, source_column =
    normalize_position documents inline_markers event.path event.source_line
      event.source_column
  in
  let _, source_end_line, source_end_column =
    normalize_position documents inline_markers event.path event.source_end_line
      event.source_end_column
  in
  {
    event with
    path;
    source_line;
    source_column;
    source_end_line;
    source_end_column;
  }

let trace_timeline documents inline_markers event_path (stops : stop list) =
  let _, traces =
    Evaluator.read_file_prefix event_path 2_000_000
    |> Evaluator.parse_runtime_events
  in
  let traces = List.map (normalize_trace_event documents inline_markers) traces in
  let available : stop list ref = ref stops in
  let mappings = Hashtbl.create 64 in
  let events =
    List.map
      (fun (trace : Evaluator.trace_event) ->
        let rec choose (skipped : stop list) (remaining : stop list) =
          match remaining with
          | [] -> None
          | stop :: rest ->
              if
                String.equal stop.path trace.path
                && stop.line >= trace.source_line
                && stop.line <= trace.source_end_line
              then (
                available := List.rev_append skipped rest;
                Some stop)
              else choose (stop :: skipped) rest
        in
        let time = Option.map (fun stop -> stop.time) (choose [] !available) in
        if
          String.equal trace.phase "enter"
          && not (Hashtbl.mem mappings trace.occurrence_id)
        then
          Option.iter
            (fun time -> Hashtbl.add mappings trace.occurrence_id time)
            time;
        (trace, time))
      traces
  in
  (Hashtbl.to_seq mappings |> List.of_seq, events)

let trace_event_at_time_to_json (event, time) =
  match Evaluator.trace_event_to_json event with
  | `Assoc fields ->
      `Assoc
        (( "debuggerTime",
           Option.fold ~none:`Null ~some:(fun time -> `Int time) time )
        :: fields)
  | json -> json

let probe_environment (target : Document.t) (probe : Evaluator.type_info option)
    =
  match probe with
  | None -> []
  | Some probe ->
      let compiler_column line column =
        max 0 (column - Evaluator.source_indentation target line)
      in
      [
        ( "DOX_DEBUG_EXPRESSION",
          String.concat "\x1f"
            [
              target.path;
              string_of_int probe.start_line;
              string_of_int
                (compiler_column probe.start_line probe.start_column);
              string_of_int probe.end_line;
              string_of_int (compiler_column probe.end_line probe.end_column);
            ] );
      ]

let _legacy_start ?(cancelled = fun () -> false) ?probe ~documents ~target () =
  let started = Unix.gettimeofday () in
  let directory = Filename.temp_dir "dox-debug-" "" in
  let event_path = Filename.concat directory "execution-events" in
  let trace_path = Filename.concat directory "execution-trace" in
  let replay_event_path = Filename.concat directory "debug-events" in
  Fun.protect
    ~finally:(fun () -> Evaluator.remove_temp_directory directory)
    (fun () ->
      List.iter
        (fun (document : Document.t) ->
          match Util.validate_relative_path document.path with
          | Error _ -> ()
          | Ok () ->
              let source_path = Filename.concat directory document.path in
              ignore (Util.ensure_directory (Filename.dirname source_path));
              ignore (Util.write_file source_path document.source))
        documents;
      let evaluation_id = "debug-" ^ String.sub (Util.random_token ()) 0 16 in
      let sources, _, inline_markers =
        Evaluator.instrumented_compilation_source evaluation_id documents target
      in
      match
        Evaluator.compile_document_units
          ~environment:
            ([ ("DOX_DEBUG_ALL_FUNCTIONS", "1") ]
            @ probe_environment target probe)
          ~directory ~sources ~target ~cancelled ()
      with
      | Error diagnostic -> Error diagnostic.Evaluator.message
      | Ok (_, executable, _) ->
          let execution =
            Evaluator.run_process ~cwd:directory
              ~environment:
                [
                  ("DOCLANG_EVENT_PATH", event_path);
                  ("DOCLANG_TRACE_PATH", trace_path);
                ]
              ~extra_output_paths:[ event_path ] ~timeout_seconds:8. ~cancelled
              ~output_limit:2_000_000 (Evaluator.ocamlrun ()) [ executable ]
          in
          if not (Evaluator.successful execution.status) then
            Error
              ("Could not capture the complete execution. "
              ^ String.trim (execution.stdout ^ "\n" ^ execution.stderr))
          else
            let units = List.map unit_name documents in
            let info_commands =
              String.concat ""
                (List.map (fun unit -> "info events " ^ unit ^ "\n") units)
              ^ "quit\n"
            in
            let info =
              Evaluator.run_process ~cwd:directory ~stdin:info_commands
                ~timeout_seconds:5. ~cancelled ~output_limit:1_000_000
                (debugger ()) [ executable ]
            in
            if not (Evaluator.successful info.status) then
              Error
                ("Could not inspect bytecode events. "
                ^ String.trim (info.stdout ^ "\n" ^ info.stderr))
            else
              let addresses =
                event_addresses
                  ?character_range:
                    (compiled_character_range directory target probe)
                  (info.stdout ^ "\n" ^ info.stderr)
              in
              if addresses = [] then
                Error
                  ("No debuggable OCaml events were found. "
                  ^ String.trim (info.stdout ^ "\n" ^ info.stderr))
              else
                let candidates = local_candidates documents in
                let max_stops = 240 in
                let command_limit = max_stops + 40 in
                let commands = Buffer.create 131_072 in
                Buffer.add_string commands
                  "set print_depth 4\nset print_length 24\n";
                List.iter
                  (fun address ->
                    Buffer.add_string commands ("break " ^ address ^ "\n"))
                  addresses;
                for index = 0 to command_limit - 1 do
                  Printf.bprintf commands "shell echo DOX_DEBUG_BEGIN_%d\n"
                    index;
                  Buffer.add_string commands "run\n";
                  Printf.bprintf commands "shell echo DOX_DEBUG_DATA_%d\n" index;
                  Buffer.add_string commands "backtrace\n";
                  List.iter
                    (fun name ->
                      Buffer.add_string commands ("print " ^ name ^ "\n"))
                    candidates;
                  Printf.bprintf commands "shell echo DOX_DEBUG_END_%d\n" index
                done;
                Buffer.add_string commands "quit\n";
                let replay =
                  Evaluator.run_process ~cwd:directory
                    ~stdin:(Buffer.contents commands)
                    ~environment:[ ("DOCLANG_EVENT_PATH", replay_event_path) ]
                    ~extra_output_paths:[ replay_event_path ]
                    ~timeout_seconds:12. ~cancelled ~output_limit:8_000_000
                    (debugger ()) [ executable ]
                in
                let output = replay.stdout ^ "\n" ^ replay.stderr in
                let all_stops =
                  List.init command_limit Fun.id
                  |> List.filter_map
                       (parse_stop documents inline_markers candidates output)
                  |> List.sort_uniq (fun left right ->
                      Int.compare left.time right.time)
                in
                let truncated = List.length all_stops > max_stops in
                let stops =
                  List.filteri (fun index _ -> index < max_stops) all_stops
                in
                if stops = [] then
                  Error
                    ("The program finished without reaching a source event. "
                   ^ String.trim output)
                else
                  let mappings, call_events =
                    trace_timeline documents inline_markers trace_path stops
                  in
                  let duration_ms =
                    int_of_float ((Unix.gettimeofday () -. started) *. 1000.)
                  in
                  Ok
                    (`Assoc
                       [
                         ("timeline", `List (List.map stop_to_json stops));
                         ( "traceTimes",
                           `Assoc
                             (List.map
                                (fun (occurrence, time) ->
                                  (occurrence, `Int time))
                                mappings) );
                         ( "callEvents",
                           `List
                             (List.map trace_event_at_time_to_json call_events)
                         );
                         ("truncated", `Bool truncated);
                         ("durationMs", `Int duration_ms);
                       ]))

(* Execution inspection is a projection of the trace captured by ordinary
   evaluation. It must not run ocamldebug or reconstruct source ownership from
   sampled bytecode stops. *)
let start ?(cancelled = fun () -> false) ?probe:_ ~documents ~target () =
  let evaluation =
    Evaluator.evaluate_documents ~cancelled ~documents ~target ()
  in
  if not evaluation.ok then
    Error
      (match evaluation.diagnostics with
      | diagnostic :: _ -> diagnostic.message
      | [] -> "The document did not produce an execution trace.")
  else
    Ok
      (`Assoc
         [
           ("timeline", `List []);
           ( "callEvents",
             `List (List.map Evaluator.trace_event_to_json evaluation.traces) );
           ("truncated", `Bool evaluation.trace_truncated);
           ("durationMs", `Int evaluation.duration_ms);
         ])

let query_event_of_json json =
  let open Yojson.Safe.Util in
  try
    Some
      {
        sequence = json |> member "sequence" |> to_int;
        phase = json |> member "phase" |> to_string;
        occurrence_id = json |> member "occurrenceId" |> to_string;
        parent_id = json |> member "parentId" |> to_string_option;
        kind = json |> member "kind" |> to_string;
        label = json |> member "label" |> to_string;
        path = json |> member "path" |> to_string;
        line = json |> member "line" |> to_int;
        column = json |> member "column" |> to_int;
        end_line = json |> member "endLine" |> to_int;
        end_column = json |> member "endColumn" |> to_int;
        type_ = json |> member "type" |> to_string;
        detail = json |> member "detail" |> to_string;
        debugger_time = json |> member "debuggerTime" |> to_int_option;
      }
  with Yojson.Safe.Util.Type_error _ -> None

let query_events debugger =
  let open Yojson.Safe.Util in
  debugger |> member "callEvents" |> to_list
  |> List.filter_map query_event_of_json

let query_stops debugger =
  let open Yojson.Safe.Util in
  debugger |> member "timeline" |> to_list

let event_contains (probe : Evaluator.type_info) (event : query_event) =
  (not (String.equal event.kind "function"))
  && (not (String.equal event.kind "parameter"))
  && event.line = probe.start_line
  && event.column = probe.start_column
  && event.end_line = probe.end_line
  && event.end_column = probe.end_column

let event_outcome (events : query_event list) (enter : query_event) =
  match
    events
    |> List.filter (fun event ->
        String.equal event.occurrence_id enter.occurrence_id
        && (String.equal event.phase "return"
           || String.equal event.phase "raise"))
    |> List.sort (fun left right -> Int.compare right.sequence left.sequence)
  with
  | event :: _ -> Some event
  | [] -> None

let rec owner_call (events : query_event list) (event : query_event) =
  match event.parent_id with
  | None -> None
  | Some parent_id -> (
      match
        events
        |> List.find_opt (fun candidate ->
            String.equal candidate.occurrence_id parent_id
            && String.equal candidate.phase "enter")
      with
      | None -> None
      | Some parent when String.equal parent.kind "function" -> Some parent
      | Some parent -> owner_call events parent)

let call_breadcrumb (events : query_event list) call =
  let rec collect accumulator (event : query_event) =
    let accumulator =
      if String.equal event.kind "function" then event :: accumulator
      else accumulator
    in
    match event.parent_id with
    | None -> accumulator
    | Some parent_id -> (
        match
          events
          |> List.find_opt (fun candidate ->
              String.equal candidate.occurrence_id parent_id
              && String.equal candidate.phase "enter")
        with
        | None -> accumulator
        | Some parent -> collect accumulator parent)
  in
  match call with None -> [] | Some call -> collect [] call

let query_call_to_json (event : query_event) =
  `Assoc
    [
      ("id", `String event.occurrence_id);
      ("label", `String event.label);
      ("path", `String event.path);
      ("line", `Int event.line);
      ("column", `Int event.column);
    ]

let stop_time stop =
  let open Yojson.Safe.Util in
  stop |> member "time" |> to_int_option

let stop_path stop =
  let open Yojson.Safe.Util in
  stop |> member "path" |> to_string_option

let stop_line stop =
  let open Yojson.Safe.Util in
  stop |> member "line" |> to_int_option

let stop_column stop =
  let open Yojson.Safe.Util in
  stop |> member "column" |> to_int_option

let stop_depth stop =
  let open Yojson.Safe.Util in
  match stop |> member "frames" with
  | `List frames -> List.length frames
  | _ -> 0

let call_parameters (events : query_event list) call =
  match call with
  | None -> []
  | Some call ->
      events
      |> List.filter (fun event ->
          String.equal event.occurrence_id call.occurrence_id
          && String.equal event.phase "parameter")

let contains_substring source substring =
  try
    ignore (Str.search_forward (Str.regexp_string substring) source 0);
    true
  with Not_found -> false

let stop_matches_parameters (parameters : query_event list) stop =
  let open Yojson.Safe.Util in
  let locals = stop |> member "locals" |> to_list in
  List.for_all
    (fun parameter ->
      locals
      |> List.exists (fun local ->
          Option.equal String.equal
            (local |> member "name" |> to_string_option)
            (Some parameter.label)
          &&
          match local |> member "value" |> to_string_option with
          | None -> false
          | Some value ->
              String.equal value parameter.detail
              || contains_substring value parameter.detail
              || contains_substring parameter.detail value))
    parameters

let stop_for_occurrence stops path (probe : Evaluator.type_info) call_depth
    parameters used_times =
  let matching =
    stops
    |> List.filter (fun stop ->
        Option.equal String.equal (stop_path stop) (Some path)
        && stop_depth stop = call_depth + 1
        && stop_matches_parameters parameters stop
        &&
        match stop_time stop with
        | Some time -> not (Hashtbl.mem used_times time)
        | None -> (
            false
            &&
            match stop_line stop with
            | Some line -> line >= probe.start_line && line <= probe.end_line
            | None -> false))
  in
  let matching =
    List.sort
      (fun left right ->
        Int.compare
          (Option.value ~default:max_int (stop_time left))
          (Option.value ~default:max_int (stop_time right)))
      matching
  in
  let after =
    matching
    |> List.find_opt (fun stop ->
        Option.value ~default:(-1) (stop_column stop) >= probe.end_column)
  in
  let selected =
    match after with Some stop -> Some stop | None -> List.nth_opt matching 0
  in
  Option.iter
    (fun stop ->
      Option.iter
        (fun time -> Hashtbl.replace used_times time ())
        (stop_time stop))
    selected;
  selected

let parameter_json (events : query_event list) call =
  match call with
  | None -> []
  | Some call ->
      events
      |> List.filter (fun event ->
          String.equal event.occurrence_id call.occurrence_id
          && String.equal event.phase "parameter")
      |> List.sort (fun left right -> Int.compare left.sequence right.sequence)
      |> List.map (fun event ->
          `Assoc
            [
              ("name", `String event.label);
              ("type", `String event.type_);
              ("value", `String event.detail);
              ("kind", `String "parameter");
            ])

let environment_json events call stop =
  let open Yojson.Safe.Util in
  let parameters = parameter_json events call in
  let parameter_names =
    parameters
    |> List.filter_map (fun parameter ->
        parameter |> member "name" |> to_string_option)
  in
  let locals =
    match call with
    | None -> []
    | Some owner ->
        let seen = Hashtbl.create 16 in
        events
        |> List.filter_map (fun event ->
            if
              String.equal event.phase "enter"
              && (String.equal event.kind "binding"
                 || String.equal event.kind "value")
              && not (List.mem event.label parameter_names)
              && not (Hashtbl.mem seen event.label)
              &&
              match owner_call events event with
              | Some call ->
                  String.equal call.occurrence_id owner.occurrence_id
              | None -> false
            then
              match event_outcome events event with
              | Some outcome when not (String.equal outcome.detail "<function>") ->
                  Hashtbl.add seen event.label ();
                  Some
                    (`Assoc
                       [
                         ("name", `String event.label);
                         ("type", `String outcome.type_);
                         ("value", `String outcome.detail);
                         ("kind", `String "local");
                       ])
              | Some _ | None -> None
            else None)
  in
  ignore stop;
  parameters @ locals

let source_lines (document : Document.t) =
  Array.of_list (String.split_on_char '\n' document.source)

let leading_spaces source =
  let rec loop index =
    if index < String.length source && Char.equal source.[index] ' ' then
      loop (index + 1)
    else index
  in
  loop 0

let function_range (document : Document.t) (call : query_event) =
  let lines = source_lines document in
  let line_count = Array.length lines in
  let start = min (max call.line 1) line_count in
  let definition = lines.(start - 1) in
  let definition_indent = leading_spaces definition in
  let declaration =
    Str.regexp
      "^\\(let\\|and\\|type\\|module\\|exception\\|class\\|external\\)\\b"
  in
  let rec code_block_end number =
    if number > line_count then line_count
    else
      let source = lines.(number - 1) in
      if
        Util.starts_with ~prefix:"    " definition
        && (not (String.equal (String.trim source) ""))
        && not (Util.starts_with ~prefix:"    " source)
      then number - 1
      else if Util.starts_with ~prefix:"```" (String.trim source) then
        number - 1
      else code_block_end (number + 1)
  in
  let block_end = code_block_end (start + 1) in
  let rec declaration_end number =
    if number > block_end then block_end
    else
      let source = lines.(number - 1) in
      let trimmed = String.trim source in
      let indent = leading_spaces source in
      if
        (not (String.equal trimmed ""))
        && indent <= definition_indent
        && Str.string_match declaration (String.trim source) 0
      then number - 1
      else declaration_end (number + 1)
  in
  let rec trim_end number =
    if number > start && String.equal (String.trim lines.(number - 1)) "" then
      trim_end (number - 1)
    else number
  in
  (start, trim_end (declaration_end (start + 1)))

let identifier_span (document : Document.t) ~line ~name ~preferred_column =
  let lines = source_lines document in
  if line < 1 || line > Array.length lines then None
  else
    let source = lines.(line - 1) in
    let matcher = Str.regexp ("\\b" ^ Str.quote name ^ "\\b") in
    let rec collect position matches =
      try
        let start = Str.search_forward matcher source position in
        collect
          (max (start + 1) (Str.match_end ()))
          ((start, Str.match_end ()) :: matches)
      with Not_found -> List.rev matches
    in
    match
      collect 0 []
      |> List.sort (fun (left, _) (right, _) ->
          Int.compare
            (Int.abs (left - preferred_column))
            (Int.abs (right - preferred_column)))
    with
    | span :: _ -> Some span
    | [] -> None

let direct_function_parent events (call : query_event) = owner_call events call

let call_result events (call : query_event) =
  match event_outcome events call with
  | None -> ("running", None, call.type_)
  | Some outcome -> (outcome.phase, Some outcome.detail, outcome.type_)

let result_type type_ =
  match List.rev (Str.split (Str.regexp "[ \t]*->[ \t]*") type_) with
  | result :: _ -> String.trim result
  | [] -> type_

let invocation_call_to_json events (call : query_event) =
  let outcome, value, type_ = call_result events call in
  `Assoc
    [
      ("id", `String call.occurrence_id);
      ("label", `String call.label);
      ("path", `String call.path);
      ("line", `Int call.line);
      ("column", `Int call.column);
      ("endLine", `Int call.end_line);
      ("endColumn", `Int call.end_column);
      ("outcome", `String outcome);
      ("value", Option.fold ~none:`Null ~some:(fun value -> `String value) value);
      ("type", `String (result_type type_));
    ]

let stop_in_invocation events (call : query_event) range stop =
  let open Yojson.Safe.Util in
  let start_line, end_line = range in
  let breadcrumb = call_breadcrumb events (Some call) in
  Option.equal String.equal (stop_path stop) (Some call.path)
  && stop_depth stop = List.length breadcrumb + 1
  && stop_matches_parameters (call_parameters events (Some call)) stop
  &&
  match stop |> member "line" |> to_int_option with
  | Some line -> line >= start_line && line <= end_line
  | None -> false

type invocation_binder = {
  name : string;
  type_ : string;
  value : string;
  kind : string;
  line : int;
  column : int;
  end_column : int;
  sequence : int;
}

let binder_to_json binder =
  `Assoc
    [
      ("name", `String binder.name);
      ("type", `String binder.type_);
      ("value", `String binder.value);
      ("kind", `String binder.kind);
      ("line", `Int binder.line);
      ("column", `Int binder.column);
      ("endColumn", `Int binder.end_column);
    ]

let invocation_binders document events (call : query_event) _stops =
  let binders = ref [] in
  let seen = Hashtbl.create 32 in
  let add binder =
    let key = (binder.line, binder.column, binder.name) in
    if not (Hashtbl.mem seen key) then (
      Hashtbl.add seen key ();
      binders := binder :: !binders)
  in
  call_parameters events (Some call)
  |> List.iter (fun parameter ->
      match
        identifier_span document ~line:call.line ~name:parameter.label
          ~preferred_column:call.column
      with
      | None -> ()
      | Some (column, end_column) ->
          add
            {
              name = parameter.label;
              type_ = parameter.type_;
              value = parameter.detail;
              kind = "parameter";
              line = call.line;
              column;
              end_column;
              sequence = parameter.sequence;
            });
  events
  |> List.filter (fun event ->
      String.equal event.phase "enter"
      && String.equal event.kind "binding"
      &&
      match owner_call events event with
      | Some owner -> String.equal owner.occurrence_id call.occurrence_id
      | None -> false)
  |> List.iter (fun event ->
      match
        ( event_outcome events event,
          identifier_span document ~line:event.line ~name:event.label
            ~preferred_column:event.column )
      with
      | Some outcome, Some (column, end_column) ->
          add
            {
              name = event.label;
              type_ = outcome.type_;
              value = outcome.detail;
              kind = event.kind;
              line = event.line;
              column;
              end_column;
              sequence = event.sequence;
            }
      | _ -> ());
  let range = function_range document call in
  let declarations = Hashtbl.create 32 in
  let lines = source_lines document in
  let start_line, end_line = range in
  let declaration =
    Str.regexp
      "\\b\\(let\\|and\\)[ \t]+\\(rec[ \t]+\\)?@?\\([a-z_][A-Za-z0-9_']*\\)"
  in
  for line = start_line to end_line do
    let source = lines.(line - 1) in
    let position = ref 0 in
    (try
       while true do
         let _ = Str.search_forward declaration source !position in
         let name = Str.matched_group 3 source in
         let column = Str.group_beginning 3 in
         Hashtbl.replace declarations name
           (line, column, Str.group_end 3, "binding");
         position := max (column + 1) (Str.match_end ())
       done
     with Not_found -> ());
    match String.index_opt source '-' with
    | Some arrow
      when arrow + 1 < String.length source && Char.equal source.[arrow + 1] '>'
      -> (
        let before = String.sub source 0 arrow in
        let identifier = Str.regexp "\\b\\([a-z_][A-Za-z0-9_']*\\)\\b" in
        let position = ref 0 in
        try
          while true do
            let _ = Str.search_forward identifier before !position in
            let name = Str.matched_group 1 before in
            let column = Str.group_beginning 1 in
            if
              not
                (List.mem name
                   [
                     "let";
                     "rec";
                     "and";
                     "fun";
                     "function";
                     "when";
                     "true";
                     "false";
                   ])
            then
              Hashtbl.replace declarations name
                (line, column, Str.group_end 1, "pattern");
            position := max (column + 1) (Str.match_end ())
          done
        with Not_found -> ())
    | _ -> ()
  done;
  Hashtbl.iter
    (fun name (line, column, end_column, kind) ->
      if
        not (List.exists (fun binder -> String.equal binder.name name) !binders)
      then
        events
        |> List.find_map (fun event ->
            if
              String.equal event.phase "enter"
              && String.equal event.kind "value"
              && String.equal event.label name
              &&
              match owner_call events event with
              | Some owner ->
                  String.equal owner.occurrence_id call.occurrence_id
              | None -> false
            then
              match event_outcome events event with
              | Some outcome when not (String.equal outcome.detail "<function>") ->
                  Some (outcome.type_, outcome.detail)
              | Some _ | None -> None
            else None)
        |> Option.iter (fun (type_, value) ->
            add
              {
                name;
                type_;
                value;
                kind;
                line;
                column;
                end_column;
                sequence = max_int;
              }))
    declarations;
  !binders
  |> List.sort (fun left right ->
      match Int.compare left.line right.line with
      | 0 -> (
          match Int.compare left.column right.column with
          | 0 -> Int.compare left.sequence right.sequence
          | order -> order)
      | order -> order)

let query_invocation ?(cancelled = fun () -> false) ~documents ~target ~line
    ~column:_ ~occurrence () =
  match start ~cancelled ~documents ~target () with
  | Error message -> Error message
  | Ok debugger -> (
      let events : query_event list = query_events debugger in
      let stops = query_stops debugger in
      let calls : query_event list =
        events
        |> List.filter (fun event ->
            String.equal event.phase "enter"
            && String.equal event.kind "function"
            && String.equal event.path target.path)
      in
      let candidates =
        calls
        |> List.filter (fun call ->
            let start_line, end_line = function_range target call in
            line >= start_line && line <= end_line)
      in
      let sites =
        candidates
        |> List.sort (fun (left : query_event) (right : query_event) ->
            let left_start, left_end = function_range target left in
            let right_start, right_end = function_range target right in
            match Int.compare right_start left_start with
            | 0 -> Int.compare (left_end - left_start) (right_end - right_start)
            | order -> order)
      in
      match sites with
      | [] -> Error "No executed function contains this source position."
      | (site : query_event) :: _ ->
          let siblings =
            calls
            |> List.filter (fun (call : query_event) ->
                String.equal call.label site.label
                && call.line = site.line && call.column = site.column)
            |> List.sort (fun (left : query_event) (right : query_event) ->
                Int.compare left.sequence right.sequence)
          in
          let total = List.length siblings in
          let occurrence = min (max occurrence 1) total in
          let call : query_event = List.nth siblings (occurrence - 1) in
          let parent = direct_function_parent events call in
          let children =
            calls
            |> List.filter (fun (candidate : query_event) ->
                match direct_function_parent events candidate with
                | Some owner ->
                    String.equal owner.occurrence_id call.occurrence_id
                | None -> false)
            |> List.sort (fun (left : query_event) (right : query_event) ->
                Int.compare left.sequence right.sequence)
          in
          let start_line, end_line = function_range target call in
          let binders = invocation_binders target events call stops in
          let open Yojson.Safe.Util in
          Ok
            (`Assoc
               [
                 ("function", invocation_call_to_json events call);
                 ("occurrence", `Int occurrence);
                 ("occurrenceCount", `Int total);
                 ( "range",
                   `Assoc
                     [
                       ("startLine", `Int start_line); ("endLine", `Int end_line);
                     ] );
                 ( "parent",
                   Option.fold ~none:`Null
                     ~some:(invocation_call_to_json events)
                     parent );
                 ( "children",
                   `List (List.map (invocation_call_to_json events) children) );
                 ("binders", `List (List.map binder_to_json binders));
                 ("traceEvents", debugger |> member "callEvents");
                 ("durationMs", debugger |> member "durationMs");
               ]))

let query ?(cancelled = fun () -> false) ~documents ~target ~line ~column () =
  match
    Evaluator.execution_expression_at_with_cancel ~cancelled ~documents ~target
      ~line ~column
  with
  | Error message -> Error message
  | Ok None -> Error "No OCaml expression was found at this source position."
  | Ok (Some probe) -> (
      match start ~cancelled ~probe ~documents ~target () with
      | Error message -> Error message
      | Ok debugger ->
          let events : query_event list = query_events debugger in
          let stops = query_stops debugger in
          let enters =
            events
            |> List.filter (fun (event : query_event) ->
                String.equal event.phase "enter" && event_contains probe event)
            |> List.sort (fun (left : query_event) (right : query_event) ->
                Int.compare left.sequence right.sequence)
          in
          let total = List.length enters in
          let used_stop_times = Hashtbl.create total in
          let occurrences =
            enters
            |> List.mapi (fun index enter ->
                let outcome = event_outcome events enter in
                let call = owner_call events enter in
                let mapped_time =
                  match outcome with
                  | Some event when Option.is_some event.debugger_time ->
                      event.debugger_time
                  | _ -> enter.debugger_time
                in
                let breadcrumb = call_breadcrumb events call in
                let stop =
                  stop_for_occurrence stops target.Document.path probe
                    (List.length breadcrumb)
                    (call_parameters events call)
                    used_stop_times
                in
                let time =
                  match Option.bind stop stop_time with
                  | Some time -> Some time
                  | None ->
                      Some
                        (Option.value ~default:enter.sequence mapped_time)
                in
                `Assoc
                  [
                    ("id", `String enter.occurrence_id);
                    ("index", `Int (index + 1));
                    ("total", `Int total);
                    ( "outcome",
                      `String
                        (Option.fold ~none:"running"
                           ~some:(fun event -> event.phase)
                           outcome) );
                    ( "value",
                      Option.fold ~none:`Null
                        ~some:(fun event -> `String event.detail)
                        outcome );
                    ( "time",
                      Option.fold ~none:`Null
                        ~some:(fun value -> `Int value)
                        time );
                    ( "callId",
                      Option.fold ~none:`Null
                        ~some:(fun event -> `String event.occurrence_id)
                        call );
                    ( "breadcrumb",
                      `List (breadcrumb |> List.map query_call_to_json) );
                    ("environment", `List (environment_json events call stop));
                    ( "stack",
                      Option.fold ~none:(`List [])
                        ~some:(fun stop ->
                          Yojson.Safe.Util.member "frames" stop)
                        stop );
                  ])
          in
          let open Yojson.Safe.Util in
          Ok
            (`Assoc
               [
                 ("expression", Evaluator.type_info_to_json probe);
                 ("occurrences", `List occurrences);
                 ("traceEvents", debugger |> member "callEvents");
                 ("truncated", debugger |> member "truncated");
                 ("durationMs", debugger |> member "durationMs");
               ]))
