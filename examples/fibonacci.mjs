// This example shows a COMEHERE block running
// with the arguments given even though the body
// recurses before, so the first time the COMEHERE
// block is seen, n is actually 2.

export function fibonacci(n) {
  if (!(n >= 2)) { return 1; }

  return ($$0 = fibonacci(n - 2)) +
    ($$1 = fibonacci(n - 1));

  COMEHERE:with ("fib(10)", n = 10) {
    console.log(...$$0, ',', ...$$1, '->', Function.return);
  }
}
