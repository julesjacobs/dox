type kind = Context | Added | Removed

type line = {
  kind : kind;
  before_line : int option;
  after_line : int option;
  text : string;
}

let lines source =
  let split = String.split_on_char '\n' source in
  match List.rev split with "" :: rest -> List.rev rest | _ -> split

let fallback before after =
  let removed =
    List.mapi
      (fun index text ->
        {
          kind = Removed;
          before_line = Some (index + 1);
          after_line = None;
          text;
        })
      before
  in
  let added =
    List.mapi
      (fun index text ->
        {
          kind = Added;
          before_line = None;
          after_line = Some (index + 1);
          text;
        })
      after
  in
  removed @ added

let compute before_source after_source =
  let before = Array.of_list (lines before_source) in
  let after = Array.of_list (lines after_source) in
  let before_count = Array.length before in
  let after_count = Array.length after in
  if before_count * after_count > 2_000_000 then
    fallback (Array.to_list before) (Array.to_list after)
  else
    let lengths = Array.make_matrix (before_count + 1) (after_count + 1) 0 in
    for before_index = before_count - 1 downto 0 do
      for after_index = after_count - 1 downto 0 do
        lengths.(before_index).(after_index) <-
          (if String.equal before.(before_index) after.(after_index) then
             lengths.(before_index + 1).(after_index + 1) + 1
           else
             max
               lengths.(before_index + 1).(after_index)
               lengths.(before_index).(after_index + 1))
      done
    done;
    let rec build before_index after_index accumulator =
      if before_index = before_count && after_index = after_count then
        List.rev accumulator
      else if before_index = before_count then
        build before_index (after_index + 1)
          ({
             kind = Added;
             before_line = None;
             after_line = Some (after_index + 1);
             text = after.(after_index);
           }
          :: accumulator)
      else if after_index = after_count then
        build (before_index + 1) after_index
          ({
             kind = Removed;
             before_line = Some (before_index + 1);
             after_line = None;
             text = before.(before_index);
           }
          :: accumulator)
      else if String.equal before.(before_index) after.(after_index) then
        build (before_index + 1) (after_index + 1)
          ({
             kind = Context;
             before_line = Some (before_index + 1);
             after_line = Some (after_index + 1);
             text = before.(before_index);
           }
          :: accumulator)
      else if
        lengths.(before_index + 1).(after_index)
        >= lengths.(before_index).(after_index + 1)
      then
        build (before_index + 1) after_index
          ({
             kind = Removed;
             before_line = Some (before_index + 1);
             after_line = None;
             text = before.(before_index);
           }
          :: accumulator)
      else
        build before_index (after_index + 1)
          ({
             kind = Added;
             before_line = None;
             after_line = Some (after_index + 1);
             text = after.(after_index);
           }
          :: accumulator)
    in
    build 0 0 []

let kind_name = function
  | Context -> "context"
  | Added -> "added"
  | Removed -> "removed"

let line_to_json line =
  `Assoc
    [
      ("kind", `String (kind_name line.kind));
      ( "beforeLine",
        Option.fold ~none:`Null
          ~some:(fun number -> `Int number)
          line.before_line );
      ( "afterLine",
        Option.fold ~none:`Null
          ~some:(fun number -> `Int number)
          line.after_line );
      ("text", `String line.text);
    ]

let to_json diff = `List (List.map line_to_json diff)
