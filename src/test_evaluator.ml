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
  let document = Document.parse ~path:"runtime.live.md" source in
  let evaluation = Evaluator.evaluate document in
  expect evaluation.ok "valid document did not evaluate";
  expect
    (evaluation.stdout = "first\n\nsecond\n")
    "ordinary stdout was not preserved byte-for-byte";
  expect
    (match evaluation.block_outputs with
    | [ output ] ->
        output.block_id = "code-output"
        && output.path = "runtime.live.md"
        && output.stdout = "first\n\nsecond\n"
        && output.stderr = ""
    | _ -> false)
    "ordinary stdout was not attributed to its code block";
  let two_blocks =
    Document.parse ~path:"two-blocks.live.md"
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
    Document.parse ~path:"inline.live.md"
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
    Document.parse ~path:"nested-inline.live.md" "Nested: `@(1) + 2 =`.\n"
    |> Evaluator.evaluate
  in
  expect
    (match nested_inline_observation.inline_results with
    | [ result ] -> result.type_ = "int" && result.value = "3"
    | _ -> false)
    "a nested observation replaced the enclosing inline result";
  let isolated_inline_failure =
    Document.parse ~path:"inline-failure.live.md"
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
         not (Util.starts_with ~prefix:"<doclang-inline:" event.path))
       isolated_inline_failure.traces)
    "synthetic inline observations leaked into the execution trace";
  let invalid_inline =
    Document.parse ~path:"invalid-inline.live.md"
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
         diagnostic.path = Some "invalid-inline.live.md"
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
    Document.parse ~path:"invalid.live.md"
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
    Document.parse ~path:"oversized.live.md"
      "```ocaml\n\
       let () = Doc.text ~id:\"large\" (String.make 2100000 'x')\n\
       ```\n"
    |> Evaluator.evaluate
  in
  expect
    (String.equal oversized_view.status "output-limited")
    "structured runtime output escaped the output cap";
  let typed_document =
    Document.parse ~path:"types.live.md"
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
    Evaluator.complete_at_with_cancel ~cancelled:(fun () -> false)
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
    Evaluator.complete_at_with_cancel ~cancelled:(fun () -> false)
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
    Document.parse ~path:"library.live.md"
      "# Library\n\n    let @imported_values = [ 1.; 2. ]\n"
  in
  let importing_document =
    Document.parse ~path:"consumer.live.md"
      "# Consumer\n\n    let imported_count = List.length imported_values\n"
  in
  let imported_type =
    Evaluator.type_at
      ~documents:[ imported_document; importing_document ]
      ~target:importing_document ~line:3 ~column:44
  in
  expect
    (match imported_type with
    | Ok (Some info) -> String.equal info.type_ "float list"
    | _ -> false)
    "Merlin cursor query did not include imported live documents";
  let imported_completions =
    Evaluator.complete_at_with_cancel ~cancelled:(fun () -> false)
      ~documents:[ imported_document; importing_document ]
      ~target:importing_document ~line:3 ~column:32 ~context:""
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
  let unicode_document =
    Document.parse ~path:"unicode.live.md"
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
    Document.parse ~path:"spanning.live.md"
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
    Document.parse ~path:"observed.live.md"
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
      \    let @count = length [1; 2; 3]\n"
  in
  let erased_observations =
    Observation.erase ~path:"observed.live.md" ~start_line:1
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
        find_trace (fun event ->
            String.equal event.phase "enter"
            && String.equal event.kind "function"
            && String.equal event.label "fib"
            && event.parent_id = Some answer.occurrence_id)
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
  let exception_document =
    Document.parse ~path:"exception.live.md"
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
  print_endline "evaluator tests passed"
