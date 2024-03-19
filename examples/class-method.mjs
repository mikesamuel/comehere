// Driving into a class member requires a `this` value.

class C {
  constructor(x) {
    this._x = x;
  }

  get x() {
    // One can specify inputs to the constructor in which
    // case it synthesizes an insance.
    return $$0 = this.x;
    COMEHERE:with ('getter for x', C.this.x = 42) {
      console.log(...$$0);
    }
  }

  method(a) {
    // Or one can say use this particular value for `this`.
    COMEHERE:with ('method', C.this = new C(1), a = 2) {
      console.log('in method', this);
    }
  }

  toString() { return `C(${this._x})` }
}
