// Can drive into a loop by instrumenting the
// condition/iterator.

function f(n) {
  for (let i = 0; i < n; ++i) {
    let square = i * i;

    COMEHERE:with ('in a loop', n = 2) {
      console.log('square', square);
    }
  }
}
