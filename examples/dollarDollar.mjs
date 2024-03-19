let a = 10, b = 12, c = 37, d = 42;

// What if we want to know the value of an
// intermediate expression like

if (Math.random() < 0.05) {
  let n = Math.pow(a * b, c / d);
  // We could type out the expression.
  // But as we debug, the logging can get out of sync
  // with the code.
  console.log('a * b =', a * b, 'c / d =', c / d);
}

if (Math.random() < 0.05) {
  // $$name shorthand lets you give a name to an intermediate
  // expression.
  let n = Math.pow($$0 = a * b, $$1 = c / d);
  COMEHERE:with ('$$ demo') {
    // When you "spread" a $$name variable, you get both
    // the expression source code and the value.
    console.log(...$$0, ...$$1);
  }
}
