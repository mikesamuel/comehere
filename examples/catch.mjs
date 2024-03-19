// Can drive into a catch block by throwing when
// seeking has the required value.

try {
  // Maybe causing a throw here is unnecessarily difficult;
  // it can be convenient to be able to specify how to
  // construct the value to catch.
  ;
} catch (e) {
  COMEHERE:with ('to catch', e = new Error('Hi')) {
    console.log('caught', e);
  }
}
