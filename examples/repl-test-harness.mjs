export function complexAPI() {

  // Please imagine that this important implementation
  // detail deserves its own test suite, and is not readily tested
  // by using complexAPI.
  function helper(a) {
    return a ? 123 : -123;
  }

  COMEHERE:with(
    // Maybe a test harness could use a convention like
    // "starts with 'test:'" to pick goals to seek to
    // enumerate tests.
    "test:complexAPI:helper",
    // The AST transform treats any last pattern that is not
    // an `=` pattern as an optional goody bag.
    // Its bound to `globalThis.debugHooks?.getGoodies?.call(target) || {}`
    // allowing the host environment to provide testing and live programming
    // affordances like launchInteractiveShell, or visualizeXyz.
    goodies
  ) {
    let {testHarness: {updocTest}} = goodies;
    updocTest(
      // A REPL test takes a series of inputs and expectations
      // in textual form, so can be reduced to from a live-programming
      // notebook.
      `
      $ helper(true)
      -> 123
      $ helper(false)
      -> -123
      `,
      // Boilerplate.  The test runner needs to be able to evaluate
      // REPL inputs in the current context.
      (x) => eval(x),
    );
  }

  // More code
}
