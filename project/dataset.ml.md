# A typed dataset

This page owns the source data for [[Project.Analysis]]. Its record type and
values are ordinary exported OCaml definitions.

    type reading = {
      day : string;
      temperature : float;
      rainfall : float;
    }
    let readings =
      [ { day = "Mon"; temperature = 16.2; rainfall = 4.8 };
        { day = "Tue"; temperature = 18.7; rainfall = 0.6 };
        { day = "Wed"; temperature = 21.4; rainfall = 0.0 };
        { day = "Thu"; temperature = 19.8; rainfall = 1.2 };
        { day = "Fri"; temperature = 23.1; rainfall = 0.0 };
        { day = "Sat"; temperature = 24.6; rainfall = 0.0 };
        { day = "Sun"; temperature = 20.3; rainfall = 3.1 } ]
    let station = "North garden"

The dataset currently contains `List.length readings =` daily observations.

Edit a record and then return to [[Project.Analysis]]. Dox rebuilds the
dependent page from the compiler dependency graph; there is no import metadata
hidden in the Markdown.
