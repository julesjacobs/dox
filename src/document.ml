type position = { line_start : int; line_end : int }
type code_kind = Program | Example

type block =
  | Prose of { id : string; source : string; position : position }
  | Code of {
      id : string;
      name : string option;
      source : string;
      source_line : int;
      kind : code_kind;
      position : position;
    }

type definition = {
  name : string;
  kind : string;
  block_id : string;
  line : int;
  references : string list;
}

type issue = {
  severity : string;
  message : string;
  line : int;
  block_id : string option;
}

type inline_expression = {
  id : string;
  expression : string;
  line : int;
  column_start : int;
  column_end : int;
  result_column : int;
}

type page_reference = {
  module_path : string;
  fragment : string option;
  line : int;
  column_start : int;
  column_end : int;
}

type t = {
  path : string;
  source : string;
  version : string;
  title : string;
  blocks : block list;
  definitions : definition list;
  page_references : page_reference list;
  issues : issue list;
}

let block_id kind line = Printf.sprintf "%s-%d" kind line

let fence_info line =
  let trimmed = String.trim line in
  if Util.starts_with ~prefix:"```" trimmed then
    let info =
      String.sub trimmed 3 (String.length trimmed - 3) |> String.trim
    in
    Some info
  else None

let name_from_info info =
  let parts = String.split_on_char ' ' info in
  List.find_map
    (fun part ->
      if Util.starts_with ~prefix:"name=" part then
        Some (String.sub part 5 (String.length part - 5))
      else None)
    parts

let code_block_id info line =
  match name_from_info info with
  | Some name -> "code-" ^ name
  | None -> block_id "code" line

let code_kind info =
  match String.split_on_char ' ' info with
  | "ocaml" :: _ -> Some Program
  | "ocaml-example" :: _ -> Some Example
  | _ -> None

let lines_with_endings source =
  let rec loop start index accumulator =
    if index = String.length source then
      if start = index then List.rev accumulator
      else List.rev (String.sub source start (index - start) :: accumulator)
    else if source.[index] = '\n' then
      loop (index + 1) (index + 1)
        (String.sub source start (index - start + 1) :: accumulator)
    else loop start (index + 1) accumulator
  in
  loop 0 0 []

let indented_code_line line =
  if Util.starts_with ~prefix:"    " line then
    Some (String.sub line 4 (String.length line - 4))
  else None

let markdown_list_item_re = Str.regexp "^[ ]*\\([-+*]\\|[0-9]+[.)]\\)[ \t]+"

let markdown_list_item line =
  let rec leading_spaces index =
    if index < String.length line && line.[index] = ' ' then
      leading_spaces (index + 1)
    else index
  in
  leading_spaces 0 <= 3 && Str.string_match markdown_list_item_re line 0

let parse_blocks source =
  let lines = lines_with_endings source in
  let flush_prose start_line end_line buffer blocks =
    if Buffer.length buffer = 0 then blocks
    else
      Prose
        {
          id = block_id "prose" start_line;
          source = Buffer.contents buffer;
          position = { line_start = start_line; line_end = end_line };
        }
      :: blocks
  in
  let rec outside line_number prose_start prose_buffer blocks issues
      list_context = function
    | [] ->
        ( List.rev
            (flush_prose prose_start
               (max prose_start (line_number - 1))
               prose_buffer blocks),
          List.rev issues )
    | line :: rest -> (
        match fence_info line with
        | Some info -> (
            match code_kind info with
            | Some kind ->
                let blocks =
                  flush_prose prose_start (line_number - 1) prose_buffer blocks
                in
                let code_buffer = Buffer.create 256 in
                inside (line_number + 1) line_number info kind code_buffer
                  blocks issues rest
            | None ->
                Buffer.add_string prose_buffer line;
                outside (line_number + 1) prose_start prose_buffer blocks issues
                  false rest)
        | None -> (
            match indented_code_line line with
            | Some code_line when not list_context ->
                let blocks =
                  flush_prose prose_start (line_number - 1) prose_buffer blocks
                in
                let code_buffer = Buffer.create 256 in
                Buffer.add_string code_buffer code_line;
                inside_indented (line_number + 1) line_number code_buffer blocks
                  issues rest
            | Some _ | None ->
                Buffer.add_string prose_buffer line;
                let next_list_context =
                  if String.equal (String.trim line) "" then false
                  else if markdown_list_item line then true
                  else
                    list_context
                    && (Util.starts_with ~prefix:"    " line
                       || Util.starts_with ~prefix:"\t" line)
                in
                outside (line_number + 1) prose_start prose_buffer blocks issues
                  next_list_context rest))
  and inside line_number fence_line info kind code_buffer blocks issues =
    function
    | [] ->
        let id = code_block_id info fence_line in
        let code =
          Code
            {
              id;
              name = name_from_info info;
              source = Buffer.contents code_buffer;
              source_line = fence_line + 1;
              kind;
              position = { line_start = fence_line; line_end = line_number - 1 };
            }
        in
        ( List.rev (code :: blocks),
          List.rev
            ({
               severity = "error";
               message = "Executable OCaml fence is not closed.";
               line = fence_line;
               block_id = Some id;
             }
            :: issues) )
    | line :: rest -> (
        match fence_info line with
        | Some "" ->
            let code =
              Code
                {
                  id = code_block_id info fence_line;
                  name = name_from_info info;
                  source = Buffer.contents code_buffer;
                  source_line = fence_line + 1;
                  kind;
                  position = { line_start = fence_line; line_end = line_number };
                }
            in
            outside (line_number + 1) (line_number + 1) (Buffer.create 256)
              (code :: blocks) issues false rest
        | _ ->
            Buffer.add_string code_buffer line;
            inside (line_number + 1) fence_line info kind code_buffer blocks
              issues rest)
  and inside_indented line_number start_line code_buffer blocks issues =
    function
    | [] ->
        let code =
          Code
            {
              id = block_id "code" start_line;
              name = None;
              source = Buffer.contents code_buffer;
              source_line = start_line;
              kind = Program;
              position = { line_start = start_line; line_end = line_number - 1 };
            }
        in
        (List.rev (code :: blocks), List.rev issues)
    | line :: rest -> (
        match indented_code_line line with
        | Some code_line ->
            Buffer.add_string code_buffer code_line;
            inside_indented (line_number + 1) start_line code_buffer blocks
              issues rest
        | None when String.equal (String.trim line) "" ->
            Buffer.add_string code_buffer line;
            inside_indented (line_number + 1) start_line code_buffer blocks
              issues rest
        | None ->
            let code =
              Code
                {
                  id = block_id "code" start_line;
                  name = None;
                  source = Buffer.contents code_buffer;
                  source_line = start_line;
                  kind = Program;
                  position =
                    { line_start = start_line; line_end = line_number - 1 };
                }
            in
            outside line_number line_number (Buffer.create 256) (code :: blocks)
              issues false (line :: rest))
  in
  outside 1 1 (Buffer.create 256) [] [] false lines

let identifier_re = Str.regexp "[A-Za-z_][A-Za-z0-9_']*"

let identifiers source =
  let rec loop offset accumulator =
    try
      let _ = Str.search_forward identifier_re source offset in
      let identifier = Str.matched_string source in
      loop (Str.match_end ()) (identifier :: accumulator)
    with Not_found -> List.rev accumulator
  in
  loop 0 []

let definition_re =
  Str.regexp
    "^[ \t]*\\(let\\|type\\|module\\|exception\\|class\\)[ \t]+\\(rec[ \
     \t]+\\)?\\([A-Za-z_][A-Za-z0-9_']*\\)"

let definitions blocks =
  let definitions =
    List.concat_map
      (function
        | Prose _ -> []
        | Code { kind = Example; _ } -> []
        | Code { id; source; source_line; kind = Program; _ } ->
            let lines = String.split_on_char '\n' source |> Array.of_list in
            let starts =
              Array.to_list lines
              |> List.mapi (fun offset line ->
                  if Str.string_match definition_re line 0 then
                    let kind = Str.matched_group 1 line in
                    let name = Str.matched_group 3 line in
                    Some (offset, kind, name)
                  else None)
              |> List.filter_map Fun.id
            in
            let rec make = function
              | [] -> []
              | (offset, kind, name) :: rest ->
                  let end_offset =
                    match rest with
                    | (next_offset, _, _) :: _ -> next_offset
                    | [] -> Array.length lines
                  in
                  let source =
                    Array.sub lines offset (end_offset - offset)
                    |> Array.to_list |> String.concat "\n"
                  in
                  {
                    name;
                    kind;
                    block_id = id;
                    line = source_line + offset;
                    references = identifiers source;
                  }
                  :: make rest
            in
            make starts)
      blocks
  in
  let names = List.map (fun definition -> definition.name) definitions in
  List.map
    (fun definition ->
      {
        definition with
        references =
          definition.references
          |> List.filter (fun name ->
              name <> definition.name && List.mem name names)
          |> List.sort_uniq String.compare;
      })
    definitions

let title blocks path =
  let heading =
    List.find_map
      (function
        | Code _ -> None
        | Prose { source; _ } ->
            String.split_on_char '\n' source
            |> List.find_map (fun line ->
                if Util.starts_with ~prefix:"# " line then
                  Some
                    (String.sub line 2 (String.length line - 2) |> String.trim)
                else None))
      blocks
  in
  Option.value ~default:(Filename.basename path) heading

let page_references blocks =
  let reference_re =
    Str.regexp
      "\\[\\[\\([A-Z][A-Za-z0-9_']*\\(\\.[A-Z][A-Za-z0-9_']*\\)*\\)\\(#[^]\n\
       ]+\\)?\\]\\]"
  in
  let scan_line line_number line =
    let rec scan offset result =
      try
        let start = Str.search_forward reference_re line offset in
        let module_path = Str.matched_group 1 line in
        let fragment =
          try
            let value = Str.matched_group 3 line in
            Some (String.sub value 1 (String.length value - 1))
          with Not_found -> None
        in
        let finish = Str.match_end () in
        scan finish
          ({
             module_path;
             fragment;
             line = line_number;
             column_start = start;
             column_end = finish;
           }
          :: result)
      with Not_found -> List.rev result
    in
    scan 0 []
  in
  blocks
  |> List.concat_map (function
    | Code _ -> []
    | Prose { source; position; _ } ->
        String.split_on_char '\n' source
        |> List.mapi (fun offset line ->
            scan_line (position.line_start + offset) line)
        |> List.concat)

let parse ~path source =
  let blocks, parse_issues = parse_blocks source in
  let named_blocks =
    blocks
    |> List.filter_map (function
      | Code { name = Some name; id; position; _ } ->
          Some (name, id, position.line_start)
      | _ -> None)
  in
  let name_issues =
    named_blocks
    |> List.filter_map (fun (name, id, line) ->
        let valid =
          Str.string_match (Str.regexp "^[A-Za-z][A-Za-z0-9_-]*$") name 0
        in
        let occurrences =
          List.fold_left
            (fun count (candidate, _, _) ->
              if String.equal candidate name then count + 1 else count)
            0 named_blocks
        in
        if not valid then
          Some
            {
              severity = "error";
              message =
                "Block names must start with a letter and contain only \
                 letters, digits, '_' or '-'.";
              line;
              block_id = Some id;
            }
        else if occurrences > 1 then
          Some
            {
              severity = "error";
              message = Printf.sprintf "Duplicate block name %S." name;
              line;
              block_id = Some id;
            }
        else None)
    |> List.sort_uniq (fun left right ->
        compare
          (left.message, left.line, left.block_id)
          (right.message, right.line, right.block_id))
  in
  {
    path;
    source;
    version = Util.digest source;
    title = title blocks path;
    definitions = definitions blocks;
    page_references = page_references blocks;
    blocks;
    issues = parse_issues @ name_issues;
  }

let inline_expressions document =
  let expressions = ref [] in
  let is_escaped line index =
    let rec count_backslashes cursor count =
      if cursor >= 0 && line.[cursor] = '\\' then
        count_backslashes (cursor - 1) (count + 1)
      else count
    in
    count_backslashes (index - 1) 0 mod 2 = 1
  in
  let backtick_run line index =
    let rec loop cursor =
      if cursor < String.length line && line.[cursor] = '`' then
        loop (cursor + 1)
      else cursor - index
    in
    loop index
  in
  let rec next_single_backtick line offset =
    match String.index_from_opt line offset '`' with
    | None -> None
    | Some index ->
        let run = backtick_run line index in
        if run = 1 && not (is_escaped line index) then Some index
        else next_single_backtick line (index + run)
  in
  let scan_line line_number line =
    let rec scan offset =
      match next_single_backtick line offset with
      | None -> ()
      | Some opening -> (
          match next_single_backtick line (opening + 1) with
          | None -> ()
          | Some closing ->
              let content =
                String.sub line (opening + 1) (closing - opening - 1)
              in
              let trimmed = String.trim content in
              (if
                 String.length trimmed > 1
                 && trimmed.[String.length trimmed - 1] = '='
               then
                 let expression =
                   String.sub trimmed 0 (String.length trimmed - 1)
                   |> String.trim
                 in
                 if not (String.equal expression "") then
                   expressions :=
                     {
                       id =
                         Printf.sprintf "%s:%d:%d" document.path line_number
                           opening;
                       expression;
                       line = line_number;
                       column_start = opening + 1;
                       column_end = closing;
                       result_column = closing + 1;
                     }
                     :: !expressions);
              scan (closing + 1))
    in
    scan 0
  in
  let code_lines =
    document.blocks
    |> List.filter_map (function
      | Code { position; _ } -> Some position
      | Prose _ -> None)
  in
  let is_code_line line_number =
    List.exists
      (fun position ->
        line_number >= position.line_start && line_number <= position.line_end)
      code_lines
  in
  let fence_marker line =
    let rec leading_spaces index =
      if index < String.length line && index < 4 && line.[index] = ' ' then
        leading_spaces (index + 1)
      else index
    in
    let start = leading_spaces 0 in
    if start > 3 || start >= String.length line then None
    else
      let marker = line.[start] in
      if marker <> '`' && marker <> '~' then None
      else
        let rec count cursor =
          if cursor < String.length line && line.[cursor] = marker then
            count (cursor + 1)
          else cursor - start
        in
        let length = count start in
        if length >= 3 then Some (marker, length, start + length) else None
  in
  let fence = ref None in
  String.split_on_char '\n' document.source
  |> List.iteri (fun offset line ->
      let line_number = offset + 1 in
      match !fence with
      | Some (marker, opening_length) -> (
          match fence_marker line with
          | Some (candidate, length, after)
            when candidate = marker && length >= opening_length
                 && String.equal
                      (String.sub line after (String.length line - after)
                      |> String.trim)
                      "" ->
              fence := None
          | _ -> ())
      | None -> (
          match fence_marker line with
          | Some (marker, length, _) -> fence := Some (marker, length)
          | None ->
              if not (is_code_line line_number) then scan_line line_number line));
  List.rev !expressions

let program_source document =
  document.blocks
  |> List.filter_map (function
    | Code { source; kind = Program; _ } -> Some source
    | _ -> None)
  |> String.concat "\n"

let compilation_source document =
  document.blocks
  |> List.filter_map (function
    | Code { source; source_line; kind = Program; _ } ->
        Some (Printf.sprintf "# %d %S\n%s" source_line document.path source)
    | _ -> None)
  |> String.concat "\n"

let block_to_json = function
  | Prose { id; source; position } ->
      `Assoc
        [
          ("id", `String id);
          ("kind", `String "prose");
          ("source", `String source);
          ("lineStart", `Int position.line_start);
          ("lineEnd", `Int position.line_end);
        ]
  | Code { id; name; source; source_line; kind; position } ->
      `Assoc
        [
          ("id", `String id);
          ( "kind",
            `String
              (match kind with
              | Program -> "ocaml"
              | Example -> "ocaml-example") );
          ("name", Option.fold ~none:`Null ~some:(fun name -> `String name) name);
          ("source", `String source);
          ("lineStart", `Int position.line_start);
          ("lineEnd", `Int position.line_end);
          ("sourceLine", `Int source_line);
        ]

let definition_to_json definition =
  `Assoc
    [
      ("name", `String definition.name);
      ("kind", `String definition.kind);
      ("blockId", `String definition.block_id);
      ("line", `Int definition.line);
      ( "references",
        `List (List.map (fun name -> `String name) definition.references) );
    ]

let issue_to_json issue =
  `Assoc
    [
      ("severity", `String issue.severity);
      ("message", `String issue.message);
      ("line", `Int issue.line);
      ( "blockId",
        Option.fold ~none:`Null ~some:(fun id -> `String id) issue.block_id );
    ]

let page_reference_to_json reference =
  `Assoc
    [
      ("module", `String reference.module_path);
      ( "fragment",
        Option.fold ~none:`Null
          ~some:(fun value -> `String value)
          reference.fragment );
      ("line", `Int reference.line);
      ("columnStart", `Int reference.column_start);
      ("columnEnd", `Int reference.column_end);
    ]

let to_json document =
  `Assoc
    [
      ("path", `String document.path);
      ("title", `String document.title);
      ("source", `String document.source);
      ("version", `String document.version);
      ("blocks", `List (List.map block_to_json document.blocks));
      ("definitions", `List (List.map definition_to_json document.definitions));
      ( "pageReferences",
        `List (List.map page_reference_to_json document.page_references) );
      ("issues", `List (List.map issue_to_json document.issues));
    ]
