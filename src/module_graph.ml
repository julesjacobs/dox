type t = {
  forward : (string * string list) list;
  reverse : (string * string list) list;
}

let qualified_re = Str.regexp "\\b[A-Z][a-z0-9_']*\\(\\.[A-Z][a-z0-9_']*\\)+"

let qualified_paths source =
  let rec loop offset result =
    try
      let _ = Str.search_forward qualified_re source offset in
      let value = Str.matched_string source in
      loop (Str.match_end ()) (value :: result)
    with Not_found -> List.rev result
  in
  loop 0 [] |> List.sort_uniq String.compare

let referenced_module modules candidate =
  match
    modules
    |> List.filter (fun module_path ->
        String.equal candidate module_path
        || Util.starts_with ~prefix:(module_path ^ ".") candidate)
    |> List.sort (fun left right ->
        compare (String.length right) (String.length left))
  with
  | first :: _ -> Some first
  | [] -> None

let build index =
  let modules = Page_index.modules index in
  let forward =
    index.Page_index.pages
    |> List.map (fun page ->
        let source = Document.program_source page.Page_index.document in
        let masked = Module_path.code_mask source in
        let declared_re =
          Str.regexp "\\bmodule[ \t\n]+\\([A-Z][A-Za-z0-9_']*\\)"
        in
        let rec declarations offset result =
          try
            let start = Str.search_forward declared_re masked offset in
            declarations (Str.match_end ())
              ((Str.matched_group 1 masked, start) :: result)
          with Not_found -> List.rev result
        in
        let declarations = declarations 0 [] in
        let namespace_re =
          Str.regexp
            "\\b\\(open\\|module[ \t\n\
             ]+[A-Z][A-Za-z0-9_']*[ \t\n\
             ]*=\\)[ \t\n\
             ]+\\([A-Z][A-Za-z0-9_']*\\(\\.[A-Z][A-Za-z0-9_']*\\)*\\)"
        in
        let rec namespaces source offset result =
          try
            let _ = Str.search_forward namespace_re source offset in
            namespaces source (Str.match_end ())
              (Str.matched_group 2 source :: result)
          with Not_found -> List.sort_uniq String.compare result
        in
        let visible_by_top = Hashtbl.create 8 in
        let visible top =
          match Hashtbl.find_opt visible_by_top top with
          | Some result -> result
          | None ->
              let length =
                declarations
                |> List.find_map (fun (name, offset) ->
                    if String.equal name top then Some offset else None)
                |> Option.value ~default:(String.length masked)
              in
              let source = String.sub masked 0 length in
              let result =
                ( Module_path.rewrite_qualified_references ~modules source,
                  namespaces source 0 [] )
              in
              Hashtbl.add visible_by_top top result;
              result
        in
        let typed =
          modules
          |> List.filter (fun module_path ->
              let top =
                match String.split_on_char '.' module_path with
                | first :: _ -> first
                | [] -> module_path
              in
              let rewritten, namespaces = visible top in
              (try
                 ignore
                   (Str.search_forward
                      (Str.regexp
                         ("\\b"
                         ^ Str.quote (Module_path.compiler_unit module_path)
                         ^ "\\b"))
                      rewritten 0);
                 true
               with Not_found -> false)
              || List.exists
                   (fun namespace ->
                     Module_path.is_beneath ~namespace module_path)
                   namespaces)
        in
        let dependencies =
          typed
          |> List.filter (fun value ->
              not (String.equal value page.Page_index.module_path))
          |> List.sort_uniq String.compare
        in
        (page.Page_index.module_path, dependencies))
  in
  let reverse =
    modules
    |> List.map (fun module_path ->
        let users =
          forward
          |> List.filter_map (fun (user, dependencies) ->
              if List.mem module_path dependencies then Some user else None)
          |> List.sort_uniq String.compare
        in
        (module_path, users))
  in
  { forward; reverse }

let dependencies t module_path =
  Option.value ~default:[] (List.assoc_opt module_path t.forward)

let dependents t module_path =
  Option.value ~default:[] (List.assoc_opt module_path t.reverse)

let boundary module_path =
  match String.split_on_char '.' module_path with
  | first :: _ -> first
  | [] -> module_path

let boundary_status t module_path =
  let users = dependents t module_path in
  if users = [] then "unused"
  else if
    List.for_all
      (fun user -> String.equal (boundary user) (boundary module_path))
      users
  then "namespace-local"
  else "cross-namespace"

let to_json t module_path =
  `Assoc
    [
      ("module", `String module_path);
      ( "uses",
        `List
          (List.map (fun value -> `String value) (dependencies t module_path))
      );
      ( "usedBy",
        `List (List.map (fun value -> `String value) (dependents t module_path))
      );
      ("boundary", `String (boundary_status t module_path));
    ]
