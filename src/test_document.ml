let fail message =
  prerr_endline message;
  exit 1

let expect condition message = if not condition then fail message

let () =
  let source =
    "# Demo\n\n\
     Words.\n\n\
     ```ocaml name=math\n\
     let twice x = x * 2\n\
     ```\n\n\
     ```ocaml-example\n\
     let not_run = false\n\
     ```\n"
  in
  let document = Document.parse ~path:"demo.ml.md" source in
  expect (document.title = "Demo") "title was not parsed";
  expect (List.length document.blocks = 4) "unexpected block count";
  expect
    (String.trim (Document.program_source document) = "let twice x = x * 2")
    "program source included the wrong blocks";
  expect
    (List.exists
       (function Document.Code { id = "code-math"; _ } -> true | _ -> false)
       document.blocks)
    "named code block did not receive a stable identity";
  match document.definitions with
  | [ definition ] ->
      expect (definition.name = "twice") "definition name was not parsed";
      let malformed =
        Document.parse ~path:"bad.ml.md"
          "```ocaml name=duplicate\n\
           let a = 1\n\
           ```\n\
           ```ocaml name=duplicate\n\
           let b = 2\n"
      in
      expect
        (List.length malformed.issues >= 2)
        "unclosed and duplicate fences were not diagnosed";
      let dependencies =
        Document.parse ~path:"dependencies.ml.md"
          "```ocaml\n\
           let observations = [ 1.; 2. ]\n\
           let mean = List.fold_left ( +. ) 0. observations\n\
           ```\n"
      in
      let observations =
        List.find
          (fun item -> item.Document.name = "observations")
          dependencies.definitions
      in
      let mean =
        List.find
          (fun item -> item.Document.name = "mean")
          dependencies.definitions
      in
      expect
        (observations.references = [])
        "an earlier definition received a false forward dependency";
      expect
        (mean.references = [ "observations" ])
        "a later definition lost its lexical dependency";
      let indented =
        Document.parse ~path:"indented.ml.md"
          "# Indented OCaml\n\n\
           A paragraph.\n\n\
          \    let answer = 6 * 7\n\
          \    let () = Doc.value ~id:\"answer\" ~type_:\"int\" (string_of_int \
           answer)\n\n\
           More prose.\n"
      in
      expect
        (String.trim (Document.program_source indented)
        = "let answer = 6 * 7\n\
           let () = Doc.value ~id:\"answer\" ~type_:\"int\" (string_of_int \
           answer)")
        "four-space Markdown code was not parsed as OCaml";
      expect
        ((List.find
            (fun item -> item.Document.name = "answer")
            indented.definitions)
           .line = 5)
        "indented OCaml source location was incorrect";
      let nested_lists =
        Document.parse ~path:"lists.ml.md"
          "# Lists\n\n- first\n    - nested\n    continued detail\n- second\n"
      in
      expect
        (String.equal (Document.program_source nested_lists) "")
        "nested Markdown list content was misclassified as OCaml";
      let inline =
        Document.parse ~path:"inline.ml.md"
          "Plain `code` and computed `1 + 2 =`.\n\
           Double-backtick ``3 + 4 =`` then `5 + 6 =`.\n\
           Escaped \\`7 + 8 =\\` is literal.\n\
           ```text\n\
           Fenced `9 + 10 =` is literal.\n\
           ```\n"
      in
      let inline_expressions = Document.inline_expressions inline in
      (match inline_expressions with
      | [ expression; after_double ] ->
          expect
            (expression.expression = "1 + 2")
            "inline OCaml expression text was incorrect";
          expect (expression.line = 1) "inline OCaml expression line was wrong";
          expect
            (expression.result_column > expression.column_end)
            "inline OCaml result position was incorrect";
          expect
            (after_double.expression = "5 + 6")
            "a double-backtick span suppressed a later inline expression"
      | expressions ->
          fail
            (Printf.sprintf
               "inline OCaml expression discovery returned %d expressions in \
                %d blocks, source=%S"
               (List.length expressions)
               (List.length inline.blocks)
               inline.source));
      print_endline "document tests passed"
  | _ -> fail "unexpected definitions"
