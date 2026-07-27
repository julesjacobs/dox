type page = {
  module_path : Module_path.t;
  source_path : string;
  document : Document.t;
}

type t = {
  pages : page list;
  namespaces : string list;
  diagnostics : string list;
}

let build_internal ~strict documents =
  let rec add seen_pages seen_namespaces pages diagnostics = function
    | [] ->
        Ok
          {
            pages =
              List.sort
                (fun left right ->
                  Module_path.compare left.module_path right.module_path)
                pages;
            namespaces = List.sort_uniq String.compare seen_namespaces;
            diagnostics = List.rev diagnostics;
          }
    | document :: rest -> (
        let reject message =
          if strict then Error message
          else
            add seen_pages seen_namespaces pages (message :: diagnostics) rest
        in
        match Module_path.of_source_path document.Document.path with
        | Error message ->
            reject (Printf.sprintf "%s: %s" document.Document.path message)
        | Ok module_path -> (
            if List.mem module_path seen_pages then
              reject (Printf.sprintf "Duplicate page module %s." module_path)
            else if List.mem module_path seen_namespaces then
              reject
                (Printf.sprintf
                   "%s is both a page and a namespace. Use %s.Index for the \
                    overview page."
                   module_path module_path)
            else
              let prefixes = Module_path.namespace_prefixes module_path in
              match
                List.find_opt
                  (fun prefix -> List.mem prefix seen_pages)
                  prefixes
              with
              | Some prefix ->
                  reject
                    (Printf.sprintf
                       "%s is both a page and a namespace. Move the page to \
                        %s.Index."
                       prefix prefix)
              | None ->
                  let page =
                    { module_path; source_path = document.path; document }
                  in
                  add
                    (module_path :: seen_pages)
                    (prefixes @ seen_namespaces)
                    (page :: pages) diagnostics rest))
  in
  add [] [] [] [] documents

let build documents = build_internal ~strict:true documents
let build_migrating documents = build_internal ~strict:false documents

let find t module_path =
  List.find_opt (fun page -> String.equal page.module_path module_path) t.pages

let find_source t source_path =
  List.find_opt (fun page -> String.equal page.source_path source_path) t.pages

let modules t = List.map (fun page -> page.module_path) t.pages
let has_namespace t value = List.mem value t.namespaces

let line_entries t =
  let rec emit depth prefix pages =
    let groups = Hashtbl.create 16 in
    List.iter
      (fun (components, page) ->
        match components with
        | [] -> ()
        | component :: rest ->
            let existing =
              Option.value ~default:[] (Hashtbl.find_opt groups component)
            in
            Hashtbl.replace groups component ((rest, page) :: existing))
      pages;
    Hashtbl.to_seq_keys groups |> List.of_seq |> List.sort String.compare
    |> List.concat_map (fun component ->
        let members = Hashtbl.find groups component in
        let here =
          List.find_map (function [], page -> Some page | _ -> None) members
        in
        let descendants =
          List.filter_map
            (function [], _ -> None | rest, page -> Some (rest, page))
            members
        in
        let path =
          if String.equal prefix "" then component else prefix ^ "." ^ component
        in
        let line =
          `Assoc
            [
              ("text", `String (String.make (depth * 2) ' ' ^ component));
              ( "module",
                Option.fold ~none:`Null
                  ~some:(fun page -> `String page.module_path)
                  here );
              ("namespace", `Bool (descendants <> []));
              ("depth", `Int depth);
            ]
        in
        line :: emit (depth + 1) path descendants)
  in
  t.pages
  |> List.map (fun page -> (Module_path.split page.module_path, page))
  |> emit 0 ""

let backlinks t module_path =
  t.pages
  |> List.filter_map (fun page ->
      if
        List.exists
          (fun reference ->
            String.equal reference.Document.module_path module_path)
          page.document.page_references
      then Some page.module_path
      else None)
  |> List.sort_uniq String.compare

let to_json t =
  `Assoc
    [
      ("modules", `List (List.map (fun value -> `String value) (modules t)));
      ("outline", `List (line_entries t));
      ( "diagnostics",
        `List (List.map (fun value -> `String value) t.diagnostics) );
      ( "backlinks",
        `Assoc
          (List.map
             (fun module_path ->
               ( module_path,
                 `List
                   (List.map
                      (fun value -> `String value)
                      (backlinks t module_path)) ))
             (modules t)) );
    ]
