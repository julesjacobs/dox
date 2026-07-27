# Shared statistics model

This document is a reusable part of the live project. Other documents can
import its OCaml definitions while this page remains readable on its own.

    let observations = [ 3.; 5.; 8.; 13.; 21. ]
    
    let @mean values =
      List.fold_left ( +. ) 0. values /. float_of_int (List.length values)
