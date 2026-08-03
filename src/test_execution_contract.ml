let fail message =
  prerr_endline message;
  exit 1

let expect condition message = if not condition then fail message

let test_sha256_identity () =
  expect
    (String.equal (Util.sha256 "abc")
       "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    "the OCaml identity digest is not standard SHA-256"

let test_cross_language_source_identity () =
  let source =
    "# Intro\n\n\
     ```ocaml\n\
     let greeting = \"hé\"\n\
     ```\n\n\
     Inline `String.length greeting =`\n"
  in
  let document = Document.parse ~path:"unicode/δ.ml.md" source in
  expect
    (String.equal
       (Evaluator.request_code_digest_for_document document)
       "7fe572af53a6283b32cdb447ea8b7aaa382a561126c6df408ce4e703432b565c")
    "the OCaml executable-source identity diverged from the JavaScript protocol";
  expect
    (String.equal
       (Evaluator.document_revision_id document)
       "f58268539f90638cb50ea5e219e5b233f161fea20db1292950b9b8bbcb5b32c6")
    "the OCaml document identity diverged from the JavaScript protocol";
  let edge_source =
    "- prose item\n\
    \    continued prose\n\n\
    \    let x = 1\n\n\
    \    let y = x + 1\n\n\
     ```ocaml-example\n\
     let ignored = 0\n\
     ```\n\n\
     Inline `x + y =`\n"
  in
  let edge_document = Document.parse ~path:"edge.ml.md" edge_source in
  expect
    (String.equal
       (Evaluator.request_code_digest_for_document edge_document)
       "3a4df67294554aac0794c19665b6fabcb613eb7ff692af0986c32d6acdde9b84")
    "the executable-source identity disagreed on Markdown block boundaries";
  let crlf_source =
    "Mention a first.\r\n\
     \r\n\
     ```ocaml\r\n\
     let x = 1\r\n\
     ```\r\n\
     \r\n\
     Inline `z =` then `a =`\r\n"
  in
  let crlf_document = Document.parse ~path:"crlf.ml.md" crlf_source in
  let crlf_code_digest =
    Evaluator.request_code_digest_for_document crlf_document
  in
  expect
    (String.equal crlf_code_digest
       "32f8c8124288ab64b0b5b79a48c1273682645c0204e057d779891265b3184770")
    (Printf.sprintf
       "the executable-source identity disagreed on CRLF or inline order: %s"
       crlf_code_digest);
  expect
    (String.equal
       (Evaluator.document_revision_id crlf_document)
       "55286e906c801ecca634668708ada253735e0aa0033386b2b49a0de092e114a2")
    "the document identity disagreed on CRLF source";
  expect
    (String.equal
       (Evaluator.source_identity ~domain:"dox-document-source-v1"
          [
            ("😀.ml.md", [ ("source", "astral") ]);
            ("\u{e000}.ml.md", [ ("source", "private") ]);
          ])
       "1405eee1a0c19705603709c5da77774121e8b05984f48dd7a3689b6e3e2e56df")
    "the JavaScript and OCaml path order disagreed for non-ASCII paths";
  let tilde =
    Document.parse ~path:"tilde.ml.md" "~~~ocaml\nInline `1 + 2 =`\n~~~\n"
  in
  expect
    (Document.execution_identity_parts tilde = [])
    "the backend and browser disagreed about unsupported tilde fences";
  let tilde_indented =
    Document.parse ~path:"tilde-indented.ml.md"
      "~~~text\n    let hidden = 41\n~~~\n"
  in
  expect
    (Document.execution_identity_parts tilde_indented = [])
    "indented code leaked out of an unsupported tilde fence";
  let tilde_nested =
    Document.parse ~path:"tilde-nested.ml.md"
      "~~~text\n```ocaml\nlet hidden = 42\n```\n~~~\n"
  in
  expect
    (Document.execution_identity_parts tilde_nested = [])
    "a nested OCaml fence leaked out of an unsupported tilde fence";
  let indented_fence =
    Document.parse ~path:"indented-fence.ml.md"
      "    ```ocaml\nlet x = 1\n    ```\n"
  in
  expect
    (Document.execution_identity_parts indented_fence
    = [ ("block", "let x = 1\n") ])
    "the backend and browser disagreed about legacy backtick fences";
  let tabbed_fence =
    Document.parse ~path:"tabbed-fence.ml.md"
      "```ocaml\tname=tabbed\nlet answer = 42\n```\n"
  in
  expect
    (Document.execution_identity_parts tabbed_fence
    = [ ("block", "let answer = 42\n") ])
    "the backend and browser disagreed about tab-separated fence metadata";
  expect
    (List.exists
       (function Document.Code { id = "code-tabbed"; _ } -> true | _ -> false)
       tabbed_fence.blocks)
    "tab-separated fence metadata lost its block name"

let test_project_digest_identity () =
  let dependency =
    Document.parse ~path:"dependency.ml.md" "    let answer = 41\n"
  in
  let changed_dependency =
    Document.parse ~path:"dependency.ml.md" "    let answer = 42\n"
  in
  let target_a =
    Document.parse ~path:"target.ml.md"
      "    let result = Dependency.answer + 1\n"
  in
  let target_b =
    Document.parse ~path:"target.ml.md"
      "    let result = Dependency.answer + 2\n"
  in
  let digest_a =
    Evaluator.project_digest ~documents:[ dependency; target_a ]
      ~target:target_a
  in
  let digest_b =
    Evaluator.project_digest ~documents:[ dependency; target_b ]
      ~target:target_b
  in
  let digest_changed_dependency =
    Evaluator.project_digest
      ~documents:[ changed_dependency; target_b ]
      ~target:target_b
  in
  expect
    (String.equal digest_a digest_b)
    "editing the target changed the dependency project digest";
  expect
    (not (String.equal digest_b digest_changed_dependency))
    "editing a dependency did not change the dependency project digest"

let test_execution_identity_width () =
  let document = Document.parse ~path:"identity.ml.md" "    let x = 1\n" in
  let evaluation = Evaluator.evaluate document in
  expect evaluation.ok "the identity fixture did not evaluate";
  let artifact =
    Evaluator.to_json evaluation |> Yojson.Safe.Util.member "executionArtifact"
  in
  let field name =
    artifact |> Yojson.Safe.Util.member name |> Yojson.Safe.Util.to_string
  in
  let source_map_field name =
    artifact
    |> Yojson.Safe.Util.member "sourceMaps"
    |> Yojson.Safe.Util.member name
    |> Yojson.Safe.Util.to_string
  in
  expect
    (String.length (field "compilerInputsDigest") = 64)
    "compiler input identity is not SHA-256";
  expect
    (String.length (field "codeRevisionId") = 64)
    "code revision identity is not SHA-256";
  expect
    (String.length (source_map_field "extractedCodeDigest") = 64)
    "extracted code identity is not SHA-256"

let construct_ids evaluation =
  evaluation.Evaluator.compiler_manifests
  |> List.concat_map (fun manifest -> manifest.Evaluator.manifest_constructs)
  |> List.map (fun construct -> construct.Evaluator.construct_id)

let test_user_runtime_ownership () =
  let document =
    Document.parse ~path:"format.ml.md"
      "    let rendered = Printf.sprintf \"value: %d\" 42\n"
  in
  let evaluation = Evaluator.evaluate document in
  expect evaluation.ok "the formatting ownership fixture did not evaluate";
  let ids = construct_ids evaluation in
  let json = Evaluator.to_json evaluation in
  let open Yojson.Safe.Util in
  let traces = json |> member "traces" |> to_list in
  expect
    (List.for_all
       (fun trace -> List.mem (trace |> member "siteId" |> to_string) ids)
       traces)
    "a published runtime event escaped user-code ownership";
  let artifact = json |> member "executionArtifact" in
  let activations =
    artifact |> member "execution" |> member "activations" |> to_list
  in
  let root =
    List.find
      (fun activation ->
        match activation |> member "functionConstructId" with
        | `Null -> true
        | _ -> false)
      activations
  in
  let root_outcome = root |> member "outcomeAt" |> to_int in
  expect
    (List.for_all
       (fun activation ->
         activation |> member "outcomeAt" |> to_int <= root_outcome)
       activations)
    "a callback activation escaped the top-level activation lifetime"

let test_aliased_pattern_observation () =
  let document =
    Document.parse ~path:"alias.ml.md"
      "    type tree = Empty | Node of int\n\
      \    let value = function Node item as tree -> item, tree | Empty -> 0, \
       Empty\n\
      \    let result = value (Node 7)\n"
  in
  let evaluation = Evaluator.evaluate document in
  expect evaluation.ok "the aliased-pattern fixture did not evaluate";
  let constructors =
    evaluation.compiler_manifests
    |> List.concat_map (fun manifest -> manifest.Evaluator.manifest_constructs)
    |> List.filter (fun construct ->
        String.equal construct.Evaluator.construct_semantic_kind "constructor"
        && construct.construct_start_line = 2)
  in
  expect (constructors <> [])
    "the aliased constructor emitted no compiler construct";
  let observed =
    Evaluator.to_json evaluation
    |> Yojson.Safe.Util.member "executionArtifact"
    |> Yojson.Safe.Util.member "execution"
    |> Yojson.Safe.Util.member "occurrences"
    |> Yojson.Safe.Util.to_list
    |> List.map (fun occurrence ->
        occurrence
        |> Yojson.Safe.Util.member "constructId"
        |> Yojson.Safe.Util.to_string)
  in
  expect
    (List.exists
       (fun construct -> List.mem construct.Evaluator.construct_id observed)
       constructors)
    "the constructor inside an alias pattern was not observed";
  let aliases =
    evaluation.compiler_manifests
    |> List.concat_map (fun manifest -> manifest.Evaluator.manifest_constructs)
    |> List.filter (fun construct ->
        String.equal construct.Evaluator.construct_semantic_kind "alias"
        && construct.construct_start_line = 2)
  in
  let alias_occurrences =
    observed
    |> List.filter (fun construct_id ->
        List.exists
          (fun construct ->
            String.equal construct.Evaluator.construct_id construct_id)
          aliases)
  in
  expect
    (List.length alias_occurrences = 1)
    "an alias binder produced duplicate user-facing occurrences"

let test_exception_boundary_unwinding () =
  let document =
    Document.parse ~path:"exceptions.ml.md"
      "    let recover value =\n\
      \      try\n\
      \        let incremented = value + 1 in\n\
      \        if incremented > 0 then failwith \"boom\" else incremented\n\
      \      with Failure _ -> value * 2\n\
      \    let first = recover 21\n\
      \    let explode () = failwith \"outside\"\n\
      \    let second = try explode () with Failure _ -> first + 1\n\
      \    let third =\n\
      \      match raise Not_found with\n\
      \      | value -> value\n\
      \      | exception Not_found -> second + 1\n"
  in
  let evaluation = Evaluator.evaluate document in
  expect evaluation.ok "the exception-boundary fixture did not evaluate";
  expect
    (not evaluation.trace_truncated)
    "exception boundary unwinding truncated the trace";
  let completed occurrence_id =
    List.exists
      (fun (event : Evaluator.trace_event) ->
        String.equal event.occurrence_id occurrence_id
        && (String.equal event.phase "return"
           || String.equal event.phase "raise"))
      evaluation.traces
  in
  expect
    (List.for_all
       (fun (event : Evaluator.trace_event) ->
         (not (String.equal event.phase "enter"))
         || completed event.occurrence_id)
       evaluation.traces)
    "an exception left an execution observation open";
  expect
    (List.exists
       (fun (event : Evaluator.trace_event) ->
         String.equal event.phase "return"
         && String.equal event.label "third"
         && String.equal event.detail "44")
       evaluation.traces)
    "execution did not resume after a handled exception pattern"

let test_nested_pattern_observations () =
  let document =
    Document.parse ~path:"nested-patterns.ml.md"
      "    type atom = A of int | B of int\n\
      \    type side = Left of int | Right of int\n\
      \    let inspect input =\n\
      \      match input with\n\
      \      | ((A _ as whole), ((Left value | Right value) as side)) when \
       value < 0 -> 0\n\
      \      | ((A _ as whole), ((Left value | Right value) as side)) -> value\n\
      \      | (B _, _) -> -1\n\
      \    let first = inspect (A 7, Left 2)\n\
      \    let second = inspect (A 8, Right 3)\n"
  in
  let evaluation = Evaluator.evaluate document in
  expect evaluation.ok "the nested-pattern fixture did not evaluate";
  let constructs =
    evaluation.compiler_manifests
    |> List.concat_map (fun manifest -> manifest.Evaluator.manifest_constructs)
    |> List.filter (fun construct ->
        String.equal construct.Evaluator.construct_category "pattern")
  in
  let find_node ~line ~column ~kind =
    constructs
    |> List.filter (fun construct ->
        construct.Evaluator.construct_start_line = line
        && String.equal construct.construct_semantic_kind kind
        && construct.construct_start_column <= column
        && column < construct.construct_end_column)
    |> List.sort (fun left right ->
        Int.compare
          (left.Evaluator.construct_end_column - left.construct_start_column)
          (right.construct_end_column - right.construct_start_column))
    |> function
    | construct :: _ -> construct
    | [] ->
        let available =
          constructs
          |> List.filter (fun construct ->
              construct.Evaluator.construct_start_line = line)
          |> List.map (fun construct ->
              Printf.sprintf "%s:%d-%d"
                construct.Evaluator.construct_semantic_kind
                construct.construct_start_column construct.construct_end_column)
          |> String.concat ", "
        in
        fail
          (Printf.sprintf
             "no %s pattern construct covered %d:%d (available: %s)" kind line
             column available)
  in
  let returns construct =
    evaluation.traces
    |> List.filter (fun (event : Evaluator.trace_event) ->
        String.equal event.phase "return"
        && String.equal event.site_id construct.Evaluator.construct_id)
  in
  let details construct =
    returns construct |> List.map (fun event -> event.Evaluator.detail)
  in
  let expect_details construct expected message =
    let actual = details construct |> List.sort String.compare in
    let expected = List.sort String.compare expected in
    expect (actual = expected)
      (Printf.sprintf "%s: [%s]" message (String.concat "; " actual))
  in
  let guarded_tuple = find_node ~line:5 ~column:4 ~kind:"pattern" in
  let guarded_constructor = find_node ~line:5 ~column:6 ~kind:"constructor" in
  let guarded_wildcard = find_node ~line:5 ~column:8 ~kind:"wildcard" in
  let guarded_whole_alias = find_node ~line:5 ~column:13 ~kind:"alias" in
  let guarded_alternative = find_node ~line:5 ~column:34 ~kind:"alternative" in
  let guarded_left = find_node ~line:5 ~column:23 ~kind:"constructor" in
  let guarded_right = find_node ~line:5 ~column:36 ~kind:"constructor" in
  let guarded_side_alias = find_node ~line:5 ~column:52 ~kind:"alias" in
  expect_details guarded_tuple
    [ "(A (7), Left (2))"; "(A (8), Right (3))" ]
    "a tuple pattern did not retain its exact matched value before a false \
     guard";
  expect_details guarded_constructor [ "A (7)"; "A (8)" ]
    "a nested constructor did not retain its exact projected value";
  expect_details guarded_wildcard [ "7"; "8" ]
    "a nested wildcard did not retain its exact projected value";
  expect_details guarded_whole_alias [ "A (7)"; "A (8)" ]
    "a nested alias did not retain its exact projected value";
  expect_details guarded_alternative
    [ "Left (2)"; "Right (3)" ]
    "an or-pattern did not retain its exact projected value";
  expect_details guarded_left [ "Left (2)" ]
    "the selected left alternative was not observed exactly once";
  expect_details guarded_right [ "Right (3)" ]
    "the selected right alternative was not observed exactly once";
  expect_details guarded_side_alias
    [ "Left (2)"; "Right (3)" ]
    "an alias around an alternative did not retain its exact value";
  let unguarded_tuple = find_node ~line:6 ~column:4 ~kind:"pattern" in
  expect
    (List.length (returns unguarded_tuple) = 2)
    "a successful pattern emitted duplicate semantic occurrences";
  let unmatched_constructor = find_node ~line:7 ~column:5 ~kind:"constructor" in
  expect
    (returns unmatched_constructor = [])
    "an unmatched constructor emitted a runtime occurrence";
  let range_keys =
    constructs
    |> List.map (fun construct ->
        (construct.Evaluator.construct_start_byte, construct.construct_end_byte))
  in
  expect
    (List.length range_keys = List.length (List.sort_uniq compare range_keys))
    "a compiler-only Tpat_value wrapper received a duplicate manifest range"

let test_compound_tail_boundary_observation () =
  let document =
    Document.parse ~path:"tail-boundary.ml.md"
      "    let rec last = function\n\
      \      | [] -> 0\n\
      \      | head :: tail ->\n\
      \          let current = head in\n\
      \          match tail with [] -> current | _ -> last tail\n\
      \    let result = last [1; 2; 3]\n"
  in
  let evaluation = Evaluator.evaluate document in
  expect evaluation.ok "the compound tail-boundary fixture did not evaluate";
  let bindings =
    evaluation.compiler_manifests
    |> List.concat_map (fun manifest -> manifest.Evaluator.manifest_constructs)
    |> List.filter (fun construct ->
        String.equal construct.Evaluator.construct_semantic_kind "binding"
        && construct.construct_start_line = 4)
  in
  let observed =
    Evaluator.to_json evaluation
    |> Yojson.Safe.Util.member "executionArtifact"
    |> Yojson.Safe.Util.member "execution"
    |> Yojson.Safe.Util.member "occurrences"
    |> Yojson.Safe.Util.to_list
    |> List.map (fun occurrence ->
        occurrence
        |> Yojson.Safe.Util.member "constructId"
        |> Yojson.Safe.Util.to_string)
  in
  expect (bindings <> []) "the compound binding emitted no construct";
  expect
    (List.exists
       (fun binding -> List.mem binding.Evaluator.construct_id observed)
       bindings)
    "an executed compound boundary containing a tail call was not observed"

let test_crlf_source_map () =
  let document =
    Document.parse ~path:"crlf-map.ml.md"
      "Intro\r\n\r\n    let x = 1\r\n    let y = x + 1\r\n"
  in
  let evaluation = Evaluator.evaluate document in
  expect evaluation.ok "the CRLF source-map fixture did not evaluate";
  let y_selector =
    evaluation.compiler_manifests
    |> List.concat_map (fun manifest -> manifest.Evaluator.manifest_selectors)
    |> List.find (fun selector ->
        String.equal selector.Evaluator.selector_role "binder"
        && selector.selector_start_line = 4
        && selector.selector_start_column = 4)
  in
  let mapped =
    evaluation.source_map_entries
    |> List.find (fun entry ->
        entry.Evaluator.map_start_byte = y_selector.selector_start_byte
        && entry.map_end_byte = y_selector.selector_end_byte)
  in
  expect
    (mapped.map_start_utf16 = 29 && mapped.map_end_utf16 = 30)
    (Printf.sprintf
       "a CRLF source map used offsets %d-%d instead of normalized 29-30"
       mapped.map_start_utf16 mapped.map_end_utf16)

let () =
  test_sha256_identity ();
  test_cross_language_source_identity ();
  test_project_digest_identity ();
  test_execution_identity_width ();
  test_user_runtime_ownership ();
  test_aliased_pattern_observation ();
  test_exception_boundary_unwinding ();
  test_nested_pattern_observations ();
  test_compound_tail_boundary_observation ();
  test_crlf_source_map ();
  let document =
    Document.parse ~path:"contract.ml.md"
      "    let increment value = value + 1\n\
      \    let incremented = List.map (fun item -> increment item) [1; 2]\n\
      \    let answer = increment 41\n\
      \    let rec countdown value = if value = 0 then 0 else countdown (value \
       - 1)\n\
      \    let counted = countdown 2\n\
      \    let local value =\n\
      \      let rec loop current = if current = 0 then 0 else loop (current - \
       1) in\n\
      \      loop value\n\
      \    let locally_counted = local 2\n\n\
       `increment 2 =`\n"
  in
  let evaluation = Evaluator.evaluate document in
  expect evaluation.ok "the compiler contract fixture did not evaluate";
  let manifests = evaluation.compiler_manifests in
  let constructs =
    manifests
    |> List.concat_map (fun manifest -> manifest.Evaluator.manifest_constructs)
  in
  let scopes =
    manifests
    |> List.concat_map (fun manifest ->
        manifest.Evaluator.manifest_execution_scopes)
  in
  let selectors =
    manifests
    |> List.concat_map (fun manifest -> manifest.Evaluator.manifest_selectors)
  in
  let construct_ids =
    List.map (fun construct -> construct.Evaluator.construct_id) constructs
  in
  let scope_ids = List.map (fun scope -> scope.Evaluator.scope_id) scopes in
  expect (constructs <> []) "the compiler emitted no constructs";
  expect (scopes <> []) "the compiler emitted no execution scopes";
  expect (selectors <> []) "the compiler emitted no selectors";
  expect
    (List.length construct_ids
    = List.length (List.sort_uniq String.compare construct_ids))
    "compiler construct IDs were not unique";
  expect
    (List.length scope_ids
    = List.length (List.sort_uniq String.compare scope_ids))
    "compiler execution-scope IDs were not unique";
  expect
    (List.for_all
       (fun construct ->
         construct.Evaluator.construct_start_byte >= 0
         && construct.Evaluator.construct_end_byte
            >= construct.Evaluator.construct_start_byte
         && List.mem construct.Evaluator.construct_owner_scope_id scope_ids
         && List.mem construct.Evaluator.construct_lexical_scope_id scope_ids
         && (not
               (String.equal construct.Evaluator.construct_syntax_fingerprint ""))
         && (not
               (String.equal
                  construct.Evaluator.construct_lexical_ancestry_fingerprint ""))
         && Option.fold ~none:true
              ~some:(fun parent -> List.mem parent construct_ids)
              construct.Evaluator.construct_parent_id)
       constructs)
    "compiler byte ranges, containment, or execution-scope ownership were \
     invalid";
  expect
    (List.for_all
       (fun (event : Evaluator.trace_event) ->
         List.mem event.site_id construct_ids)
       evaluation.traces)
    "a runtime observation did not carry a compiler construct ID";
  let function_scopes =
    List.filter
      (fun scope -> String.equal scope.Evaluator.scope_kind "function")
      scopes
  in
  expect (function_scopes <> []) "the function received no execution scope";
  expect
    (List.for_all
       (fun scope ->
         Option.fold ~none:false
           ~some:(fun construct -> List.mem construct construct_ids)
           scope.Evaluator.scope_function_construct_id)
       function_scopes)
    "a function scope did not reference its compiler construct";
  expect
    (List.for_all
       (fun scope ->
         match scope.Evaluator.scope_function_construct_id with
         | None -> false
         | Some function_construct_id ->
             List.exists
               (fun construct ->
                 String.equal construct.Evaluator.construct_id
                   function_construct_id
                 && not
                      (String.equal construct.construct_owner_scope_id
                         scope.scope_id))
               constructs)
       function_scopes)
    "a function expression belonged to its body execution scope";
  expect
    (List.for_all
       (fun scope ->
         match scope.Evaluator.scope_function_construct_id with
         | None -> false
         | Some function_construct_id ->
             let children =
               List.filter
                 (fun construct ->
                   Option.equal String.equal
                     construct.Evaluator.construct_parent_id
                     (Some function_construct_id))
                 constructs
             in
             children <> []
             && List.for_all
                  (fun construct ->
                    String.equal construct.Evaluator.construct_owner_scope_id
                      scope.scope_id)
                  children)
       function_scopes)
    "a function body child did not belong to its function execution scope";
  let function_scope_by_construct =
    function_scopes
    |> List.filter_map (fun scope ->
        Option.map
          (fun construct_id -> (construct_id, scope.Evaluator.scope_id))
          scope.scope_function_construct_id)
  in
  let artifact = Evaluator.execution_artifact_to_json evaluation in
  let open Yojson.Safe.Util in
  let normalized_execution_fields =
    match artifact |> member "execution" with
    | `Assoc fields -> fields
    | _ -> failwith "normalized execution was not an object"
  in
  expect
    (not (List.mem_assoc "traceTruncated" normalized_execution_fields))
    "normalized execution duplicated terminal truncation state";
  let normalized_selectors =
    artifact |> member "staticProgram" |> member "selectors" |> to_list
  in
  let normalized_source_maps =
    artifact |> member "sourceMaps" |> member "entries" |> to_list
  in
  let normalized_selector_ids =
    List.map
      (fun selector -> selector |> member "id" |> to_string)
      normalized_selectors
  in
  let mapped_selector_ids =
    List.map
      (fun entry -> entry |> member "selectorId" |> to_string)
      normalized_source_maps
  in
  expect
    (List.length normalized_selector_ids = List.length mapped_selector_ids
    && List.for_all
         (fun id ->
           List.length (List.filter (String.equal id) mapped_selector_ids) = 1)
         normalized_selector_ids
    && List.for_all
         (fun id -> List.mem id normalized_selector_ids)
         mapped_selector_ids)
    "normalized selectors and source maps did not form an ID bijection";
  expect
    (List.length selectors >= List.length normalized_selectors)
    "normalization invented selectors absent from the compiler manifest";
  let activations =
    artifact |> member "execution" |> member "activations" |> to_list
  in
  expect
    (List.for_all
       (fun activation ->
         match activation |> member "functionConstructId" with
         | `Null -> true
         | `String construct_id ->
             let expected_scope =
               List.assoc construct_id function_scope_by_construct
             in
             String.equal
               (activation |> member "scopeId" |> to_string)
               expected_scope
         | _ -> false)
       activations)
    "a function activation did not use its function execution scope";
  expect
    (List.for_all
       (fun selector ->
         List.mem selector.Evaluator.selector_subject_id construct_ids
         && not (String.equal selector.Evaluator.selector_syntax_fingerprint ""))
       selectors)
    "a compiler selector did not reference its construct";
  expect
    (List.exists
       (fun selector -> String.equal selector.Evaluator.selector_role "callee")
       selectors)
    "a function application received no callee selector";
  let equals_selectors =
    List.filter
      (fun selector -> String.equal selector.Evaluator.selector_role "equals")
      selectors
  in
  expect (equals_selectors <> []) "a value binding received no equals selector";
  expect
    (List.for_all
       (fun selector ->
         selector.Evaluator.selector_end_byte
         = selector.Evaluator.selector_start_byte + 1)
       equals_selectors)
    "an equals selector did not cover exactly the equals sign";
  let rec_selectors =
    List.filter
      (fun selector -> String.equal selector.Evaluator.selector_role "rec")
      selectors
  in
  expect
    (List.length rec_selectors >= 2)
    "top-level and local recursive bindings did not receive rec selectors";
  expect
    (List.for_all
       (fun selector ->
         selector.Evaluator.selector_end_byte
         = selector.Evaluator.selector_start_byte + 3)
       rec_selectors)
    "a rec selector did not cover exactly the rec keyword";
  let function_context_selectors =
    List.filter
      (fun selector ->
        String.equal selector.Evaluator.selector_role "function-context")
      selectors
  in
  expect
    (function_context_selectors <> [])
    "a line-ending function received no context selector";
  expect
    (List.for_all
       (fun selector ->
         selector.Evaluator.selector_start_byte
         = selector.Evaluator.selector_end_byte)
       function_context_selectors)
    "a function context selector was not a point boundary";
  expect
    (List.for_all
       (fun selector ->
         if not (String.equal selector.Evaluator.selector_role "binder") then
           true
         else
           match
             List.find_opt
               (fun construct ->
                 String.equal construct.Evaluator.construct_id
                   selector.selector_subject_id)
               constructs
           with
           | Some construct
             when construct.construct_start_line = 2
                  && String.equal construct.construct_semantic_kind "function"
             ->
               false
           | Some _ | None -> true)
       selectors)
    "a nested anonymous function stole the surrounding binding selector";
  expect
    (List.for_all
       (fun activation ->
         match activation |> member "functionConstructId" with
         | `Null -> true
         | `String _ ->
             not
               (String.contains
                  (activation |> member "outcome" |> member "value"
                 |> member "type" |> to_string)
                  '-')
         | _ -> false)
       activations)
    "a function outcome retained the function type";
  expect
    (evaluation.source_map_entries <> [])
    "the artifact emitted no compiler-to-document source map";
  expect
    (List.for_all
       (fun entry ->
         (not (String.equal entry.Evaluator.map_selector_id ""))
         && String.equal entry.Evaluator.map_document_path "contract.ml.md"
         && entry.map_start_byte >= 0
         && entry.map_end_byte >= entry.map_start_byte
         && entry.map_start_utf16 >= 0
         && entry.map_end_utf16 >= entry.map_start_utf16)
       evaluation.source_map_entries)
    "a compiler-to-document source-map entry was invalid";
  expect
    (List.exists
       (fun entry -> entry.Evaluator.map_start_utf16 >= 70)
       evaluation.source_map_entries)
    "the inline expression received no compiler-to-document source map";
  print_endline "execution contract tests passed"
