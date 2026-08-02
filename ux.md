Execution-Trace UX
1. Focus

The debugger focuses one dynamic expression occurrence:

```
(run, function activation, expression occurrence)
```


The source always represents one coherent function activation.

The selected expression is highlighted.

Expressions reached by the activation receive a soft highlight.

Untaken paths are visually inactive.

Dynamic call navigation enters the actual callee activation.

Navigating from the function definition returns to the actual caller.

2. Source annotations

A source line has at most one single-line annotation to its right:

```
let comparison = Int.compare needle value in     1
```


There is no separator or box. Typesetting distinguishes annotation from code.

Annotations:

occupy a fixed horizontal lane;

move right when a source line crosses that lane, leaving a two-column gap;

never wrap or change line height;

keep executable source on one visual row and use unobtrusive horizontal
scrolling when it is wider than the page;

use bounded value renderings;

expand in the detail view rather than inline.

3. Persistent annotation rules

Persistent annotations show values crossing structural boundaries.

Bindings

For:

```
let pattern = expression
```


show the value produced by expression:

```
let comparison = Int.compare needle value in     1
```

```
let substitution, inferred =
  infer environment expression                   ([t0 ↦ int], int)
```


Do not repeat binder names. The source pattern already describes how the value is decomposed.

Attach a multiline binding’s annotation to the line containing its pattern:

```
let first_squares =                               [0; 1; 4; 9; 16; 25; 36]
  List.init 7 Fun.id
  |> List.map square
```

Matches

For:

```
match expression with
```


show the scrutinee:

```
match expression with                             Apply(Variable "id", Integer 7)
```


Path highlighting identifies the selected clause. Do not annotate conditions with booleans.

A function expression’s scrutinee is already a function input, so it is not repeated:

```
let rec search needle = function                  13 · Node(…, 12, …)
```

Function entry

For a multiline function, show argument values in parameter order:

```
let add left right =                              3 · 4
```

```
let f (left, right) option =                      (3, 4) · Some 7
```


Do not repeat parameter names or display captured closure values.

Function exit

Annotate the expression whose value leaves the activation:

```
else search needle right                         ↩ true
```

```
else fib (n - 1) + fib (n - 2)                   ↩ 5
```


For exceptional completion:

```
raise (Type_error message)                       ⇑ Type_error("…")
```


For a one-line function, combine entry and exit:

```
let square number = number * number              9 → 81
```

Mutation

Show the value written:

```
next_type_variable := variable + 1               4
```


The detail view may additionally show:

```
next_type_variable: 3 → 4
```

Multiple boundaries on one line

Use one annotation:

A one-line function shows inputs → result.

Otherwise, the outermost structural boundary wins.

Inner expression values remain selectable with the cursor.

```
let result = match expression with ...           result-value
```

4. Value under the cursor

The exact selected AST span is highlighted. Its value temporarily replaces the persistent annotation on that physical line.

Persistent annotation:

```
let comparison = Int.compare needle value in     1
```


Cursor on needle:

```
let comparison = Int.compare needle value in     13
                             ──────
```


Moving the cursor away restores 1. If both values are identical, nothing changes.

Expression-selection rules
Cursor location	Selected value
Pattern binder	Value bound to that binder
Ordinary identifier	Value read at that occurrence
Identifier in function position	Result of its saturated call
Literal	Literal value
Other expression	Value of the smallest enclosing evaluated expression
let or its pattern	RHS value
rec	The recursive binding activation, with no keyword value
match	Scrutinee value
if	Condition value
Function-definition name	Preserve function-entry annotation
Function position

If a function has no activation, every surface of its definition selects the
same empty, defined-but-not-called state. Creating its closure does not borrow
the surrounding top-level activation.

A callable identifier selects the source-level invocation it initiates:

```
Int.compare needle value
^^^^^^^^^^^                                      1
```

```
search needle right
^^^^^^                                           true
```


Saturation follows the function definition:

```
let add x y = x + y
add 3 4
^^^                                              7
```


But:

```
let make_adder x = fun y -> x + y
make_adder 3 4
^^^^^^^^^^                                       <function>
```


make_adder is saturated after 3; applying the returned closure to 4 is a separate invocation.

The same semantic rule applies to pipelines, methods and operators.

5. Syntax styles

The editor uses two stable semantic styles relevant to pattern correspondence.

Variable style

Used normally for:

variable binders;

parameters;

variable references;

variable patterns.

Constructor/shape style

Used normally for:

constructors in declarations;

constructors in expressions;

constructors in patterns;

constructors in ordinary rendered values.

Keywords and punctuation retain their ordinary neutral styles.

Colors never depend on which variable is selected and never get reassigned.

6. Pattern-directed value rendering

Values entering patterns are rendered according to the pattern that consumes them.

Structure explicitly matched by the pattern uses constructor/shape style.

A complete subvalue captured by a variable uses variable style.

Rendering stops descending once a variable binder is reached.

Wildcards use constructor/shape style because they bind nothing.

The specification uses an aligned role line:

```
S = constructor/shape style
V = variable style
```

Constructor pattern
```
Node (left, current, right)
```

```
Value: Node (Empty, 12, Node (…))
Role:  SSSS  VVVVV  VV  VVVVVVVV
```


The final Node (…) uses variable style throughout because right captures the entire subtree.

Nested pattern
```
Some (x, 0)
```

```
Value: Some (12, 0)
Role:  SSSS  VV  S
```

List pattern
```
head :: tail
```

```
Value: 1 :: [2; 3]
Role:  V SS VVVVVV
```

Wildcard
```
Some _
```

```
Value: Some (LargeValue(…))
Role:  SSSSSSSSSSSSSSSSSSSS
```

Variable-only pattern
```
x
```

```
Value: Node (Empty, 12, Empty)
Role:  VVVVVVVVVVVVVVVVVVVVVVV
```

as patterns

For:

```
Node (left, current, right) as tree
```


the inner pattern determines the composite annotation:

```
Value: Node (Empty, 12, Node (…))
Role:  SSSS  VVVVV  VV  VVVVVVVV
```


The overlapping tree binder adds no third style. When the cursor is on tree, its cursor-value annotation shows the complete value using variable style.

Pattern-directed coloring applies only to the annotated runtime value. Source syntax highlighting does not change with focus.

7. Right-hand execution list

Selecting an expression shows every dynamic occurrence that evaluated it.

The pane header identifies the expression once:

```
Int.compare needle value
4 occurrences
```


Each occurrence always occupies exactly two lines:

```
search 13 Node(…, 8, …) → true
  1

search 13 Node(…, 12, …) → true
  1

search 13 Node(…, 14, …) → true
  -1

search 13 Node(…, 13, …) → true
  0
```


The first line is the containing activation:

```
function argument-values → result
```


or:

```
function argument-values ⇑ escaping-exception
```


The second line is only the selected expression’s value.

An enclosing activation may fail after the selected expression evaluated:

```
infer {…} Apply(…) ⇑ Type_error(…)
  (t0 → t1)
```


The second line is always present because rows are precisely the occurrences that evaluated the selected expression.

Anonymous functions

Do not invent names:

```
fun Empty 8 → Node(Empty, 8, Empty)
  Node(Empty, 8, Empty)
```

Repeated evaluation

There is one row per dynamic occurrence, even when several belong to the same activation:

```
fold step items → 30
  6                                             2/3
```


Every row remains exactly two lines.

Interaction

Clicking the first line focuses the containing activation.

Clicking the second line focuses the exact expression occurrence.

Selecting a row updates the source annotations.

A detail view shows full values and local state without expanding rows.

8. Value rendering

All annotations use the same bounded renderer.

```
Node(Empty, 12, Empty)
Node(…, 12, …)
[1; 2; 3; …] (15)
{substitution × 6}
<function>
```


Requirements:

exactly one line in compact views;

structure-aware truncation;

explicit elision and collection sizes;

stable identities for mutable or cyclic objects;

function inputs rendered at entry time;

selected values rendered at evaluation time;

function outcomes rendered at exit time;

pattern-relevant outer structure preserved before captured subvalues are truncated.

9. Example

Focused on comparison:

```
let rec search needle = function                  13 · Node(…, 12, …)
  | Empty -> false
  | Node (left, value, right) ->
      let comparison =
        Int.compare needle value in               1
      if comparison = 0 then true
      else if comparison < 0 then
        search needle left
      else
        search needle right                       ↩ true
```


Cursor on needle:

```
        Int.compare needle value in               13
```


Right pane:

```
search 13 Node(…, 8, …) → true
  1

search 13 Node(…, 12, …) → true
  1

search 13 Node(…, 14, …) → true
  -1

search 13 Node(…, 13, …) → true
  0
```
