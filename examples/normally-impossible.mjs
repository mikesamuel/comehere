export function isWholePositiveAndOdd(x) {
  // Avoid TOCTOU problems with inputs like
  // ({ b: false, valueOf() { return (this.b = !this.b) ? 1 : -1 } })
  if (typeof x !== 'number') { throw new TypeError(x); }
  if (x < 0) { return false; }

  function isOdd(x) {
    // Use `%` because bitwise `&` truncates fractions
    // and shoehorns NaNs and infinities to signed 32b ints.
    return x % 2 === 1;
  }

  COMEHERE:with("testing isOdd", x = 0, goodies) {
    let {testHarness: {updocTest}} = goodies;
    updocTest(
      `
      $ isOdd(0)
      -> false
      $ isOdd(1)
      -> true
      $ isOdd(-2)
      -> false
      $ isOdd(-1)
      -> true
      `,
      (x) => eval(x),
    );
  }

  return isOdd(x);
}
