function abs(n) {
  // When there's more than one assignment,
  // the source code gives you a clue as to which
  // branch generated the value for $$0.
  return (n < 0)
    ? ($$0 = -n)
    : ($$0 = +n);
  COMEHERE:with ('negative', n = -10) {
    console.log(...$$0);
    // Logs "-n = 10"
  }
  COMEHERE:with ('non-negative', n = Math.random() * 10) {
    console.log(...$$0);
    // Logs "+n = 1.23" or something like that depending on
    // the randomly chosen n.
  }
}
