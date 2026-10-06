function* fibonaccis(a = 0, b = 1) {
  let [x, y] = [a, b];
  function update() {
    [x, y] = [y, x + y];
  }

  COMEHERE:with("fib-REPL", a = 0n, b = 1n) {
    // Run a REPL in the context of the helper
    // function update() and hidden state x&y.
    let code = 'update(); [x, y]';
    let beforePrompt = '';
    while (true) {
      code = prompt(`${beforePrompt}$`, code);  // Read
      if (!code) { break };
      let result = eval(code);   // Eval
      console.log('->', result); // Print
      beforePrompt = `-> ${result}\n`;
    }                            // Loop
  }

  while (true) {
    update();
    yield x;
  }
}
