# Fib

Here is a fib function:

    let rec fib n = 
      if n < 2
      then n
      else fib (n-1) + fib (n-2)

Here is a call to it:

    let k = fib 6
    
`fib 5 =`
