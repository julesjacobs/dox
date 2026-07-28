let ( let* ) = Result.bind

let read_file path =
  try
    let channel = open_in_bin path in
    Fun.protect
      ~finally:(fun () -> close_in_noerr channel)
      (fun () -> really_input_string channel (in_channel_length channel))
    |> Result.ok
  with Sys_error message -> Error message

let write_file path contents =
  try
    let channel = open_out_bin path in
    (try
       output_string channel contents;
       flush channel;
       close_out channel
     with error ->
       close_out_noerr channel;
       raise error);
    Ok ()
  with Sys_error message -> Error message

let write_file_atomic path contents =
  let directory = Filename.dirname path in
  let basename = Filename.basename path in
  try
    let temporary, channel =
      Filename.open_temp_file ~temp_dir:directory
        ("." ^ basename ^ ".doclang-")
        ".tmp"
    in
    (try
       output_string channel contents;
       flush channel;
       Unix.fsync (Unix.descr_of_out_channel channel);
       close_out channel;
       Unix.rename temporary path
     with error ->
       close_out_noerr channel;
       (try Sys.remove temporary with Sys_error _ -> ());
       raise error);
    Ok ()
  with
  | Sys_error message -> Error message
  | Unix.Unix_error (error, _, _) -> Error (Unix.error_message error)

let write_file_atomic_if_absent path contents =
  let directory = Filename.dirname path in
  let basename = Filename.basename path in
  try
    let temporary, channel =
      Filename.open_temp_file ~temp_dir:directory
        ("." ^ basename ^ ".doclang-")
        ".tmp"
    in
    try
      output_string channel contents;
      flush channel;
      Unix.fsync (Unix.descr_of_out_channel channel);
      close_out channel;
      try
        Unix.link temporary path;
        Sys.remove temporary;
        Ok ()
      with
      | Unix.Unix_error (Unix.EEXIST, _, _) ->
          Sys.remove temporary;
          Error `Changed
      | error ->
          (try Sys.remove temporary with Sys_error _ -> ());
          raise error
    with error ->
      close_out_noerr channel;
      (try Sys.remove temporary with Sys_error _ -> ());
      raise error
  with
  | Sys_error message -> Error (`Io message)
  | Unix.Unix_error (error, _, _) -> Error (`Io (Unix.error_message error))

let rec ensure_directory path =
  if Sys.file_exists path then
    if Sys.is_directory path then Ok ()
    else Error (Printf.sprintf "%s exists but is not a directory" path)
  else
    let parent = Filename.dirname path in
    let* () =
      if String.equal parent path then Ok () else ensure_directory parent
    in
    try
      Unix.mkdir path 0o755;
      Ok ()
    with Unix.Unix_error (error, _, _) -> Error (Unix.error_message error)

let digest contents = Digest.to_hex (Digest.string contents)

let random_token () =
  let bytes = Bytes.create 32 in
  let channel = open_in_bin "/dev/urandom" in
  Fun.protect
    ~finally:(fun () -> close_in_noerr channel)
    (fun () -> really_input channel bytes 0 (Bytes.length bytes));
  let digits = "0123456789abcdef" in
  let encoded = Bytes.create (Bytes.length bytes * 2) in
  Bytes.iteri
    (fun index byte ->
      let code = Char.code byte in
      Bytes.set encoded (index * 2) digits.[code lsr 4];
      Bytes.set encoded ((index * 2) + 1) digits.[code land 15])
    bytes;
  Bytes.unsafe_to_string encoded

let json_string value = `String value
let json_assoc fields = `Assoc fields
let json_list fn values = `List (List.map fn values)

let starts_with ~prefix value =
  let prefix_length = String.length prefix in
  String.length value >= prefix_length
  && String.sub value 0 prefix_length = prefix

let ends_with ~suffix value =
  let suffix_length = String.length suffix in
  let value_length = String.length value in
  value_length >= suffix_length
  && String.sub value (value_length - suffix_length) suffix_length = suffix

let trim = String.trim

let split_once character value =
  match String.index_opt value character with
  | None -> (value, None)
  | Some index ->
      let left = String.sub value 0 index in
      let right =
        String.sub value (index + 1) (String.length value - index - 1)
      in
      (left, Some right)

let percent_decode value =
  let buffer = Buffer.create (String.length value) in
  let hex character =
    match character with
    | '0' .. '9' -> Char.code character - Char.code '0'
    | 'a' .. 'f' -> 10 + Char.code character - Char.code 'a'
    | 'A' .. 'F' -> 10 + Char.code character - Char.code 'A'
    | _ -> -1
  in
  let rec loop index =
    if index >= String.length value then ()
    else
      match value.[index] with
      | '+' ->
          Buffer.add_char buffer ' ';
          loop (index + 1)
      | '%' when index + 2 < String.length value ->
          let high = hex value.[index + 1] in
          let low = hex value.[index + 2] in
          if high >= 0 && low >= 0 then (
            Buffer.add_char buffer (Char.chr ((high * 16) + low));
            loop (index + 3))
          else (
            Buffer.add_char buffer value.[index];
            loop (index + 1))
      | character ->
          Buffer.add_char buffer character;
          loop (index + 1)
  in
  loop 0;
  Buffer.contents buffer

let query_parameters target =
  match String.index_opt target '?' with
  | None -> (target, [])
  | Some index ->
      let path = String.sub target 0 index in
      let query =
        String.sub target (index + 1) (String.length target - index - 1)
      in
      let parameters =
        String.split_on_char '&' query
        |> List.filter_map (fun item ->
            if String.equal item "" then None
            else
              let key, value = split_once '=' item in
              Some
                ( percent_decode key,
                  percent_decode (Option.value ~default:"" value) ))
      in
      (path, parameters)

let json_error message = `Assoc [ ("error", `String message) ]

let timestamp () =
  let time = Unix.gettimeofday () in
  let parts = Unix.gmtime time in
  Printf.sprintf "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" (parts.tm_year + 1900)
    (parts.tm_mon + 1) parts.tm_mday parts.tm_hour parts.tm_min parts.tm_sec
    (int_of_float ((time -. Float.floor time) *. 1000.))

let list_files root =
  let rec walk relative accumulator =
    let absolute =
      if String.equal relative "" then root else Filename.concat root relative
    in
    Sys.readdir absolute |> Array.to_list |> List.sort String.compare
    |> List.fold_left
         (fun accumulator name ->
           if name = "_build" || name = ".git" || name = ".doclang" then
             accumulator
           else
             let child_relative =
               if String.equal relative "" then name
               else Filename.concat relative name
             in
             let child_absolute = Filename.concat root child_relative in
             match (Unix.lstat child_absolute).st_kind with
             | Unix.S_DIR -> walk child_relative accumulator
             | Unix.S_REG -> child_relative :: accumulator
             | _ -> accumulator)
         accumulator
  in
  List.rev (walk "" [])

let path_is_inside ~root path =
  String.equal path root || starts_with ~prefix:(root ^ Filename.dir_sep) path

let validate_relative_path relative =
  if not (Filename.is_relative relative) then Error "path must be relative"
  else
    let components = String.split_on_char '/' relative in
    if
      List.exists
        (fun part -> part = ".." || part = "." || part = "")
        components
    then Error "path must use its canonical project-relative spelling"
    else Ok ()

let safe_existing_path ~root relative =
  let* () = validate_relative_path relative in
  let candidate = Filename.concat root relative in
  try
    let root = Unix.realpath root in
    let resolved = Unix.realpath candidate in
    let status = Unix.stat resolved in
    if not (path_is_inside ~root resolved) then Error "path leaves the project"
    else if status.st_kind <> Unix.S_REG then Error "path is not a regular file"
    else Ok resolved
  with Unix.Unix_error (error, _, _) -> Error (Unix.error_message error)

let safe_new_path ~root relative =
  let* () = validate_relative_path relative in
  let candidate = Filename.concat root relative in
  let rec existing_parent path =
    if Sys.file_exists path then path
    else
      let parent = Filename.dirname path in
      if String.equal parent path then path else existing_parent parent
  in
  try
    let root = Unix.realpath root in
    let parent = Unix.realpath (existing_parent (Filename.dirname candidate)) in
    if not (path_is_inside ~root parent) then Error "path leaves the project"
    else Ok candidate
  with Unix.Unix_error (error, _, _) -> Error (Unix.error_message error)

let with_file_lock path operation =
  let descriptor =
    Unix.openfile path [ Unix.O_CREAT; Unix.O_RDWR; Unix.O_CLOEXEC ] 0o600
  in
  Fun.protect
    ~finally:(fun () ->
      (try Unix.lockf descriptor Unix.F_ULOCK 0 with Unix.Unix_error _ -> ());
      Unix.close descriptor)
    (fun () ->
      Unix.lockf descriptor Unix.F_LOCK 0;
      operation ())

let with_file_lock_cancelled path ~cancelled operation =
  let descriptor =
    Unix.openfile path [ Unix.O_CREAT; Unix.O_RDWR; Unix.O_CLOEXEC ] 0o600
  in
  let locked = ref false in
  Fun.protect
    ~finally:(fun () ->
      (if !locked then
         try Unix.lockf descriptor Unix.F_ULOCK 0 with Unix.Unix_error _ -> ());
      Unix.close descriptor)
    (fun () ->
      let rec acquire () =
        if cancelled () then None
        else
          try
            Unix.lockf descriptor Unix.F_TLOCK 0;
            locked := true;
            Some ()
          with
          | Unix.Unix_error ((Unix.EACCES | Unix.EAGAIN), _, _) ->
              ignore (Unix.select [] [] [] 0.01);
              acquire ()
          | Unix.Unix_error (Unix.EINTR, _, _) -> acquire ()
      in
      match acquire () with None -> None | Some () -> Some (operation ()))
