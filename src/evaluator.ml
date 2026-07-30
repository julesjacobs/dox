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

type trace_event = {
  sequence : int;
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
  document_version : string;
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
   detail;
  ] ->
      Option.bind (int_of_string_opt line) (fun line ->
          Option.bind (int_of_string_opt column) (fun column ->
              Option.bind (int_of_string_opt end_line) (fun end_line ->
                  Option.map
                    (fun end_column ->
                      {
                        sequence;
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
                        detail;
                      })
                    (int_of_string_opt end_column))))
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
         if String.equal kind "observe" then
           match trace_event sequence content with
           | Some event -> (views, event :: traces)
           | None -> (views, traces)
         else ({ sequence; kind; id; content } :: views, traces))
       ([], [])
  |> fun (views, traces) -> (List.rev views, List.rev traces)

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

let type_info_of_json ~line_offset target json =
  let open Yojson.Safe.Util in
  match json |> member "class" |> to_string_option with
  | Some "return" -> (
      match json |> member "value" |> to_list with
      | [] -> Ok None
      | value :: _ ->
          let physical_start_line, start_column =
            position_member "start" value
          in
          let physical_end_line, end_column = position_member "end" value in
          let start_line = physical_start_line - line_offset in
          let end_line = physical_end_line - line_offset in
          let expression =
            expression_at target ~start_line ~start_column ~end_line ~end_column
          in
          let start_column =
            source_column_of_merlin target start_line start_column
          in
          let end_column = source_column_of_merlin target end_line end_column in
          let type_ = value |> member "type" |> to_string in
          Ok
            (Some
               {
                 expression;
                 type_;
                 start_line;
                 start_column;
                 end_line;
                 end_column;
               }))
  | Some class_ ->
      Error
        (Printf.sprintf "Merlin returned %s: %s" class_
           (json |> member "value" |> Yojson.Safe.to_string))
  | None -> Error "Merlin returned an invalid response."

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
     let version =
       run_process ~timeout_seconds:2. ~output_limit:16_384 path [ "-version" ]
     in
     if successful version.status && not version.output_limited then
       path ^ " " ^ String.trim version.stdout
     else path ^ " (version unavailable)")

let compiler_identity () = Lazy.force compiler_identity_value

let artifact_builder_identity () =
  Util.digest
    ("dox-artifact-v2\000" ^ compiler_identity () ^ "\000unix.cma\000"
   ^ artifact_prelude)

let remove_temp_directory directory =
  (try
     Sys.readdir directory
     |> Array.iter (fun name ->
         try Sys.remove (Filename.concat directory name)
         with Sys_error _ -> ())
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

type inline_marker = {
  virtual_path : string;
  document_path : string;
  inline_expression : Document.inline_expression;
}

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
                  output_string stderr %S; flush stderr\n\
                  # %d %S\n\
                  %s\n\
                  # 1 %S\n\
                  let () = flush stdout; output_string stdout %S; flush \
                  stdout; flush stderr; output_string stderr %S; flush stderr\n"
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

let compile_document_units ?(prelude_source = prelude) ?entry ~directory
    ~sources ~target ~cancelled () =
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
  let compile arguments =
    run_process ~cwd:directory ~timeout_seconds:12. ~cancelled
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
                           let result =
                             compile
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
                          ( signature.stdout,
                            executable,
                            signature.stderr :: linked.stderr :: warnings
                            |> List.filter (fun value ->
                                not (String.equal (String.trim value) ""))
                            |> String.concat "\n" ))))

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
            && event.parent_id = None
            && (String.equal event.phase "return"
               || String.equal event.phase "raise"))
          traces
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

let evaluate_documents ?project_version ?(cancelled = fun () -> false)
    ~documents ~target () =
  let started = Unix.gettimeofday () in
  let started_at = Util.timestamp () in
  let evaluation_id =
    Util.random_token () |> fun token -> String.sub token 0 24
  in
  let directory = Filename.temp_dir "dox-eval-" "" in
  let event_path = Filename.concat directory "events" in
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
      ~finally:(fun () -> remove_temp_directory directory)
      (fun () ->
        if cancelled () then raise Cancelled;
        if
          List.exists
            (fun diagnostic -> String.equal diagnostic.severity "error")
            parse_diagnostics
        then ("invalid", "", "", "", [], [], parse_diagnostics)
        else
          match
            compile_document_units ~directory ~sources:document_sources ~target
              ~cancelled ()
          with
          | Error compilation ->
              ("compile-error", "", "", "", [], [], [ compilation ])
          | Ok (signature, executable, warnings) ->
              let runtime =
                run_process ~timeout_seconds:5. ~cancelled
                  ~environment:[ ("DOCLANG_EVENT_PATH", event_path) ]
                  ~extra_output_paths:[ event_path ] (ocamlrun ())
                  [ executable ]
              in
              let views, traces =
                read_file_prefix event_path 2_000_000 |> parse_runtime_events
              in
              let traces = List.map (normalize_trace_event documents) traces in
              let warning_diagnostics =
                if String.equal warnings "" then []
                else
                  [ diagnostic ~stage:"compile" ~severity:"warning" warnings ]
              in
              if successful runtime.status && not runtime.output_limited then
                ( "ready",
                  signature,
                  runtime.stdout,
                  runtime.stderr,
                  views,
                  traces,
                  warning_diagnostics )
              else
                ( (if runtime.timed_out then "timed-out"
                   else if runtime.output_limited then "output-limited"
                   else "runtime-error"),
                  signature,
                  runtime.stdout,
                  runtime.stderr,
                  views,
                  traces,
                  warning_diagnostics
                  @ [ process_failure ~stage:"runtime" runtime ] ))
  in
  let status, signature, stdout, stderr, views, traces, diagnostics =
    evaluated
  in
  let inline_results = inline_results inline_markers traces diagnostics in
  let traces = without_inline_trace_trees inline_markers traces in
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
  {
    ok = String.equal status "ready";
    status;
    evaluation_id;
    document_version = target.Document.version;
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
      ("detail", `String event.detail);
    ]

let to_json result =
  `Assoc
    [
      ("ok", `Bool result.ok);
      ("status", `String result.status);
      ("evaluationId", `String result.evaluation_id);
      ("documentVersion", `String result.document_version);
      ( "projectVersion",
        Option.fold ~none:`Null
          ~some:(fun version -> `String version)
          result.project_version );
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
      ("traces", `List (List.map trace_event_to_json result.traces));
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
          | Ok (_, executable, warnings) -> (
              match Util.read_file executable with
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
                        (fun () -> (source_path, warnings))
                        (Util.write_file source_path generated))))

let build_artifact ~document ~entry ~output =
  build_artifact_documents ~documents:[ document ] ~entry ~output
