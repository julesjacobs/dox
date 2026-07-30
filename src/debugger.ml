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

let event_addresses output =
  let event =
    Str.regexp
      "^[ \t]*\\([0-9]+\\):[ \t]+\\([0-9]+\\)[ \t]+[0-9-]+[ \t]+\\([^ \t\r\n\
       ]+\\)"
  in
  output |> String.split_on_char '\n'
  |> List.filter_map (fun line ->
      if Str.string_match event line 0 then
        let kind = Str.matched_group 3 line in
        if Util.starts_with ~prefix:"pseudo" kind then None
        else Some (Str.matched_group 1 line ^ ":" ^ Str.matched_group 2 line)
      else None)
  |> List.sort_uniq String.compare

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

let normalize_position documents path line column =
  match document_for_path documents path with
  | None -> (path, line, column)
  | Some document ->
      (path, line, Evaluator.source_column_of_merlin document line column)

let display_module documents path fallback =
  match document_for_path documents path with
  | None -> fallback
  | Some document -> (
      match Module_path.of_source_path document.path with
      | Ok module_path -> module_path
      | Error _ -> fallback)

let parse_frames documents details =
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
          normalize_position documents path source_line source_column
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

let parse_stop documents candidates output index =
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
      let frames = parse_frames documents details in
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

let trace_timeline documents event_path stops =
  let _, traces =
    Evaluator.read_file_prefix event_path 2_000_000
    |> Evaluator.parse_runtime_events
  in
  let traces = List.map (Evaluator.normalize_trace_event documents) traces in
  let available = ref stops in
  let mappings = Hashtbl.create 64 in
  let events =
    List.map
      (fun (trace : Evaluator.trace_event) ->
        let rec choose skipped = function
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
        (("debuggerTime", Option.fold ~none:`Null ~some:(fun time -> `Int time) time)
        :: fields)
  | json -> json

let start ?(cancelled = fun () -> false) ~documents ~target () =
  let started = Unix.gettimeofday () in
  let directory = Filename.temp_dir "dox-debug-" "" in
  let event_path = Filename.concat directory "debug-events" in
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
      let sources, _, _ =
        Evaluator.instrumented_compilation_source evaluation_id documents target
      in
      match
        Evaluator.compile_document_units
          ~environment:[ ("DOX_DEBUG_ALL_FUNCTIONS", "1") ]
          ~directory ~sources ~target ~cancelled ()
      with
      | Error diagnostic -> Error diagnostic.Evaluator.message
      | Ok (_, executable, _) ->
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
              event_addresses (info.stdout ^ "\n" ^ info.stderr)
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
                Printf.bprintf commands "shell echo DOX_DEBUG_BEGIN_%d\n" index;
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
                  ~environment:[ ("DOCLANG_EVENT_PATH", event_path) ]
                  ~extra_output_paths:[ event_path ] ~timeout_seconds:12.
                  ~cancelled ~output_limit:8_000_000 (debugger ())
                  [ executable ]
              in
              let output = replay.stdout ^ "\n" ^ replay.stderr in
              let all_stops =
                List.init command_limit Fun.id
                |> List.filter_map (parse_stop documents candidates output)
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
                  trace_timeline documents event_path stops
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
                           (List.map trace_event_at_time_to_json call_events) );
                       ("truncated", `Bool truncated);
                       ("durationMs", `Int duration_ms);
                     ]))
