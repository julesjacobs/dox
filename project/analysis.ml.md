# Analysis across pages

The values below come from `Project.Dataset`, a different Markdown file and a
different OCaml module. Use go-to-definition on `Project.Dataset.readings` to
open its source.

    let readings = Project.Dataset.readings
    let mean select values =
      let total =
        List.fold_left
          (fun total value -> total +. select value)
          0. values
      in
      total /. float_of_int (List.length values)
    let average_temperature =
      mean
        (fun (reading : Project.Dataset.reading) ->
          reading.temperature)
        readings
    let total_rainfall =
      List.fold_left
        (fun total (reading : Project.Dataset.reading) ->
          total +. reading.rainfall)
        0. readings

Code blocks share scope, so the presentation can stay close to the explanation
without fragmenting the program.

    let bars =
      readings
      |> List.map
           (fun (reading : Project.Dataset.reading) ->
             let height =
               20 + int_of_float (reading.temperature *. 3.)
             in
             Printf.sprintf
               "<div class='day'><div class='bar' style='height:%dpx'></div><span>%s</span></div>"
               height reading.day)
      |> String.concat ""
    let report =
      Printf.sprintf
        {|
        <div class="summary">
          <div><small>Station</small><strong>%s</strong></div>
          <div><small>Average</small><strong>%.1f°C</strong></div>
          <div><small>Rainfall</small><strong>%.1f mm</strong></div>
        </div>
        <div class="chart">%s</div>
        <style>
          body { padding: 0; }
          .summary { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
          .summary div { padding:12px; border-radius:9px; background:#f1f4f1; }
          small { display:block; margin-bottom:4px; color:#7b847f; font:11px system-ui; }
          strong { color:#26332d; font:600 15px system-ui; }
          .chart { display:flex; align-items:end; gap:9px; height:110px; padding:18px 10px 4px; }
          .day { flex:1; display:grid; place-items:end center; gap:5px; }
          .bar { width:100%%; max-width:34px; border-radius:5px 5px 2px 2px;
                 background:linear-gradient(#78998d,#285f4e); }
          .day span { color:#7b847f; font:10px system-ui; }
        </style>
        |}
        Project.Dataset.station average_temperature total_rainfall bars
    let () = Doc.html ~id:"weekly-report" report

The average is also available inline:
`Printf.sprintf "%.1f°C" average_temperature =`.
