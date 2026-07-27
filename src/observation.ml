let is_identifier_start = function
  | 'a' .. 'z' | 'A' .. 'Z' | '_' -> true
  | _ -> false

let is_identifier_character = function
  | 'a' .. 'z' | 'A' .. 'Z' | '0' .. '9' | '_' | '\'' -> true
  | _ -> false

let char_literal_end source start =
  let length = String.length source in
  let rec loop index escaped =
    if index >= length || index - start > 12 then None
    else
      let character = source.[index] in
      if escaped then loop (index + 1) false
      else if Char.equal character '\\' then loop (index + 1) true
      else if Char.equal character '\'' then Some (index + 1)
      else if Char.equal character '\n' then None
      else loop (index + 1) false
  in
  loop (start + 1) false

let quoted_string_open source start =
  let length = String.length source in
  if start >= length || not (Char.equal source.[start] '{') then None
  else
    let rec delimiter index =
      if index >= length then None
      else
        match source.[index] with
        | '|' ->
            Some (String.sub source (start + 1) (index - start - 1), index + 1)
        | 'a' .. 'z' | '_' -> delimiter (index + 1)
        | _ -> None
    in
    delimiter (start + 1)

let normal_characters source =
  let length = String.length source in
  let normal = Array.make length true in
  let mark start finish =
    for index = start to min (length - 1) (finish - 1) do
      normal.(index) <- false
    done
  in
  let rec normal_state index =
    if index >= length then ()
    else if
      index + 1 < length
      && Char.equal source.[index] '('
      && Char.equal source.[index + 1] '*'
    then comment_state index (index + 2) 1
    else if Char.equal source.[index] '"' then string_state index (index + 1)
    else
      match quoted_string_open source index with
      | Some (delimiter, content_start) ->
          quoted_state index content_start delimiter
      | None when Char.equal source.[index] '\'' -> (
          match char_literal_end source index with
          | Some finish ->
              mark index finish;
              normal_state finish
          | None -> normal_state (index + 1))
      | None -> normal_state (index + 1)
  and comment_state start index depth =
    if index >= length then mark start length
    else if
      index + 1 < length
      && Char.equal source.[index] '('
      && Char.equal source.[index + 1] '*'
    then comment_state start (index + 2) (depth + 1)
    else if
      index + 1 < length
      && Char.equal source.[index] '*'
      && Char.equal source.[index + 1] ')'
    then
      if depth = 1 then (
        mark start (index + 2);
        normal_state (index + 2))
      else comment_state start (index + 2) (depth - 1)
    else comment_state start (index + 1) depth
  and string_state start index =
    if index >= length then mark start length
    else if Char.equal source.[index] '\\' then string_state start (index + 2)
    else if Char.equal source.[index] '"' then (
      mark start (index + 1);
      normal_state (index + 1))
    else string_state start (index + 1)
  and quoted_state start index delimiter =
    let closing = "|" ^ delimiter ^ "}" in
    let closing_length = String.length closing in
    if index + closing_length > length then mark start length
    else if String.sub source index closing_length = closing then (
      mark start (index + closing_length);
      normal_state (index + closing_length))
    else quoted_state start (index + 1) delimiter
  in
  normal_state 0;
  normal

let previous_nonspace source offset =
  let rec loop index =
    if index < 0 then None
    else
      match source.[index] with
      | ' ' | '\t' | '\r' | '\n' -> loop (index - 1)
      | character -> Some (index, character)
  in
  loop (offset - 1)

let previous_word source offset =
  match previous_nonspace source offset with
  | Some (finish, character) when is_identifier_character character ->
      let rec start index =
        if index >= 0 && is_identifier_character source.[index] then
          start (index - 1)
        else index + 1
      in
      let start = start finish in
      Some (String.sub source start (finish - start + 1), start)
  | None | Some _ -> None

let binding_marker source offset =
  if
    offset + 1 >= String.length source
    || not (is_identifier_start source.[offset + 1])
  then false
  else
    match previous_word source offset with
    | Some (("let" | "and"), _) -> true
    | Some ("rec", rec_start) -> (
        match previous_word source rec_start with
        | Some ("let", _) -> true
        | None | Some _ -> false)
    | None | Some _ -> false

let expression_marker source offset =
  if
    offset + 1 >= String.length source
    || not (Char.equal source.[offset + 1] '(')
  then false
  else
    match previous_nonspace source offset with
    | None -> true
    | Some (_, character) ->
        not
          (is_identifier_character character
          || match character with ')' | ']' | '}' | '"' -> true | _ -> false)

let erase ~path:_ ~start_line:_ source =
  let normal = normal_characters source in
  let erased = Bytes.of_string source in
  String.iteri
    (fun index character ->
      if
        Char.equal character '@' && normal.(index)
        && (binding_marker source index || expression_marker source index)
      then Bytes.set erased index ' ')
    source;
  Ok (Bytes.unsafe_to_string erased, [])
