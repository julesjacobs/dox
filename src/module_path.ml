type t = string
type error = string

let component_re = Str.regexp "^[A-Z][A-Za-z0-9_']*$"
let source_suffix = ".ml.md"
let split value = String.split_on_char '.' value

let validate value =
  let components = split value in
  if String.equal value "" then Error "A module path cannot be empty."
  else if List.exists (String.equal "") components then
    Error "A module path cannot contain an empty component."
  else
    match
      List.find_opt
        (fun part -> not (Str.string_match component_re part 0))
        components
    with
    | Some part ->
        Error
          (Printf.sprintf
             "Invalid module component %S. Components use [A-Z][A-Za-z0-9_']*."
             part)
    | None -> Ok value

let capitalize_component value =
  if String.equal value "" then value
  else
    String.make 1 (Char.uppercase_ascii value.[0])
    ^ String.sub value 1 (String.length value - 1)

let uncapitalize_component value =
  String.make 1 (Char.lowercase_ascii value.[0])
  ^ String.sub value 1 (String.length value - 1)

let source_path value =
  split value |> List.map uncapitalize_component |> String.concat "/"
  |> fun path -> path ^ source_suffix

let of_source_path path =
  if not (Util.ends_with ~suffix:source_suffix path) then
    Error (Printf.sprintf "Page source paths must end in %s." source_suffix)
  else
    let stem =
      String.sub path 0 (String.length path - String.length source_suffix)
    in
    let components = String.split_on_char '/' stem in
    if
      List.exists
        (fun part ->
          String.equal part "" || String.equal part "."
          || String.equal part "..")
        components
    then Error "Page source paths cannot contain empty, '.' or '..' components."
    else
      let module_path =
        components |> List.map capitalize_component |> String.concat "."
      in
      validate module_path

let namespace_prefixes value =
  let rec loop prefix result = function
    | [] | [ _ ] -> List.rev result
    | component :: rest ->
        let prefix =
          if String.equal prefix "" then component else prefix ^ "." ^ component
        in
        loop prefix (prefix :: result) rest
  in
  loop "" [] (split value)

let is_beneath ~namespace value =
  String.equal namespace value
  || Util.starts_with ~prefix:(namespace ^ ".") value

let replace_prefix ~before ~after value =
  if String.equal value before then Some after
  else if Util.starts_with ~prefix:(before ^ ".") value then
    Some
      (after
      ^ String.sub value (String.length before)
          (String.length value - String.length before))
  else None

let compare = String.compare
let compiler_unit value = "Dox__" ^ (split value |> String.concat "__")
let namespace_unit = function "" -> "Dox" | value -> compiler_unit value

let page_scope_unit value =
  "Dox_scope_for__" ^ (split value |> String.concat "__")

let rec take count = function
  | _ when count <= 0 -> []
  | [] -> []
  | value :: rest -> value :: take (count - 1) rest

let alias_source modules namespace =
  let prefix = if String.equal namespace "" then [] else split namespace in
  let prefix_length = List.length prefix in
  modules
  |> List.filter_map (fun module_path ->
      let components = split module_path in
      if
        List.length components <= prefix_length
        || take prefix_length components <> prefix
      then None
      else
        let component = List.nth components prefix_length in
        let target =
          components |> take (prefix_length + 1) |> String.concat "."
        in
        Some (component, target))
  |> List.sort_uniq Stdlib.compare
  |> List.map (fun (component, target) ->
      Printf.sprintf "module %s = %s" component (namespace_unit target))
  |> String.concat "\n"
  |> fun source -> if String.equal source "" then "" else source ^ "\n"

let alias_units modules =
  let namespaces =
    "" :: (modules |> List.concat_map namespace_prefixes)
    |> List.sort_uniq String.compare
  in
  namespaces
  |> List.map (fun namespace ->
      (namespace_unit namespace, alias_source modules namespace))

(* A page scope exposes siblings from each ancestor namespace, but omits the
   branch containing the page. The omission prevents a page from importing
   itself through its namespace alias. Inner bindings replace outer ones. *)
let ancestor_scope_bindings modules module_path =
  let components = split module_path in
  namespace_prefixes module_path
  |> List.mapi (fun index namespace ->
      let branch = take (index + 2) components |> String.concat "." in
      let prefix = split namespace in
      let target_length = List.length prefix + 1 in
      modules
      |> List.filter_map (fun candidate ->
          let candidate_components = split candidate in
          if
            List.length candidate_components < target_length
            || take (List.length prefix) candidate_components <> prefix
            || is_beneath ~namespace:branch candidate
          then None
          else
            let component = List.nth candidate_components (target_length - 1) in
            let target =
              take target_length candidate_components |> String.concat "."
            in
            Some (component, target))
      |> List.sort_uniq Stdlib.compare
      |> List.map (fun (component, target) ->
          let dependencies =
            if List.mem target modules then [ target ]
            else List.filter (is_beneath ~namespace:target) modules
          in
          (component, dependencies)))
  |> List.fold_left
       (fun visible bindings ->
         List.fold_left
           (fun visible (component, dependencies) ->
             (component, dependencies) :: List.remove_assoc component visible)
           visible bindings)
       []

let scope_alias_units modules =
  modules
  |> List.filter_map (fun module_path ->
      match namespace_prefixes module_path with
      | [] -> None
      | namespaces ->
          let components = split module_path in
          let source =
            namespaces
            |> List.mapi (fun index namespace ->
                let branch = take (index + 2) components |> String.concat "." in
                modules
                |> List.filter (fun candidate ->
                    not (is_beneath ~namespace:branch candidate))
                |> fun visible -> alias_source visible namespace)
            |> String.concat ""
          in
          Some (page_scope_unit module_path, source))

let ancestor_open_source module_path =
  match namespace_prefixes module_path with
  | [] -> ""
  | _ -> "open " ^ page_scope_unit module_path ^ "\n"

type lexical_state = {
  mutable comment_depth : int;
  mutable in_string : bool;
  mutable in_character : bool;
  mutable escaped : bool;
  mutable quoted_closing : string option;
}

let identifier_character = function
  | 'A' .. 'Z' | 'a' .. 'z' | '0' .. '9' | '_' | '\'' -> true
  | _ -> false

let code_mask source =
  let masked = Bytes.of_string source in
  let mask index = if source.[index] <> '\n' then Bytes.set masked index ' ' in
  let mask_range index length =
    for cursor = index to index + length - 1 do
      mask cursor
    done
  in
  let state =
    {
      comment_depth = 0;
      in_string = false;
      in_character = false;
      escaped = false;
      quoted_closing = None;
    }
  in
  let rec loop index =
    if index >= String.length source then ()
    else if Option.is_some state.quoted_closing then
      let closing = Option.get state.quoted_closing in
      if
        index + String.length closing <= String.length source
        && String.sub source index (String.length closing) = closing
      then (
        mask_range index (String.length closing);
        state.quoted_closing <- None;
        loop (index + String.length closing))
      else (
        mask index;
        loop (index + 1))
    else if state.comment_depth > 0 then
      if
        index + 1 < String.length source
        && source.[index] = '('
        && source.[index + 1] = '*'
      then (
        mask_range index 2;
        state.comment_depth <- state.comment_depth + 1;
        loop (index + 2))
      else if
        index + 1 < String.length source
        && source.[index] = '*'
        && source.[index + 1] = ')'
      then (
        mask_range index 2;
        state.comment_depth <- state.comment_depth - 1;
        loop (index + 2))
      else (
        mask index;
        loop (index + 1))
    else if state.in_string || state.in_character then (
      let character = source.[index] in
      mask index;
      if state.escaped then state.escaped <- false
      else if character = '\\' then state.escaped <- true
      else if state.in_string && character = '"' then state.in_string <- false
      else if state.in_character && character = '\'' then
        state.in_character <- false;
      loop (index + 1))
    else if
      index + 1 < String.length source
      && source.[index] = '('
      && source.[index + 1] = '*'
    then (
      mask_range index 2;
      state.comment_depth <- 1;
      loop (index + 2))
    else if source.[index] = '"' then (
      mask index;
      state.in_string <- true;
      state.escaped <- false;
      loop (index + 1))
    else if source.[index] = '{' then
      let rec quoted_opening cursor =
        if cursor >= String.length source then None
        else if source.[cursor] = '|' then
          Some
            ( cursor + 1,
              "|" ^ String.sub source (index + 1) (cursor - index - 1) ^ "}" )
        else
          match source.[cursor] with
          | 'a' .. 'z' | '_' -> quoted_opening (cursor + 1)
          | _ -> None
      in
      match quoted_opening (index + 1) with
      | Some (next, closing) ->
          mask_range index (next - index);
          state.quoted_closing <- Some closing;
          loop next
      | None -> loop (index + 1)
    else if
      source.[index] = '\''
      && index + 2 < String.length source
      && (source.[index + 2] = '\''
         || source.[index + 1] = '\\'
            && index + 3 < String.length source
            && source.[index + 3] = '\'')
    then (
      mask index;
      state.in_character <- true;
      state.escaped <- false;
      loop (index + 1))
    else loop (index + 1)
  in
  loop 0;
  Bytes.unsafe_to_string masked

let top_level_module_shadows source =
  let masked = code_mask source in
  let token_re = Str.regexp "[A-Za-z_][A-Za-z0-9_']*" in
  let rec scan offset depth previous pending result =
    try
      let start = Str.search_forward token_re masked offset in
      let token = Str.matched_string masked in
      let next = Str.match_end () in
      let depth =
        if String.equal token "end" then max 0 (depth - 1) else depth
      in
      let pending, result =
        match pending with
        | Some module_start when String.equal token "rec" ->
            (Some module_start, result)
        | Some _ when String.equal token "type" -> (None, result)
        | Some _ when depth = 0 && Str.string_match component_re token 0 ->
            (None, (token, start) :: result)
        | Some _ -> (None, result)
        | None -> (None, result)
      in
      let pending =
        if
          depth = 0
          && String.equal token "module"
          && not (Option.equal String.equal previous (Some "let"))
        then Some start
        else pending
      in
      let depth =
        if List.mem token [ "struct"; "sig"; "object"; "begin" ] then depth + 1
        else depth
      in
      scan next depth (Some token) pending result
    with Not_found -> List.rev result
  in
  scan 0 0 None None []

let rewrite_qualified_references ~modules source =
  let modules =
    List.sort
      (fun left right ->
        Stdlib.compare (String.length right) (String.length left))
      modules
  in
  let state =
    {
      comment_depth = 0;
      in_string = false;
      in_character = false;
      escaped = false;
      quoted_closing = None;
    }
  in
  let buffer = Buffer.create (String.length source + 32) in
  let shadows = top_level_module_shadows source in
  let matching index =
    List.find_opt
      (fun module_path ->
        let length = String.length module_path in
        let top = List.hd (split module_path) in
        index + length <= String.length source
        && String.sub source index length = module_path
        && (not
              (List.exists
                 (fun (name, declaration) ->
                   String.equal name top && declaration <= index)
                 shadows))
        && (String.contains module_path '.'
           || index + length < String.length source
              && source.[index + length] = '.')
        && (index = 0
           ||
           let character = source.[index - 1] in
           not (identifier_character character || character = '.'))
        && (index + length = String.length source
           ||
           let character = source.[index + length] in
           character = '.' || not (identifier_character character)))
      modules
  in
  let rec loop index =
    if index >= String.length source then ()
    else if Option.is_some state.quoted_closing then
      let closing = Option.get state.quoted_closing in
      if
        index + String.length closing <= String.length source
        && String.sub source index (String.length closing) = closing
      then (
        Buffer.add_string buffer closing;
        state.quoted_closing <- None;
        loop (index + String.length closing))
      else (
        Buffer.add_char buffer source.[index];
        loop (index + 1))
    else if state.comment_depth > 0 then
      if
        index + 1 < String.length source
        && source.[index] = '('
        && source.[index + 1] = '*'
      then (
        Buffer.add_string buffer "(*";
        state.comment_depth <- state.comment_depth + 1;
        loop (index + 2))
      else if
        index + 1 < String.length source
        && source.[index] = '*'
        && source.[index + 1] = ')'
      then (
        Buffer.add_string buffer "*)";
        state.comment_depth <- state.comment_depth - 1;
        loop (index + 2))
      else (
        Buffer.add_char buffer source.[index];
        loop (index + 1))
    else if state.in_string || state.in_character then (
      let character = source.[index] in
      Buffer.add_char buffer character;
      if state.escaped then state.escaped <- false
      else if character = '\\' then state.escaped <- true
      else if state.in_string && character = '"' then state.in_string <- false
      else if state.in_character && character = '\'' then
        state.in_character <- false;
      loop (index + 1))
    else if
      index + 1 < String.length source
      && source.[index] = '('
      && source.[index + 1] = '*'
    then (
      Buffer.add_string buffer "(*";
      state.comment_depth <- 1;
      loop (index + 2))
    else if source.[index] = '"' then (
      Buffer.add_char buffer '"';
      state.in_string <- true;
      state.escaped <- false;
      loop (index + 1))
    else if source.[index] = '{' then (
      let rec quoted_opening cursor =
        if cursor >= String.length source then None
        else if source.[cursor] = '|' then
          Some
            ( cursor + 1,
              "|" ^ String.sub source (index + 1) (cursor - index - 1) ^ "}" )
        else
          match source.[cursor] with
          | 'a' .. 'z' | '_' -> quoted_opening (cursor + 1)
          | _ -> None
      in
      match quoted_opening (index + 1) with
      | Some (next, closing) ->
          Buffer.add_substring buffer source index (next - index);
          state.quoted_closing <- Some closing;
          loop next
      | None ->
          Buffer.add_char buffer source.[index];
          loop (index + 1))
    else if
      source.[index] = '\''
      && index + 2 < String.length source
      && (source.[index + 2] = '\''
         || source.[index + 1] = '\\'
            && index + 3 < String.length source
            && source.[index + 3] = '\'')
    then (
      Buffer.add_char buffer '\'';
      state.in_character <- true;
      state.escaped <- false;
      loop (index + 1))
    else
      match matching index with
      | Some module_path ->
          Buffer.add_string buffer (compiler_unit module_path);
          loop (index + String.length module_path)
      | None ->
          Buffer.add_char buffer source.[index];
          loop (index + 1)
  in
  loop 0;
  Buffer.contents buffer
