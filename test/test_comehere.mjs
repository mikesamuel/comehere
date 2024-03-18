import { expect, assert } from "chai";
import { describe, it } from "mocha";

import * as comehere from "../src/comehere.mjs";

import {parse} from '@babel/parser';
import generate from '@babel/generator';

function strip12([s]) {
  return s.replace(/\n            /g, '\n')
    .replace(/^\n|\n$/g, '')
}

/** A console replacement that logs. */
class ErrorConsole {
  #messages;

  constructor() {
    this.clear();
  }

  clear() {
    this.#messages = {
      error: [],
      info: [],
      log: [],
      warn: [],
    };
  }

  error(...args) { this.#messages.error.push(args) }
  info(...args) { this.#messages.info.push(args) }
  log(...args) { this.#messages.log.push(args) }
  warn(...args) { this.#messages.warn.push(args) }

  get messages() {
    let {error, info, log, warn} = this.#messages;
    return {
      error: [...error],
      info: [...info],
      log: [...log],
      warn: [...warn],
    }
  }

  dumpIfFails(f) {
    let ok = false;
    try {
      f(this);
      ok = true;
    } finally {
      if (!ok) {
        let {error, info, log, warn} = this.#messages;
        error.forEach((x) => globalThis.console.error(...x));
        warn.forEach((x) => globalThis.console.warn(...x));
        log.forEach((x) => globalThis.console.log(...x));
        info.forEach((x) => globalThis.console.info(...x));
      }
    }
  }
}

describe('comehere', () => {
  describe('blockify', () => {
    function blockified(input) {
      let ast = parse(input);
      comehere.blockify(ast);
      return generate.default(ast).code;
    }
    it('if0', () => {
      expect(blockified(`if (x) f();`))
        .equals(
          strip12`
            if (x) {
              f();
            }
            `
        );
    });
    it('if1', () => {
      expect(blockified(`if (x) f(); else g()`))
        .equals(
          strip12`
            if (x) {
              f();
            } else {
              g();
            }
            `
        );
    });
    it('if2', () => {
      expect(blockified(`if (x) { f() } else { g() }`))
        .equals(
          strip12`
            if (x) {
              f();
            } else {
              g();
            }
            `
        );
    });
    it('if3', () => {
      expect(blockified(`if (x) { f() } else if (y) { g() } else { h() }`))
        .equals(
          strip12`
            if (x) {
              f();
            } else if (y) {
              g();
            } else {
              h();
            }
            `
        );
    });
    it('for', () => {
      expect(blockified(`for (;;) f()`))
        .equals(
          strip12`
            for (;;) {
              f();
            }
            `
        );
    });
    it('for-in', () => {
      expect(blockified(`for (k in o) f()`))
        .equals(
          strip12`
            for (k in o) {
              f();
            }
            `
        );
    });
    it('for-of', () => {
      expect(blockified(`for (e of it) f()`))
        .equals(
          strip12`
            for (e of it) {
              f();
            }
            `
        );
    });
    it('while', () => {
      expect(blockified(`while (c) f()`))
        .equals(
          strip12`
            while (c) {
              f();
            }
            `
        );
    });
    it('do-while', () => {
      expect(blockified(`do f(); while (c)`))
        .equals(
          strip12`
            do {
              f();
            } while (c);
            `
        );
    });
    it('lambda', () => {
      expect(blockified(`() => f()`))
        .equals(
          strip12`
            () => {
              return f();
            };
            `
        );
    });
  });
  describe('transform', () => {
    const transformTest = ({
      code,
      want,
      wantErrors = [],
    }) => new ErrorConsole().dumpIfFails((errorConsole) => {
      let transformed = comehere.transform(code, errorConsole).code;
      expect(wantErrors).deep.equal(errorConsole.messages.error);
      expect(want).equal(transformed);
    });

    it('comeheres_with_empty_bodies', () => transformTest({
      code: strip12`
            function f(x) {
              COMEHERE: with ("foo", x = 1) {
              }
            }
            COMEHERE: with ("bar") {
            }
            `,
      want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            let activeFns_0 = 0n;
            function f(x) {
              const isActiveCall_0 = activeFns_0 >> 0n & 1n;
              activeFns_0 &= ~(1n << 0n);
              if (isActiveCall_0 && seeking_0 === 1) {
                seeking_0 = 0;
              }
            }
            if (seeking_0 === 1) {
              try {
                const callee_0 = f,
                  x = 1;
                activeFns_0 |= 1n << 0n;
                callee_0(x);
              } finally {
                seeking_0 = 0;
              }
            }
            if (seeking_0 === 2) {
              seeking_0 = 0;
            }
            `,
      blocks: ["foo", "bar"],
    }));

    it('comehere_within_named_fn', () => transformTest({
      code: strip12`
            export function f(a, b) {
              let result = a * b;
              COMEHERE: with (f.a = 6, b = 8) {
                console.log('result', result, ', wanted', 42);
              }
              return result;
            }
            `,
      want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            let activeFns_0 = 0n;
            export function f(a, b) {
              const isActiveCall_0 = activeFns_0 >> 0n & 1n;
              activeFns_0 &= ~(1n << 0n);
              let result = a * b;
              if (isActiveCall_0 && seeking_0 === 1) {
                seeking_0 = 0;
                console.log('result', result, ', wanted', 42);
              }
              return result;
            }
            if (seeking_0 === 1) {
              try {
                const callee_0 = f,
                  a = 6,
                  b = 8;
                activeFns_0 |= 1n << 0n;
                callee_0(a, b);
              } finally {
                seeking_0 = 0;
              }
            }
            `
    }));

    it('comehere_within_ifs', () => transformTest({
      code: strip12`
            if (f()) {
              if (g()) {
                foo();
              } else {
                let x = h();
                COMEHERE: with (_) {
                  console.log('h ->', x);
                }
              }
            }
            `,
      want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            if (f() || seeking_0 === 1) {
              if (g() && seeking_0 !== 1) {
                foo();
              } else {
                let x = h();
                if (seeking_0 === 1) {
                  seeking_0 = 0;
                  console.log('h ->', x);
                }
              }
            }
            `,
    }));

    it('comehere_within_try', () => transformTest({
      code: strip12`
            try {
              f();
              COMEHERE: with (_) { a(); }
            } catch {
              g();
              COMEHERE: with (_) { b(); }
            } finally {
              h();
              COMEHERE: with (_) { c(); }
            }
            `,
      want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            try {
              if (seeking_0 === 2) {
                throw null;
              }
              f();
              if (seeking_0 === 1) {
                seeking_0 = 0;
                a();
              }
            } catch {
              g();
              if (seeking_0 === 2) {
                seeking_0 = 0;
                b();
              }
            } finally {
              h();
              if (seeking_0 === 3) {
                seeking_0 = 0;
                c();
              }
            }
            `,
    }));

    it('comehere_within_catch_from_empty_try', () => transformTest({
      code: strip12`
            try {} catch {
              COMEHERE: with (_) { a(); }
            }
            `,
      want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            try {
              if (seeking_0 === 1) {
                throw null;
              }
            } catch {
              if (seeking_0 === 1) {
                seeking_0 = 0;
                a();
              }
            }
            `,
    }));

    it('comehere_within_simple_loops', () => transformTest({
      code: strip12`
            while (c) {
              COMEHERE: with (_) { a(); }
              f();
            }
            for (;d;) {
              COMEHERE: with (_) { b(); }
              g();
            }
            do {
              COMEHERE: with (_) { c(); }
              h();
            } while (e);
            `,
      want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            while (c || seeking_0 === 1) {
              if (seeking_0 === 1) {
                seeking_0 = 0;
                a();
              }
              f();
            }
            for (; d || seeking_0 === 2;) {
              if (seeking_0 === 2) {
                seeking_0 = 0;
                b();
              }
              g();
            }
            do {
              if (seeking_0 === 3) {
                seeking_0 = 0;
                c();
              }
              h();
            } while (e);
            `,
    }));

    it('comehere_within_iterator_loops', () => transformTest({
      code: strip12`
            for (p in o) {
              COMEHERE: with (_) { a(); }
              f();
            }
            for (e of els) {
              COMEHERE: with (_) { b(); }
              g();
            }
            `,
      want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            function* maybeNotEmptyIterator_0(items, seeking) {
              for (let e of items) {
                yield e;
                seeking = false;
              }
              if (seeking) {
                yield {};
              }
            }
            function* maybeNotEmptyKeyIterator_0(obj, seeking) {
              for (let k in obj) {
                yield k;
                seeking = false;
              }
              if (seeking) {
                yield "";
              }
            }
            for (p of maybeNotEmptyKeyIterator_0(o, seeking_0 === 1)) {
              if (seeking_0 === 1) {
                seeking_0 = 0;
                a();
              }
              f();
            }
            for (e of maybeNotEmptyIterator_0(els, seeking_0 === 2)) {
              if (seeking_0 === 2) {
                seeking_0 = 0;
                b();
              }
              g();
            }
            `,
    }));

    it('comehere_within_switch_case', () => transformTest({
      code: strip12`
            switch (x) {
              case f():
                a();
                break;
              case g():
                let y = b();
                COMEHERE: with (_) {
                  console.log('Hello', y);
                }
                break;
              case h():
                c();
                break;
            }
            `,
      want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            const caseToken_0 = {},
              caseExpr_0 = x;
            switch (seeking_0 === 1 ? caseToken_0 : caseExpr_0) {
              case f():
                a();
                break;
              case g():
              case caseToken_0:
                let y = b();
                if (seeking_0 === 1) {
                  seeking_0 = 0;
                  console.log('Hello', y);
                }
                break;
              case h():
                c();
                break;
            }
            `,
    }));

    it('comehere_within_method_in_named_class', () => transformTest({
        code: strip12`
            class C {
              constructor(x, y) {
                this.x = x;
                this.y = y;
              }

              method(n) {
                let r = this.x + this.y * n;
                COMEHERE:with (C.this.x = 1, C.this.y = 2, n = 3) {
                  console.log(this.x, this.y, n, r);
                }
                return r;
              }
            }
            `,
        want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            let activeFns_0 = 0n;
            class C {
              constructor(x, y) {
                this.x = x;
                this.y = y;
              }
              method(n) {
                const isActiveCall_0 = activeFns_0 >> 0n & 1n;
                activeFns_0 &= ~(1n << 0n);
                let r = this.x + this.y * n;
                if (isActiveCall_0 && seeking_0 === 1) {
                  seeking_0 = 0;
                  console.log(this.x, this.y, n, r);
                }
                return r;
              }
            }
            if (seeking_0 === 1) {
              try {
                const x = 1,
                  y = 2,
                  this_0 = new C(x, y),
                  n = 3;
                activeFns_0 |= 1n << 0n;
                this_0.method(n);
              } finally {
                seeking_0 = 0;
              }
            }
            `,
    }));

    it('comehere_within_constructor_in_named_class', () => transformTest({
        code: strip12`
            class C {
              constructor(x, y) {
                this.x = x;
                this.y = y;
                COMEHERE:with (x = 1, constructor.y = 2) {
                  console.log(this.x, this.y);
                }
              }
            }
            `,
        want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            let activeFns_0 = 0n;
            class C {
              constructor(x, y) {
                const isActiveCall_0 = activeFns_0 >> 0n & 1n;
                activeFns_0 &= ~(1n << 0n);
                this.x = x;
                this.y = y;
                if (isActiveCall_0 && seeking_0 === 1) {
                  seeking_0 = 0;
                  console.log(this.x, this.y);
                }
              }
            }
            if (seeking_0 === 1) {
              try {
                const x = 1,
                  y = 2;
                activeFns_0 |= 1n << 0n;
                new C(x, y);
              } finally {
                seeking_0 = 0;
              }
            }
            `,
    }));

    it('comehere_within_static_method', () => transformTest({
        code: strip12`
            class C {
              static foo(x, y) {
                let n = x++ + y;
                COMEHERE:with (x = 1, C.foo.y = 2) {
                  console.log(x, y, n);
                }
              }
            }
            `,
        want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            let activeFns_0 = 0n;
            class C {
              static foo(x, y) {
                const isActiveCall_0 = activeFns_0 >> 0n & 1n;
                activeFns_0 &= ~(1n << 0n);
                let n = x++ + y;
                if (isActiveCall_0 && seeking_0 === 1) {
                  seeking_0 = 0;
                  console.log(x, y, n);
                }
              }
            }
            if (seeking_0 === 1) {
              try {
                const x = 1,
                  y = 2;
                activeFns_0 |= 1n << 0n;
                C.foo(x, y);
              } finally {
                seeking_0 = 0;
              }
            }
            `,
    }));

    it('comehere_within_private_method', () => transformTest({
        code: strip12`
            class C {
              #foo(x, y) {
                let n = x++ + y;
                COMEHERE:with (x = 1, y = 2) {
                  console.log(x, y, n);
                }
              }
            }
            `,
        want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            let activeFns_0 = 0n;
            class C {
              accessor_0(x, y) {
                const isActiveCall_0 = activeFns_0 >> 0n & 1n;
                activeFns_0 &= ~(1n << 0n);
                let n = x++ + y;
                if (isActiveCall_0 && seeking_0 === 1) {
                  seeking_0 = 0;
                  console.log(x, y, n);
                }
              }
              #foo(...args) {
                return this.accessor_0(...args);
              }
            }
            if (seeking_0 === 1) {
              try {
                const this_0 = new C(),
                  x = 1,
                  y = 2;
                activeFns_0 |= 1n << 0n;
                this_0.accessor_0(x, y);
              } finally {
                seeking_0 = 0;
              }
            }
            `,
    }));

    it('comehere_within_getter', () => transformTest({
        code: strip12`
            class C {
              get x() {
                let n = 123;
                COMEHERE:with (_) {
                  console.log(n);
                }
                return n;
              }
            }
            `,
        want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            let activeFns_0 = 0n;
            class C {
              get x() {
                const isActiveCall_0 = activeFns_0 >> 0n & 1n;
                activeFns_0 &= ~(1n << 0n);
                let n = 123;
                if (isActiveCall_0 && seeking_0 === 1) {
                  seeking_0 = 0;
                  console.log(n);
                }
                return n;
              }
            }
            if (seeking_0 === 1) {
              try {
                const this_0 = new C();
                activeFns_0 |= 1n << 0n;
                this_0.x;
              } finally {
                seeking_0 = 0;
              }
            }
            `,
    }));

    it('comehere_within_complexly_keyed_setter', () => transformTest({
        code: strip12`
            class C {
              set ['x'](newX) {
                this._x = newX;
                COMEHERE:with (newX = -1) {
                  console.log(this._x, newX);
                }
              }
            }
            `,
        want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            let activeFns_0 = 0n;
            class C {
              set accessor_0(newX) {
                const isActiveCall_0 = activeFns_0 >> 0n & 1n;
                activeFns_0 &= ~(1n << 0n);
                this._x = newX;
                if (isActiveCall_0 && seeking_0 === 1) {
                  seeking_0 = 0;
                  console.log(this._x, newX);
                }
              }
              set ['x'](newValue) {
                return this.accessor_0 = newValue;
              }
            }
            if (seeking_0 === 1) {
              try {
                const this_0 = new C(),
                  newX = -1;
                activeFns_0 |= 1n << 0n;
                this_0.accessor_0 = newX;
              } finally {
                seeking_0 = 0;
              }
            }
            `,
    }));

    it('comehere_within_anonymous_class_method', () => transformTest({
      code: strip12`
            (class {
              foo(x, y) {
                let n = x++ + y;
                COMEHERE:with (x = 1, y = 2) {
                  console.log(x, y, n);
                }
              }
            })
            `,
      want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            let activeFns_0 = 0n;
            (class_0 => {
              if (seeking_0 === 1) {
                try {
                  const this_0 = new class_0(),
                    x = 1,
                    y = 2;
                  activeFns_0 |= 1n << 0n;
                  this_0.foo(x, y);
                } finally {
                  seeking_0 = 0;
                }
              }
              return class_0;
            })(class {
              foo(x, y) {
                const isActiveCall_0 = activeFns_0 >> 0n & 1n;
                activeFns_0 &= ~(1n << 0n);
                let n = x++ + y;
                if (isActiveCall_0 && seeking_0 === 1) {
                  seeking_0 = 0;
                  console.log(x, y, n);
                }
              }
            });
            `,
    }));

    it('comehere_within_object_method', () => transformTest({
      code: strip12`
            ({
              method(x) {
                COMEHERE: with(x = 1) {
                  console.log(this, x);
                }
              }
            });
            `,
      want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            let activeFns_0 = 0n;
            (this_0 => {
              if (seeking_0 === 1) {
                try {
                  const x = 1;
                  activeFns_0 |= 1n << 0n;
                  this_0.method(x);
                } finally {
                  seeking_0 = 0;
                }
              }
              return this_0;
            })({
              method(x) {
                const isActiveCall_0 = activeFns_0 >> 0n & 1n;
                activeFns_0 &= ~(1n << 0n);
                if (isActiveCall_0 && seeking_0 === 1) {
                  seeking_0 = 0;
                  console.log(this, x);
                }
              }
            });
            `,
    }));

    it('comehere_within_complex_getter_in_obj', () => transformTest({
      code: strip12`
            ({
              _x: 123,
              get [someSymbol]() {
                COMEHERE: with(_) {
                  console.log(this._x);
                }
                return this._x;
              }
            });
            `,
      want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            let activeFns_0 = 0n;
            (this_0 => {
              if (seeking_0 === 1) {
                try {
                  activeFns_0 |= 1n << 0n;
                  this_0.accessor_0;
                } finally {
                  seeking_0 = 0;
                }
              }
              return this_0;
            })({
              _x: 123,
              get accessor_0() {
                const isActiveCall_0 = activeFns_0 >> 0n & 1n;
                activeFns_0 &= ~(1n << 0n);
                if (isActiveCall_0 && seeking_0 === 1) {
                  seeking_0 = 0;
                  console.log(this._x);
                }
                return this._x;
              },
              get [someSymbol]() {
                return this.accessor_0;
              }
            });
            `,
    }));

    describe('comehere_within_short_circuiting_"expressions"', () => {
      it('||', () => transformTest({
        code: strip12`
            a() || ((x) => {
              COMEHERE: with (x = 1) {
                console.log(x);
              }
              return use(x);
            })
            `,
        want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            let activeFns_0 = 0n;
            function or_0(x, y, seeking) {
              if (seeking) {
                const yr = y();
                return x || yr;
              } else {
                return x || y();
              }
            }
            or_0(a(), () => (f_0 => {
              if (seeking_0 === 1) {
                try {
                  const callee_0 = f_0,
                    x = 1;
                  activeFns_0 |= 1n << 0n;
                  callee_0(x);
                } finally {
                  seeking_0 = 0;
                }
              }
              return f_0;
            })(x => {
              const isActiveCall_0 = activeFns_0 >> 0n & 1n;
              activeFns_0 &= ~(1n << 0n);
              if (isActiveCall_0 && seeking_0 === 1) {
                seeking_0 = 0;
                console.log(x);
              }
              return use(x);
            }), seeking_0 === 1);
            `,
      }));

      it('&&', () => transformTest({
        code: strip12`
            a() && ((x) => {
              COMEHERE: with (x = 1) {
                console.log(x);
              }
              return use(x);
            })
            `,
        want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            let activeFns_0 = 0n;
            function and_0(x, y, seeking) {
              if (seeking) {
                const yr = y();
                return x && yr;
              } else {
                return x && y();
              }
            }
            and_0(a(), () => (f_0 => {
              if (seeking_0 === 1) {
                try {
                  const callee_0 = f_0,
                    x = 1;
                  activeFns_0 |= 1n << 0n;
                  callee_0(x);
                } finally {
                  seeking_0 = 0;
                }
              }
              return f_0;
            })(x => {
              const isActiveCall_0 = activeFns_0 >> 0n & 1n;
              activeFns_0 &= ~(1n << 0n);
              if (isActiveCall_0 && seeking_0 === 1) {
                seeking_0 = 0;
                console.log(x);
              }
              return use(x);
            }), seeking_0 === 1);
            `,
      }));

      it('?:', () => transformTest({
        code: strip12`
            a()
            ? ((x) => {
                COMEHERE: with (x = 1) {
                  console.log(x);
                }
                return x + 1;
              })
            : ((x) => {
                COMEHERE: with (x = 2) {
                  console.log(x);
                }
                return x - 1;
              })
            `,
        want: strip12`
            let seeking_0 = globalThis.debugHooks.getWhichSeeking(import.meta) || 0;
            let activeFns_0 = 0n;
            (a() || seeking_0 === 1) && seeking_0 !== 2 ? (f_0 => {
              if (seeking_0 === 1) {
                try {
                  const callee_0 = f_0,
                    x = 1;
                  activeFns_0 |= 1n << 0n;
                  callee_0(x);
                } finally {
                  seeking_0 = 0;
                }
              }
              return f_0;
            })(x => {
              const isActiveCall_0 = activeFns_0 >> 0n & 1n;
              activeFns_0 &= ~(1n << 0n);
              if (isActiveCall_0 && seeking_0 === 1) {
                seeking_0 = 0;
                console.log(x);
              }
              return x + 1;
            }) : (f_1 => {
              if (seeking_0 === 2) {
                try {
                  const callee_1 = f_1,
                    x = 2;
                  activeFns_0 |= 1n << 1n;
                  callee_1(x);
                } finally {
                  seeking_0 = 0;
                }
              }
              return f_1;
            })(x => {
              const isActiveCall_1 = activeFns_0 >> 1n & 1n;
              activeFns_0 &= ~(1n << 1n);
              if (isActiveCall_1 && seeking_0 === 2) {
                seeking_0 = 0;
                console.log(x);
              }
              return x - 1;
            });
            `,
      }));
    });
  });
});
