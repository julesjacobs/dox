let fail message =
  prerr_endline message;
  exit 1

let expect condition message = if not condition then fail message

let () =
  let piped = Evaluator.run_process ~stdin:"compiler input" "/bin/cat" [] in
  expect
    (piped.stdout = "compiler input")
    "process input was not delivered byte-for-byte";
  let timeout =
    Evaluator.run_process ~timeout_seconds:0.1 "/bin/sh"
      [ "-c"; "while :; do :; done" ]
  in
  expect timeout.timed_out "nonterminating process was not stopped";
  let capped =
    Evaluator.run_process ~output_limit:100_000 "/bin/sh"
      [ "-c"; "yes x | head -c 200000" ]
  in
  expect capped.output_limited "fast process output escaped the output cap";
  let source =
    "# Runtime\n\n\
     ```ocaml name=output\n\
     let () = print_string \"first\\n\\nsecond\\n\"\n\
     let () = Doc.text ~id:\"output\" \"structured\"\n\
     ```\n"
  in
  let document = Document.parse ~path:"runtime.ml.md" source in
  let evaluation = Evaluator.evaluate document in
  expect evaluation.ok "valid document did not evaluate";
  let compiler_construct_ids =
    evaluation.compiler_manifests
    |> List.concat_map (fun manifest ->
        List.map
          (fun construct -> construct.Evaluator.construct_id)
          manifest.Evaluator.manifest_constructs)
  in
  let unique_compiler_construct_ids =
    compiler_construct_ids |> List.sort_uniq String.compare
  in
  expect (compiler_construct_ids <> [])
    "the compiler did not emit a construct manifest";
  expect
    (List.length unique_compiler_construct_ids
    = List.length compiler_construct_ids)
    "compiler construct IDs were not unique";
  expect
    (List.for_all
       (fun (event : Evaluator.trace_event) ->
         List.mem event.site_id unique_compiler_construct_ids)
       evaluation.traces)
    "a runtime observation did not carry its compiler construct ID";
  expect
    (evaluation.stdout = "first\n\nsecond\n")
    "ordinary stdout was not preserved byte-for-byte";
  expect
    (match evaluation.block_outputs with
    | [ output ] ->
        output.block_id = "code-output"
        && output.path = "runtime.ml.md"
        && output.stdout = "first\n\nsecond\n"
        && output.stderr = ""
    | _ -> false)
    "ordinary stdout was not attributed to its code block";
  let two_blocks =
    Document.parse ~path:"two-blocks.ml.md"
      "    let () = print_endline \"first\"\n\n\
       Between.\n\n\
      \    let () = print_endline \"second\"\n"
    |> Evaluator.evaluate
  in
  expect
    (match two_blocks.block_outputs with
    | [ first; second ] ->
        first.block_id = "code-1" && first.stdout = "first\n"
        && second.block_id = "code-5" && second.stdout = "second\n"
    | _ -> false)
    "separate code blocks did not retain separate stdout";
  let live_scope =
    Document.parse ~path:"inline.ml.md"
      "# Inline values\n\n\
      \    let base = 40\n\n\
       Between blocks.\n\n\
      \    let add value = base + value\n\n\
       The answer is `add 2 =`.\n"
    |> Evaluator.evaluate
  in
  expect live_scope.ok "definitions did not stay live across code blocks";
  expect
    (match live_scope.inline_results with
    | [ result ] ->
        result.expression = "add 2"
        && result.type_ = "int" && result.value = "42" && result.error = None
    | _ -> false)
    "an inline OCaml expression did not produce its value";
  let nested_inline_observation =
    Document.parse ~path:"nested-inline.ml.md" "Nested: `@(1) + 2 =`.\n"
    |> Evaluator.evaluate
  in
  expect
    (match nested_inline_observation.inline_results with
    | [ result ] -> result.type_ = "int" && result.value = "3"
    | _ -> false)
    "a nested observation replaced the enclosing inline result";
  let isolated_inline_failure =
    Document.parse ~path:"inline-failure.ml.md"
      "    let base = 3\n\n\
       Raised: `failwith \"boom\" =`.\n\
       Later: `base + 2 =`.\n"
    |> Evaluator.evaluate
  in
  expect isolated_inline_failure.ok
    "a raised inline expression stopped the document evaluation";
  expect
    (match isolated_inline_failure.inline_results with
    | [ raised; later ] ->
        Option.is_some raised.error && later.value = "5" && later.error = None
    | _ -> false)
    "inline expression failures were not isolated";
  expect
    (List.for_all
       (fun (event : Evaluator.trace_event) ->
         not (Util.starts_with ~prefix:"<dox-inline:" event.path))
       isolated_inline_failure.traces)
    "synthetic inline observations leaked into the execution trace";
  let invalid_inline =
    Document.parse ~path:"invalid-inline.ml.md"
      "    let base = 3\n\nInvalid: `base + \"x\" =`.\n"
    |> Evaluator.evaluate
  in
  expect (not invalid_inline.ok) "an invalid inline expression compiled";
  expect
    (match invalid_inline.inline_results with
    | [ result ] -> Option.is_some result.error
    | _ -> false)
    "an invalid inline expression did not retain its compiler error";
  expect
    (List.exists
       (fun (diagnostic : Evaluator.diagnostic) ->
         diagnostic.path = Some "invalid-inline.ml.md"
         && diagnostic.line = Some 3)
       invalid_inline.diagnostics)
    "an inline compiler error was not mapped back to the Markdown span";
  expect
    (match evaluation.views with
    | [ view ] ->
        view.kind = "text" && view.id = "output" && view.content = "structured"
    | _ -> false)
    "structured runtime event was not captured";
  let invalid =
    Document.parse ~path:"invalid.ml.md"
      "```ocaml\nlet answer : string = 42\n```\n"
    |> Evaluator.evaluate
  in
  expect (not invalid.ok) "type error was accepted";
  expect
    (List.exists
       (fun (diagnostic : Evaluator.diagnostic) -> diagnostic.line = Some 2)
       invalid.diagnostics)
    "compiler diagnostic did not preserve the literate source line";
  let oversized_view =
    Document.parse ~path:"oversized.ml.md"
      "```ocaml\n\
       let () = Doc.text ~id:\"large\" (String.make 2100000 'x')\n\
       ```\n"
    |> Evaluator.evaluate
  in
  expect
    (String.equal oversized_view.status "output-limited")
    "structured runtime output escaped the output cap";
  let typed_document =
    Document.parse ~path:"types.ml.md"
      "# Types\n\n\
      \    let observations = [ 3.; 5. ]\n\
      \    let mean values = List.length values\n\
      \    let count = mean observations\n"
  in
  let cursor_type =
    Evaluator.type_at ~documents:[ typed_document ] ~target:typed_document
      ~line:4 ~column:18
  in
  expect
    (match cursor_type with
    | Ok (Some info) ->
        if not (String.equal info.type_ "'a list") then
          prerr_endline ("Unexpected Merlin type: " ^ info.type_);
        String.equal info.type_ "'a list"
    | Ok None ->
        prerr_endline "Merlin returned no cursor type";
        false
    | Error message ->
        prerr_endline ("Merlin cursor query failed: " ^ message);
        false)
    "Merlin did not return the local variable type at the cursor";
  let local_completions =
    Evaluator.complete_at_with_cancel
      ~cancelled:(fun () -> false)
      ~documents:[ typed_document ] ~target:typed_document ~line:5 ~column:20
      ~context:""
  in
  expect
    (match local_completions with
    | Ok entries ->
        List.exists
          (fun (entry : Evaluator.completion_entry) ->
            String.equal entry.name "observations")
          entries
    | Error message ->
        prerr_endline ("Merlin completion query failed: " ^ message);
        false)
    "Merlin completions did not include identifiers from the live scope";
  let module_completions =
    Evaluator.complete_at_with_cancel
      ~cancelled:(fun () -> false)
      ~documents:[ typed_document ] ~target:typed_document ~line:4 ~column:31
      ~context:"List."
  in
  expect
    (match module_completions with
    | Ok entries ->
        List.exists
          (fun (entry : Evaluator.completion_entry) ->
            String.equal entry.name "map")
          entries
    | Error _ -> false)
    "Merlin completions did not expand module paths";
  let imported_document =
    Document.parse ~path:"examples/library.ml.md"
      "# Library\n\n    let @imported_values = [ 1.; 2. ]\n"
  in
  let importing_document =
    Document.parse ~path:"examples/consumer.ml.md"
      "# Consumer\n\n\
      \    let imported_count = List.length Library.imported_values\n"
  in
  let imported_type =
    Evaluator.type_at
      ~documents:[ imported_document; importing_document ]
      ~target:importing_document ~line:3 ~column:52
  in
  expect
    (match imported_type with
    | Ok (Some info) -> String.equal info.type_ "float list"
    | _ -> false)
    "Merlin cursor query did not include imported live documents";
  let imported_completions =
    Evaluator.complete_at_with_cancel
      ~cancelled:(fun () -> false)
      ~documents:[ imported_document; importing_document ]
      ~target:importing_document ~line:3 ~column:46 ~context:"Library."
  in
  expect
    (match imported_completions with
    | Ok entries ->
        List.exists
          (fun (entry : Evaluator.completion_entry) ->
            String.equal entry.name "imported_values")
          entries
    | Error _ -> false)
    "Merlin completions did not include imported live definitions";
  let definition_document =
    Document.parse ~path:"library.ml.md"
      "# Library\n\n    let add_one value =\n      value + 1\n"
  in
  let definition_consumer =
    Document.parse ~path:"consumer.ml.md"
      "# Consumer\n\n    let result = Library.add_one 4\n"
  in
  let located_definition =
    Evaluator.definition_at_with_cancel
      ~cancelled:(fun () -> false)
      ~documents:[ definition_document; definition_consumer ]
      ~target:definition_consumer ~line:3 ~column:29
  in
  expect
    (match located_definition with
    | Ok (Some info) ->
        String.equal info.module_path "Library"
        && String.equal info.name "add_one"
        && info.line = 3
        && String.equal info.source "let add_one value =\n  value + 1"
    | _ -> false)
    "Merlin definition lookup did not map an imported value back to its page";
  let unicode_document =
    Document.parse ~path:"unicode.ml.md"
      "# Unicode\n\n    let unicode_value = (\"é😀\", 42)\n"
  in
  let unicode_type =
    Evaluator.type_at ~documents:[ unicode_document ] ~target:unicode_document
      ~line:3 ~column:33
  in
  expect
    (match unicode_type with
    | Ok (Some info) ->
        String.equal info.type_ "int"
        && String.equal info.expression "42"
        && info.start_column = 32 && info.end_column = 34
    | _ -> false)
    "Merlin cursor positions did not preserve CodeMirror UTF-16 columns";
  let spanning_document =
    Document.parse ~path:"spanning.ml.md"
      "# Spanning\n\n\
      \    let spanning = if true then\n\
       This prose is not part of the OCaml program.\n\
      \    40 else 2\n"
  in
  let spanning_type =
    Evaluator.type_at ~documents:[ spanning_document ] ~target:spanning_document
      ~line:3 ~column:19
  in
  expect
    (match spanning_type with
    | Ok (Some info) ->
        String.equal info.type_ "int"
        && String.equal info.expression "if true then\n\n40 else 2"
    | _ -> false)
    "Merlin expression text included literate prose between code regions";
  let observed_document =
    Document.parse ~path:"observed.ml.md"
      "# Observations\n\n\
      \    let rec @fib n =\n\
      \      if n < 2 then n else @(fib (n - 1)) + fib (n - 2)\n\n\
      \    let @answer = fib 4\n\
      \    let @empty = []\n\
      \    let ints : int list = empty\n\
      \    let strings : string list = empty\n\
      \    let appended = ints @ ([])\n\
      \    let unicode = \"é😀\" ^ @(string_of_int 2)\n\
      \    let @flag = true\n\
      \    let @nothing = None\n\
      \    let @done_ = ()\n\
      \    let @add left right = left + right\n\
      \    let @sum = add 2 3\n\
      \    let @length values = List.length values\n\
      \    let @count = length [1; 2; 3]\n\
      \    let @head_or_zero = function [] -> 0 | value :: _ -> value\n\
      \    let @head = head_or_zero [7; 8]\n"
  in
  let erased_observations =
    Observation.erase ~path:"observed.ml.md" ~start_line:1
      "let rec @fib n = @(fib (n - 1))\n\
       let appended = [1] @ ([2])\n\
       let literal = \"@(not syntax)\"\n"
  in
  expect
    (match erased_observations with
    | Ok (source, _) ->
        String.equal source
          "let rec  fib n =  (fib (n - 1))\n\
           let appended = [1] @ ([2])\n\
           let literal = \"@(not syntax)\"\n"
    | Error _ -> false)
    "the Merlin adapter did not erase only native observation markers";
  let observed = Evaluator.evaluate observed_document in
  expect observed.ok "native observation syntax did not compile and run";
  let find_trace predicate = List.find_opt predicate observed.traces in
  let answer_enter =
    find_trace (fun event ->
        String.equal event.phase "enter"
        && String.equal event.kind "binding"
        && String.equal event.label "answer")
  in
  let answer_return =
    find_trace (fun event ->
        String.equal event.phase "return"
        && String.equal event.kind "binding"
        && String.equal event.label "answer")
  in
  expect
    (match (answer_enter, answer_return) with
    | Some entered, Some returned ->
        String.equal entered.occurrence_id returned.occurrence_id
        && String.equal returned.detail "3"
        && String.equal returned.type_ "int"
    | _ -> false)
    "binding observation did not retain its type and result";
  let fib_child =
    match answer_enter with
    | None -> None
    | Some answer ->
        let callsite =
          find_trace (fun event ->
              String.equal event.phase "enter"
              && String.equal event.kind "call"
              && event.parent_id = Some answer.occurrence_id)
        in
        Option.bind callsite (fun callsite ->
            find_trace (fun event ->
                String.equal event.phase "enter"
                && String.equal event.kind "function"
                && String.equal event.label "fib"
                && event.parent_id = Some callsite.occurrence_id))
  in
  expect (Option.is_some fib_child)
    "function observations did not form a dynamic hierarchy";
  let fib_parameter =
    match fib_child with
    | None -> None
    | Some call ->
        find_trace (fun event ->
            String.equal event.phase "parameter"
            && String.equal event.occurrence_id call.occurrence_id
            && String.equal event.kind "parameter"
            && String.equal event.label "n")
  in
  expect
    (match fib_parameter with
    | Some event ->
        String.equal event.detail "4" && String.equal event.type_ "int"
    | None -> false)
    "function observations did not capture parameters per invocation";
  let add_call =
    find_trace (fun event ->
        String.equal event.phase "enter"
        && String.equal event.kind "function"
        && String.equal event.label "add")
  in
  let has_parameter (call : Evaluator.trace_event) label detail =
    List.exists
      (fun (event : Evaluator.trace_event) ->
        String.equal event.phase "parameter"
        && String.equal event.occurrence_id call.occurrence_id
        && String.equal event.label label
        && String.equal event.detail detail)
      observed.traces
  in
  expect
    (match add_call with
    | Some call ->
        has_parameter call "left" "2" && has_parameter call "right" "3"
    | None -> false)
    "function observations did not capture every curried parameter";
  let length_call =
    find_trace (fun event ->
        String.equal event.phase "enter"
        && String.equal event.kind "function"
        && String.equal event.label "length")
  in
  expect
    (match length_call with
    | Some call -> has_parameter call "values" "[1; 2; 3]"
    | None -> false)
    "function observations did not render list parameters";
  let head_call =
    find_trace (fun event ->
        String.equal event.phase "enter"
        && String.equal event.kind "function"
        && String.equal event.label "head_or_zero")
  in
  expect
    (match head_call with
    | Some call -> has_parameter call "argument" "[7; 8]"
    | None -> false)
    "function-case observations did not capture their implicit argument";
  let expression =
    find_trace (fun event ->
        String.equal event.phase "enter" && String.equal event.kind "expression")
  in
  expect
    (match expression with
    | Some event ->
        event.source_line = 4 && event.source_column = 27
        && event.source_end_column = 41
        && String.equal event.type_ "int"
    | None -> false)
    "expression observation did not preserve its editor source span";
  let unicode_expression =
    find_trace (fun event ->
        String.equal event.phase "enter"
        && String.equal event.kind "expression"
        && event.source_line = 11)
  in
  expect
    (match unicode_expression with
    | Some event ->
        event.source_column = 26
        && event.source_end_column = 44
        && String.equal event.type_ "string"
    | None -> false)
    "trace spans did not preserve CodeMirror UTF-16 columns";
  let returned label detail =
    List.exists
      (fun (event : Evaluator.trace_event) ->
        String.equal event.phase "return"
        && String.equal event.label label
        && String.equal event.detail detail)
      observed.traces
  in
  expect (returned "empty" "[]") "an empty list preview was not typed";
  expect (returned "flag" "true") "a boolean preview was not typed";
  expect (returned "nothing" "None") "an option preview was not typed";
  expect (returned "done_" "()") "a unit preview was not typed";
  let structured_document =
    Document.parse ~path:"structured.ml.md"
      "# Structured values\n\n\
      \    type sample = Stop | Next of int * sample list\n\
      \    type point = { x : int; y : int }\n\
      \    module Int_set = Set.Make (Int)\n\
      \    module String_map = Map.Make (String)\n\
      \    let sample = Next (1, [Stop; Next (2, [])])\n\
      \    let point = { x = 3; y = 4 }\n\
      \    let numbers = Int_set.of_list [3; 1; 2]\n\
      \    let environment = String_map.singleton \"id\" (Next (1, []))\n\
      \    let literal_ellipsis = \"...\"\n\
      \    let long_string = String.make 5000 'x'\n\
      \    let first, second = sample, point\n\
      \    let unpack (left, right) = left + right\n\
      \    let sum = unpack (2, 3)\n\
      \    let selected =\n\
      \      match Some sample with\n\
      \      | None -> Stop\n\
      \      | Some replacement -> replacement\n\
      \    let result =\n\
      \      match sample with\n\
      \      | Stop -> 0\n\
      \      | Next (head, rest) -> head + List.length rest\n"
  in
  let structured = Evaluator.evaluate structured_document in
  expect structured.ok "structured value previews did not compile and run";
  let structured_returned label detail =
    List.exists
      (fun (event : Evaluator.trace_event) ->
        String.equal event.phase "return"
        && String.equal event.label label
        && String.equal event.detail detail)
      structured.traces
  in
  expect
    (structured_returned "sample" "Next (1, [Stop; Next (2, [])])")
    "recursive variant values did not retain constructor names";
  expect
    (structured_returned "point" "{x = 3; y = 4}")
    "record values did not retain field names";
  let structured_detail label =
    List.find_map
      (fun (event : Evaluator.trace_event) ->
        if String.equal event.phase "return" && String.equal event.label label
        then Some event.detail
        else None)
      structured.traces
  in
  let raw_abstract = function
    | Some detail -> Util.starts_with ~prefix:"#" detail
    | None -> false
  in
  expect
    (raw_abstract (structured_detail "numbers"))
    "abstract set values did not retain an honest bounded runtime shape";
  expect
    (raw_abstract (structured_detail "environment"))
    "abstract map values did not retain an honest bounded runtime shape";
  expect
    (List.exists
       (fun (event : Evaluator.trace_event) ->
         String.equal event.phase "return"
         && String.equal event.label "literal_ellipsis"
         && String.equal event.detail "\"...\""
         && event.value_complete)
       structured.traces)
    "a literal ellipsis was mistaken for an incomplete preview";
  expect
    (List.exists
       (fun (event : Evaluator.trace_event) ->
         String.equal event.phase "return"
         && String.equal event.label "long_string"
         && not event.value_complete)
       structured.traces)
    "a bounded value preview did not report renderer truncation";
  expect
    (structured_returned "first" "Next (1, [Stop; Next (2, [])])"
     && structured_returned "second" "{x = 3; y = 4}")
    "destructuring bindings did not record every bound identifier";
  expect
    (structured_returned "left" "2" && structured_returned "right" "3"
     && structured_returned "head" "1"
     && structured_returned "rest" "[Stop; Next (2, [])]"
     && structured_returned "replacement"
          "Next (1, [Stop; Next (2, [])])")
    "function and match patterns did not record every bound identifier";
  let structured_pattern type_ detail =
    List.exists
      (fun (event : Evaluator.trace_event) ->
        String.equal event.phase "return"
        && String.equal event.kind "pattern"
        && String.equal event.type_ type_
        && String.equal event.detail detail)
      structured.traces
  in
  expect
    (structured_pattern "sample * point"
       "(Next (1, [Stop; Next (2, [])]), {x = 3; y = 4})")
    "a destructuring let pattern did not retain its matched value";
  expect
    (structured_pattern "int * int" "(2, 3)")
    "a function parameter pattern did not retain its matched value";
  expect
    (List.exists
       (fun (event : Evaluator.trace_event) ->
         String.equal event.phase "parameter"
         && String.equal event.label "argument1"
         && String.equal event.type_ "int * int"
         && String.equal event.detail "(2, 3)")
       structured.traces)
    "a destructured anonymous-function argument was omitted from its activation";
  expect
    (structured_pattern "sample option"
       "Some (Next (1, [Stop; Next (2, [])]))")
    "a constructor pattern displayed unit instead of its matched value";
  expect
    (structured_pattern "sample" "Next (1, [Stop; Next (2, [])])")
    "a match pattern did not retain its matched value";
  let exception_document =
    Document.parse ~path:"exception.ml.md"
      "# Exceptions\n\n\
      \    let @caught =\n\
      \      try @(raise (Failure \"boom\")) with Failure _ -> 7\n"
  in
  let exception_evaluation = Evaluator.evaluate exception_document in
  expect exception_evaluation.ok "a caught observed exception escaped";
  expect
    (List.exists
       (fun (event : Evaluator.trace_event) ->
         String.equal event.phase "raise"
         && String.equal event.kind "expression"
         && String.equal event.detail "Failure(\"boom\")")
       exception_evaluation.traces)
    "an observed exception did not emit a useful raise event";
  expect
    (List.exists
       (fun (event : Evaluator.trace_event) ->
         String.equal event.phase "return"
         && String.equal event.label "caught"
         && String.equal event.detail "7")
       exception_evaluation.traces)
    "the parent observation did not continue after a caught exception";
  let trace_document =
    Document.parse ~path:"trace.ml.md"
      "    let rec fib n =\n\
      \      if n < 2 then\n\
      \        n\n\
      \      else\n\
      \        fib (n - 1) + fib (n - 2)\n\
      \    let answer = fib 5\n\
      \    let incremented = List.map (fun value -> value + 1) [1; 2]\n\
      \    let cell = ref 1\n\
      \    let before = !cell\n\
      \    let () = cell := 2\n\
      \    let after = !cell\n\
      \    let values = [| 1; 2; 3 |]\n\
      \    let () = values.(1) <- 9\n\
      \    type box = { mutable item : int }\n\
      \    let box = { item = 1 }\n\
      \    let () = box.item <- 7\n"
  in
  let traced = Evaluator.evaluate trace_document in
  expect traced.ok "the execution-record fixture did not evaluate";
  let returned label detail =
    List.exists
      (fun (event : Evaluator.trace_event) ->
        String.equal event.phase "return"
        && String.equal event.kind "binding"
        && String.equal event.label label
        && String.equal event.detail detail)
      traced.traces
  in
  expect (returned "cell" "{contents = 1}")
    "a mutable value was not snapshotted when it was observed";
  expect (returned "before" "1" && returned "after" "2")
    "values around a mutation were not recorded at their execution time";
  expect (returned "values" "[|1; 2; 3|]")
    "an array snapshot was not recorded";
  let normalized_writes =
    Evaluator.execution_artifact_to_json traced
    |> Yojson.Safe.Util.member "execution"
    |> Yojson.Safe.Util.member "writes"
    |> Yojson.Safe.Util.to_list
  in
  expect
    (List.exists
       (fun write ->
         String.equal
           (write |> Yojson.Safe.Util.member "operation"
           |> Yojson.Safe.Util.to_string)
           "ref"
         && String.equal
              (write |> Yojson.Safe.Util.member "newValue"
              |> Yojson.Safe.Util.member "display"
              |> Yojson.Safe.Util.to_string)
              "2")
       normalized_writes)
    "a successful ref mutation did not emit a separate normalized write";
  expect
    (List.exists
       (fun write ->
         String.equal
           (write |> Yojson.Safe.Util.member "operation"
           |> Yojson.Safe.Util.to_string)
           "array"
         && String.equal
              (write |> Yojson.Safe.Util.member "newValue"
              |> Yojson.Safe.Util.member "display"
              |> Yojson.Safe.Util.to_string)
              "9")
       normalized_writes
    && List.exists
         (fun write ->
           String.equal
             (write |> Yojson.Safe.Util.member "operation"
             |> Yojson.Safe.Util.to_string)
             "field"
           && String.equal
                (write |> Yojson.Safe.Util.member "newValue"
                |> Yojson.Safe.Util.member "display"
                |> Yojson.Safe.Util.to_string)
                "7")
         normalized_writes)
    "array and mutable-record writes were not normalized with their new values";
  let callback_parameters =
    traced.traces
    |> List.filter (fun (event : Evaluator.trace_event) ->
        String.equal event.phase "parameter"
        && String.equal event.label "value")
    |> List.map (fun (event : Evaluator.trace_event) -> event.detail)
  in
  expect (callback_parameters = [ "1"; "2" ])
    "callbacks from uninstrumented library code did not re-enter the trace";
  expect
    (List.for_all
       (fun (event : Evaluator.trace_event) ->
         if
           List.mem event.phase
             [ "enter"; "return"; "raise"; "parameter" ]
         then String.equal event.path "trace.ml.md"
         else true)
       traced.traces)
    "library implementation details leaked into the user execution record";
  let alternative_document =
    Document.parse ~path:"alternatives.ml.md"
      "    type token = Zero | One | Two | Four\n\
      \    let classify = function\n\
      \      | Some (Zero | One) -> 1\n\
      \      | Some (Two | Four) -> 2\n\
      \      | None -> 0\n\
      \    let zero = classify (Some Zero)\n\
      \    let two = classify (Some Two)\n"
  in
  let alternatives = Evaluator.evaluate alternative_document in
  expect alternatives.ok "the or-pattern trace fixture did not evaluate";
  let matched_pattern line start_column end_column =
    List.exists
      (fun (event : Evaluator.trace_event) ->
        String.equal event.phase "enter"
        && String.equal event.kind "pattern"
        && event.source_line = line
        && event.source_column = start_column
        && event.source_end_column = end_column)
      alternatives.traces
  in
  expect
    (matched_pattern 3 14 18 && matched_pattern 4 14 17)
    "matched nested or-pattern alternatives did not emit their own execution \
     events";
  expect
    (not (matched_pattern 3 21 24) && not (matched_pattern 4 20 24))
    "unmatched nested or-pattern alternatives emitted execution events";
  expect
    (match
       Evaluator.execution_sites_with_cancel
         ~cancelled:(fun () -> false)
         ~documents:[ alternative_document ] ~target:alternative_document
     with
    | Error _ -> false
    | Ok sites ->
        List.exists
          (fun (site : Evaluator.execution_site) ->
            site.site_kind = "pattern" && site.site_direct)
          sites
        && List.exists
             (fun (site : Evaluator.execution_site) ->
               site.site_kind = "syntax"
               && site.site_role = Some "alternative"
               && Option.is_some site.site_target)
             sites)
    "the compiler index did not identify direct or-pattern leaves";
  let guarded_document =
    Document.parse ~path:"guarded.ml.md"
      "    let classify n =\n\
      \      match n with\n\
      \      | x when x > 0 -> x + 1\n\
      \      | _ -> 0\n"
  in
  expect
    (match
       Evaluator.execution_sites_with_cancel
         ~cancelled:(fun () -> false)
         ~documents:[ guarded_document ] ~target:guarded_document
     with
    | Error _ -> false
    | Ok sites ->
        List.exists
          (fun (site : Evaluator.execution_site) ->
            Option.is_some site.site_parent_id)
          sites
        && List.exists
             (fun (site : Evaluator.execution_site) ->
               site.site_kind = "pattern"
               && Option.is_some site.site_selection)
             sites
        && List.exists
             (fun (site : Evaluator.execution_site) ->
               site.site_kind = "pattern" && site.site_start_line = 3
               && Option.fold ~none:false
                    ~some:(fun (target : Evaluator.execution_site_range) ->
                      target.range_start_line = 3
                      && target.range_start_column >= 24)
                    site.site_target)
             sites
        && List.exists
             (fun (site : Evaluator.execution_site) ->
               site.site_kind = "expression"
               && site.site_role = Some "operator"
               && Option.is_some site.site_target)
             sites
        && List.exists
             (fun (site : Evaluator.execution_site) ->
               site.site_kind = "syntax" && site.site_role = Some "when"
               && Option.is_some site.site_target)
             sites)
    "compiler sites did not retain tree identity or map a guarded pattern to \
     its branch body";
  let lambda_pattern_document =
    Document.parse ~path:"lambda-pattern.ml.md"
      "    let project = fun (value, _) -> value\n"
  in
  expect
    (match
       Evaluator.execution_sites_with_cancel
         ~cancelled:(fun () -> false)
         ~documents:[ lambda_pattern_document ] ~target:lambda_pattern_document
     with
    | Error _ -> false
    | Ok sites ->
        let lambda_patterns =
          List.filter
            (fun (site : Evaluator.execution_site) ->
              site.site_kind = "pattern"
              && site.site_role = Some "lambda-parameter")
            sites
        in
        List.length lambda_patterns >= 3
        && List.for_all
             (fun (site : Evaluator.execution_site) ->
               Option.is_some site.site_target)
             lambda_patterns)
    "nested lambda argument patterns did not inherit their lambda invocation";
  let local_binding_document =
    Document.parse ~path:"local-binding.ml.md"
      "    let outer input =\n\
      \      let local = input + 1 in\n\
      \      List.map (fun value -> value + local) [ input ]\n"
  in
  expect
    (match
       Evaluator.execution_sites_with_cancel
         ~cancelled:(fun () -> false)
         ~documents:[ local_binding_document ] ~target:local_binding_document
     with
    | Error _ -> false
    | Ok sites ->
        let local_binding =
          List.find_opt
            (fun (site : Evaluator.execution_site) ->
              site.site_kind = "pattern" && site.site_start_line = 2
              && site.site_start_column = 10)
            sites
        in
        let nested_lambda =
          List.find_opt
            (fun (site : Evaluator.execution_site) ->
              site.site_kind = "syntax" && site.site_role = Some "function"
              && site.site_start_line = 3)
            sites
        in
        Option.fold ~none:false
          ~some:(fun (site : Evaluator.execution_site) ->
            Option.is_some site.site_selection
            && Option.is_none site.site_role)
          local_binding
        && Option.fold ~none:false
             ~some:(fun (site : Evaluator.execution_site) ->
               Option.fold ~none:false
                 ~some:(fun (target : Evaluator.execution_site_range) ->
                   target.range_start_line = 3)
                 site.site_target)
             nested_lambda)
    "local let binders were classified as parameters or a nested lambda was \
     mapped to its enclosing named function";
  let syntax_document =
    Document.parse ~path:"syntax.ml.md"
      "    let typed (f : int -> int) = f 0\n\
      \    let guarded = function\n\
      \      | value when value > 0 -> value\n\
      \      | _ -> 0\n\
      \    let rec exercise flag =\n\
      \      let value = if flag then 1 else 2 in\n\
      \      let apply = fun x -> x + value in\n\
      \      let counter = ref 0 in\n\
      \      while !counter < 1 do incr counter done;\n\
      \      for index = 0 to 0 do ignore (apply index) done;\n\
      \      match value with\n\
      \      |\n\
      \        0 -> 0\n\
      \      | other\n\
      \        -> other\n"
  in
  expect
    (match
       Evaluator.execution_sites_with_cancel
         ~cancelled:(fun () -> false)
         ~documents:[ syntax_document ] ~target:syntax_document
     with
    | Error _ -> false
    | Ok sites ->
        let targeted_roles =
          sites
          |> List.filter_map (fun (site : Evaluator.execution_site) ->
                 if site.site_kind = "syntax" && Option.is_some site.site_target
                 then site.site_role
                 else None)
        in
        let role_sites role =
          List.filter
            (fun (site : Evaluator.execution_site) ->
              site.site_kind = "syntax" && site.site_role = Some role)
            sites
        in
        List.for_all
          (fun role -> List.mem role targeted_roles)
          [
            "let";
            "rec";
            "if";
            "then";
            "else";
            "in";
            "function";
            "while";
            "for";
            "do";
            "done";
            "match";
            "with";
            "alternative";
            "arrow";
          ]
        && List.length (role_sites "arrow") = 6
        && List.for_all
             (fun (site : Evaluator.execution_site) ->
               Option.is_some site.site_target)
             (role_sites "arrow")
        && List.length (role_sites "alternative") = 4
        && List.for_all
             (fun (site : Evaluator.execution_site) ->
               Option.is_some site.site_target)
             (role_sites "alternative"))
    "compiler syntax did not map executable keywords to their constructs";
  let runtime_edge_document =
    Document.parse ~path:"runtime-edge.ml.md"
      "    type branch = Left of int | Right of int\n\
      \    let guarded = function\n\
      \      | Left x when x < 0 -> x\n\
      \      | Left x -> x + 1\n\
      \      | Right y -> y\n\
      \    let positive = guarded (Left 2)\n\
      \    type digit = Zero | One\n\
      \    let chosen = function\n\
      \      | Some ((Zero as value) | (One as value)) -> value\n\
      \      | None -> Zero\n\
      \    let zero = chosen (Some Zero)\n\
      \    let one = chosen (Some One)\n\
      \    let floats = [| 1.5; 2.25 |]\n"
  in
  let runtime_edges = Evaluator.evaluate runtime_edge_document in
  if not runtime_edges.ok then
    List.iter
      (fun (diagnostic : Evaluator.diagnostic) ->
        prerr_endline diagnostic.message)
      runtime_edges.diagnostics;
  expect runtime_edges.ok "pattern and float runtime fixture did not evaluate";
  let binding_returns label =
    runtime_edges.traces
    |> List.filter (fun (event : Evaluator.trace_event) ->
        String.equal event.phase "return"
        && String.equal event.kind "binding"
        && String.equal event.label label)
  in
  expect
    (List.length (binding_returns "x") >= 2)
    "a pattern binding was not recorded before a failed guard";
  let alternative_values = binding_returns "value" in
  let alternatives_are_exact =
    List.exists
      (fun (event : Evaluator.trace_event) -> String.equal event.detail "Zero")
      alternative_values
    && List.exists
         (fun (event : Evaluator.trace_event) -> String.equal event.detail "One")
         alternative_values
    && List.length
         (List.sort_uniq Int.compare
            (List.map
               (fun (event : Evaluator.trace_event) -> event.source_column)
               alternative_values))
       >= 2
  in
  if not alternatives_are_exact then
    List.iter
      (fun (event : Evaluator.trace_event) ->
        Printf.eprintf "value binding: %s at %d:%d-%d\n" event.detail
          event.source_line event.source_column event.source_end_column)
      alternative_values;
  expect
    alternatives_are_exact
    "or-pattern bindings did not retain each matched alternative's value and \
     source location";
  expect
    (List.exists
       (fun (event : Evaluator.trace_event) ->
         String.equal event.phase "return"
         && String.equal event.label "floats"
         && String.equal event.detail "[|1.5; 2.25|]")
       runtime_edges.traces)
    "a float array was not rendered from its unboxed runtime layout";
  let small_tail_document =
    Document.parse ~path:"small-tail.ml.md"
      "    let rec loop accumulator remaining =\n\
      \      if remaining = 0 then accumulator\n\
      \      else loop (accumulator + 1) (remaining - 1)\n\
      \    let result = loop 0 5\n"
  in
  let small_tail = Evaluator.evaluate small_tail_document in
  expect small_tail.ok "a small tail-recursive execution failed";
  let small_tail_execution =
    Evaluator.execution_artifact_to_json small_tail
    |> Yojson.Safe.Util.member "execution"
  in
  let activation_outcomes =
    small_tail_execution |> Yojson.Safe.Util.member "activations"
    |> Yojson.Safe.Util.to_list
    |> List.map (fun activation ->
        activation |> Yojson.Safe.Util.member "outcome"
        |> Yojson.Safe.Util.member "kind" |> Yojson.Safe.Util.to_string)
  in
  expect
    (activation_outcomes <> []
    && List.for_all (fun kind -> not (String.equal kind "incomplete"))
         activation_outcomes)
    "an explicit tail relation did not carry the final outcome back through every activation";
  let has_tail_attempt =
    small_tail_execution |> Yojson.Safe.Util.member "callAttempts"
    |> Yojson.Safe.Util.to_list
    |> List.exists (fun attempt ->
        attempt |> Yojson.Safe.Util.member "tail"
        |> Yojson.Safe.Util.to_bool)
  in
  expect has_tail_attempt
    "a compiler-recorded tail call was not marked as a tail call attempt";
  let tail_document =
    Document.parse ~path:"tail.ml.md"
      "    let rec loop accumulator remaining =\n\
      \      if remaining = 0 then accumulator\n\
      \      else loop (accumulator + 1) (remaining - 1)\n\
      \    let result = loop 0 100000\n\
      \    let () = print_endline (string_of_int result)\n"
  in
  let tail = Evaluator.evaluate tail_document in
  expect tail.ok "instrumentation broke a large tail-recursive execution";
  expect
    (List.exists
       (fun (output : Evaluator.block_output) ->
         String.equal output.stdout "100000\n")
       tail.block_outputs)
    "a large tail-recursive execution returned the wrong result";
  expect
    (tail.tail_handoffs > 0 && tail.tail_linked_enters > 0
    && tail.tail_handoff_outcomes = 0)
    "the bytecode evaluator did not preserve the raw tail-handoff invariant";
  let mixed_tail_document =
    Document.parse ~path:"mixed-tail.ml.md"
      "    let helper value = value + 1\n\
      \    let rec loop accumulator remaining =\n\
      \      if remaining = 0 then accumulator\n\
      \      else\n\
      \        let accumulator = helper accumulator in\n\
      \        loop accumulator (remaining - 1)\n\
      \    let mixed_result = loop 0 100000\n\
      \    let () = print_endline (string_of_int mixed_result)\n"
  in
  let mixed_tail = Evaluator.evaluate mixed_tail_document in
  expect mixed_tail.ok
    "a non-tail call in a tail-recursive function broke tail recursion";
  expect
    (List.exists
       (fun (output : Evaluator.block_output) ->
         String.equal output.stdout "100000\n")
       mixed_tail.block_outputs)
    "mixed non-tail and tail calls returned the wrong result";
  let higher_order_tail =
    Document.parse ~path:"higher-order-tail.ml.md"
      "    let increment value = value + 1\n\
      \    let apply function_ value = function_ value\n\
      \    let aliased = apply increment 4\n\
      \    let after_alias = aliased + 1\n\
      \    let map function_ values = List.map function_ values\n\
      \    let mapped = map (fun value -> value + 1) [1; 2; 3]\n\
      \    let add left right = left + right\n\
      \    let make value = add value\n\
      \    let partials = List.map make [1; 2; 3]\n\
      \    let applied = List.map (fun function_ -> function_ 10) partials\n\
      \    let after_partials = List.length applied\n\
      \    let first left = fun right -> left + right\n\
      \    let over function_ = function_ 2 3\n\
      \    let over_result = over first\n"
    |> Evaluator.evaluate
  in
  expect higher_order_tail.ok "a higher-order tail call did not evaluate";
  let apply_outcome =
    List.find_opt
      (fun (event : Evaluator.trace_event) ->
        String.equal event.kind "function" && String.equal event.label "apply"
        && String.equal event.phase "return" && String.equal event.detail "5")
      higher_order_tail.traces
  in
  expect (Option.is_some apply_outcome)
    "a higher-order caller did not inherit its tail callee's outcome";
  expect
    (List.exists
       (fun (event : Evaluator.trace_event) ->
         String.equal event.kind "call" && event.source_line = 2
         && String.equal event.phase "return" && String.equal event.detail "5")
       higher_order_tail.traces)
    "the higher-order tail call site did not retain an execution outcome";
  expect
    (List.exists
       (fun (event : Evaluator.trace_event) ->
         String.equal event.kind "call" && event.source_line = 5
         && String.equal event.phase "return"
         && String.equal event.detail "[2; 3; 4]")
       higher_order_tail.traces)
    "an uninstrumented tail callee inherited its first callback's outcome";
  let partial_outcomes =
    List.filter
      (fun (event : Evaluator.trace_event) ->
        String.equal event.kind "call" && event.source_line = 8
        && String.equal event.phase "return"
        && String.equal event.detail "<function>")
      higher_order_tail.traces
  in
  expect (List.length partial_outcomes = 3)
    "a partial application handed off before its function body entered";
  let make_occurrences =
    higher_order_tail.traces
    |> List.filter (fun (event : Evaluator.trace_event) ->
        String.equal event.kind "function" && String.equal event.label "make"
        && String.equal event.phase "enter")
    |> List.map (fun (event : Evaluator.trace_event) -> event.occurrence_id)
  in
  expect
    (List.for_all
       (fun (event : Evaluator.trace_event) ->
         not (String.equal event.label "after_partials")
         || Option.fold ~none:true
              ~some:(fun parent -> not (List.mem parent make_occurrences))
              event.parent_id)
       higher_order_tail.traces)
    "a partial application left a stale tail parent for later execution";
  expect
    (List.exists
       (fun (event : Evaluator.trace_event) ->
         String.equal event.label "over_result"
         && String.equal event.phase "return" && String.equal event.detail "5")
       higher_order_tail.traces)
    "tail tracing changed an overapplication's result";
  expect
    (List.for_all
       (fun (event : Evaluator.trace_event) ->
         if String.equal event.label "after_alias"
         then
           match apply_outcome with
           | Some apply -> event.parent_id <> Some apply.occurrence_id
           | None -> false
         else true)
       higher_order_tail.traces)
    "a completed higher-order tail caller remained on the runtime stack";
  let exceptional_tail =
    Document.parse ~path:"exceptional-tail.ml.md"
      "    let rec explode remaining =\n\
      \      let next =\n\
      \        if remaining = 0 then failwith \"boom\" else remaining - 1\n\
      \      in\n\
      \      explode next\n\
      \    let recovered = try explode 2 with Failure _ -> 42\n\
      \    let after_exception = recovered + 1\n"
    |> Evaluator.evaluate
  in
  expect exceptional_tail.ok
    "an exception before a tail handoff corrupted evaluation";
  let explode_enters =
    List.filter
      (fun (event : Evaluator.trace_event) ->
        String.equal event.kind "function"
        && String.equal event.label "explode"
        && String.equal event.phase "enter")
      exceptional_tail.traces
  in
  expect
    (explode_enters <> []
    && List.for_all
         (fun (entered : Evaluator.trace_event) ->
           List.exists
             (fun (event : Evaluator.trace_event) ->
               String.equal event.occurrence_id entered.occurrence_id
               && (String.equal event.phase "return"
                  || String.equal event.phase "raise"))
             exceptional_tail.traces)
         explode_enters)
    "tail callers were left without outcomes after a pre-handoff exception";
  let explode_occurrences =
    List.map
      (fun (event : Evaluator.trace_event) -> event.occurrence_id)
      explode_enters
  in
  expect
    (List.for_all
       (fun (event : Evaluator.trace_event) ->
         not (String.equal event.label "after_exception")
         || Option.fold ~none:true
              ~some:(fun parent -> not (List.mem parent explode_occurrences))
              event.parent_id)
       exceptional_tail.traces)
    "a raised tail caller remained the parent of later execution";
  let truncated_document =
    Document.parse ~path:"truncated.ml.md"
      "    let total = ref 0\n\
      \    let () =\n\
      \      for index = 1 to 100000 do\n\
      \        total := !total + index\n\
      \      done\n\
      \    let finished = !total\n"
  in
  let truncated = Evaluator.evaluate truncated_document in
  expect truncated.ok "trace truncation stopped an otherwise successful program";
  expect truncated.trace_truncated "a bounded trace did not report truncation";
  let open Yojson.Safe.Util in
  let truncated_root =
    Evaluator.to_json truncated |> member "executionArtifact"
    |> member "execution" |> member "activations" |> to_list
    |> List.find (fun activation ->
           match activation |> member "functionConstructId" with
           | `Null -> true
           | _ -> false)
  in
  expect
    (truncated_root |> member "outcomeAt" = `Null)
    "a truncated root activation claimed a completion time";
  expect
    (truncated_root |> member "outcome" |> member "kind" |> to_string
    = "incomplete")
    "a truncated root activation claimed a completed value";
  print_endline "evaluator tests passed"
