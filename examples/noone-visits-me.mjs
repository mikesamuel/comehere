function f(x) {
  COMEHERE:with ("before mightFail()", x = 1) {
    console.log('x', x);
  }

  mightFail();

  COMEHERE:with ("after mightFail()", x = 1) {
    // noone visits me :(
    console.log('x', x);
  }
}

function mightFail() {
  throw new Error('yep');
}
