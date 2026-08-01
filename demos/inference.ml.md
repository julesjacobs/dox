# Hindley–Milner type inference

Hindley–Milner inference finds a principal type without requiring annotations.
This page implements the essential Algorithm W and then records the calls that
produce a type.

The expression language has variables, functions, application, local
definitions, pairs, integers, and booleans:

    type expression =
      | Variable of string
      | Function of string * expression
      | Apply of expression * expression
      | Let of string * expression * expression
      | Pair of expression * expression
      | Integer of int
      | Boolean of bool
    type typ =
      | Type_variable of int
      | Arrow of typ * typ
      | Product of typ * typ
      | Int
      | Bool
    module Int_set = Set.Make (Int)
    module String_map = Map.Make (String)
    type scheme = Forall of Int_set.t * typ
    type environment = scheme String_map.t
    type substitution = (int * typ) list
    exception Type_error of string
    let rec describe_expression = function
      | Variable name -> name
      | Function (parameter, body) ->
          "fun " ^ parameter ^ " -> " ^ describe_expression body
      | Apply (function_, argument) ->
          describe_expression function_
          ^ " (" ^ describe_expression argument ^ ")"
      | Let (name, value, body) ->
          "let " ^ name ^ " = " ^ describe_expression value
          ^ " in " ^ describe_expression body
      | Pair (left, right) ->
          "(" ^ describe_expression left ^ ", "
          ^ describe_expression right ^ ")"
      | Integer value -> string_of_int value
      | Boolean value -> string_of_bool value
    let rec describe_type = function
      | Type_variable variable -> "t" ^ string_of_int variable
      | Arrow (input, output) ->
          "(" ^ describe_type input ^ " -> "
          ^ describe_type output ^ ")"
      | Product (left, right) ->
          "(" ^ describe_type left ^ " * "
          ^ describe_type right ^ ")"
      | Int -> "int"
      | Bool -> "bool"

## Substitution and unification

A substitution assigns types to type variables. Unification constructs the
smallest substitution that makes two types equal. Each recursive call records
the readable equation it is solving in the context pane.

    let rec free_type_variables = function
      | Type_variable variable -> Int_set.singleton variable
      | Arrow (left, right) | Product (left, right) ->
          Int_set.union
            (free_type_variables left)
            (free_type_variables right)
      | Int | Bool -> Int_set.empty
    let free_scheme (Forall (quantified, body)) =
      Int_set.diff (free_type_variables body) quantified
    let free_environment environment =
      String_map.fold
        (fun _ scheme free ->
          Int_set.union (free_scheme scheme) free)
        environment Int_set.empty
    let rec apply_type substitution = function
      | Type_variable variable as original ->
          (match List.assoc_opt variable substitution with
           | None -> original
           | Some replacement -> apply_type substitution replacement)
      | Arrow (left, right) ->
          Arrow
            (apply_type substitution left, apply_type substitution right)
      | Product (left, right) ->
          Product
            (apply_type substitution left, apply_type substitution right)
      | Int -> Int
      | Bool -> Bool
    let apply_scheme substitution (Forall (quantified, body)) =
      let available =
        List.filter
          (fun (variable, _) -> not (Int_set.mem variable quantified))
          substitution
      in
      Forall (quantified, apply_type available body)
    let apply_environment substitution environment =
      String_map.map (apply_scheme substitution) environment
    let compose after before =
      List.append
        (List.map
           (fun (variable, body) ->
             variable, apply_type after body)
           before)
        after
    let bind variable body =
      if body = Type_variable variable then []
      else if Int_set.mem variable (free_type_variables body) then
        raise (Type_error "a type would contain itself")
      else [ variable, body ]
    let rec unify left right =
      let unify_step equation =
        let _ = equation in
        match left, right with
        | Int, Int | Bool, Bool -> []
        | Type_variable variable, body
        | body, Type_variable variable ->
            bind variable body
        | Arrow (left_input, left_output),
          Arrow (right_input, right_output)
        | Product (left_input, left_output),
          Product (right_input, right_output) ->
            let first = unify left_input right_input in
            let second =
              unify
                (apply_type first left_output)
                (apply_type first right_output)
            in
            compose second first
        | _ -> raise (Type_error "these types cannot be unified")
      in
      unify_step
        (describe_type left ^ " = " ^ describe_type right)

## Algorithm W

Generalization turns variables not fixed by the environment into polymorphic
variables. Instantiation replaces those variables with fresh ones at each use.

    let next_type_variable = ref 0
    let fresh_type_variable () =
      let variable = !next_type_variable in
      next_type_variable := variable + 1;
      Type_variable variable
    let instantiate (Forall (quantified, body)) =
      let substitution =
        quantified
        |> Int_set.elements
        |> List.map (fun variable ->
             variable, fresh_type_variable ())
      in
      apply_type substitution body
    let generalize environment body =
      let quantified =
        Int_set.diff
          (free_type_variables body)
          (free_environment environment)
      in
      Forall (quantified, body)
    let rec infer environment expression =
      let infer_step form =
        let _ = form in
        match expression with
        | Integer _ -> [], Int
        | Boolean _ -> [], Bool
        | Variable name ->
            (match String_map.find_opt name environment with
             | Some scheme -> [], instantiate scheme
             | None -> raise (Type_error ("unbound variable " ^ name)))
        | Function (parameter, body) ->
            let parameter_type = fresh_type_variable () in
            let environment =
              String_map.add parameter
                (Forall (Int_set.empty, parameter_type))
                environment
            in
            let substitution, body_type = infer environment body in
            substitution,
            Arrow
              (apply_type substitution parameter_type, body_type)
        | Apply (function_, argument) ->
            let function_substitution, function_type =
              infer environment function_
            in
            let argument_substitution, argument_type =
              infer
                (apply_environment function_substitution environment)
                argument
            in
            let result_type = fresh_type_variable () in
            let result_substitution =
              unify
                (apply_type argument_substitution function_type)
                (Arrow (argument_type, result_type))
            in
            compose result_substitution
              (compose argument_substitution function_substitution),
            apply_type result_substitution result_type
        | Let (name, value, body) ->
            let value_substitution, value_type =
              infer environment value
            in
            let environment =
              apply_environment value_substitution environment
            in
            let scheme =
              generalize environment
                (apply_type value_substitution value_type)
            in
            let body_substitution, body_type =
              infer (String_map.add name scheme environment) body
            in
            compose body_substitution value_substitution, body_type
        | Pair (left, right) ->
            let left_substitution, left_type =
              infer environment left
            in
            let right_substitution, right_type =
              infer
                (apply_environment left_substitution environment)
                right
            in
            compose right_substitution left_substitution,
            Product
              (apply_type right_substitution left_type, right_type)
      in
      infer_step (describe_expression expression)

## A polymorphic program

The example defines `id` once, then applies it to both an integer and a boolean.
That only type-checks because the local definition is generalized.

    let example =
      Let
        ( "id",
          Function ("value", Variable "value"),
          Pair
            ( Apply (Variable "id", Integer 7),
              Apply (Variable "id", Boolean true) ) )
    let principal_type expression =
      next_type_variable := 0;
      let substitution, inferred =
        infer String_map.empty expression
      in
      apply_type substitution inferred

Type variables are rendered with familiar letter names:

    let string_of_type inferred =
      let names = Hashtbl.create 8 in
      let next_name = ref 0 in
      let name variable =
        match Hashtbl.find_opt names variable with
        | Some name -> name
        | None ->
            let name =
              Printf.sprintf "'%c"
                (Char.chr (Char.code 'a' + !next_name))
            in
            next_name := !next_name + 1;
            Hashtbl.add names variable name;
            name
      in
      let rec render nested = function
        | Type_variable variable -> name variable
        | Int -> "int"
        | Bool -> "bool"
        | Product (left, right) ->
            render true left ^ " * " ^ render true right
        | Arrow (input, output) ->
            let rendered =
              render true input ^ " -> " ^ render false output
            in
            if nested then "(" ^ rendered ^ ")" else rendered
      in
      render false inferred
    let inferred_type = principal_type example
    let () =
      Doc.value ~id:"principal-type" ~type_:"typ"
        (string_of_type inferred_type)

The result is `int * bool`. Select an `infer_step` or `unify_step` occurrence in
the context pane to inspect the expression or type equation for that exact
step. Clicking the trace returns to the source that produced the event.
