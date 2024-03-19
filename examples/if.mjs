export let x;

if (Math.random() > 0.5) {
  let n = 6;
  n *= 7;
  COMEHERE:with ('then-branch') {
    console.log('n', n);
  }
  x = n;
} else {
  let n = 28;
  n >>= 1;
  COMEHERE:with ('else-branch') {
    console.log('n', n);
  }
  x = n * 3;
}
