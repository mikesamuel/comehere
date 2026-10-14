import { expect } from 'chai';
import { describe, it } from 'mocha';

import * as comehere from '../src/comehere.mjs';

/**
 * Transforms `source`, then runs it as a module with the given COMEHERE
 * block selected, and returns what it logged via `globalThis.__log`.
 */
async function runSeeking(source, whichSeeking) {
  let errors = [];
  let { code } = comehere.transform(source, {
    error: (...args) => errors.push(args.join(' ')),
    warn: (...args) => errors.push(args.join(' ')),
    log() {}, info() {},
  });
  expect(errors, `transform errors\n${code}`).deep.equal([]);
  let log = [];
  globalThis.__log = log;
  globalThis.debugHooks = { getWhichSeeking: () => whichSeeking };
  let encoded = Buffer.from(
    `const log = (...a) => globalThis.__log.push(a.join(' '));\n${code}`
  ).toString('base64');
  try {
    await import(`data:text/javascript;base64,${encoded}#${Math.random()}`);
  } catch (e) {
    throw new Error(`${e.stack}\n${code}`);
  } finally {
    delete globalThis.debugHooks;
    delete globalThis.__log;
  }
  return log;
}

describe('comehere runs', () => {
  it('bypasses_guard_that_throws', async () => {
    expect(await runSeeking(`
      function f(x) {
        if (typeof x !== 'number') { throw new TypeError(x); }
        COMEHERE:with (x = '1') { log('x=' + x); }
      }
    `, 1)).deep.equal(['x=1']);
  });

  it('guard_forms_are_equivalent', async () => {
    expect(await runSeeking(`
      function f(x) {
        if (typeof x === 'number') {
          COMEHERE:with (x = '1') { log('x=' + x); }
          return;
        }
        throw new TypeError(x);
      }
    `, 1)).deep.equal(['x=1']);
  });

  it('not_seeking_runs_normally_and_skips_block', async () => {
    expect(await runSeeking(`
      function f(x) {
        if (typeof x !== 'number') { throw new TypeError(x); }
        log('before');
        COMEHERE:with (x = 1) { log('in block'); }
        log('after');
      }
      f(2);
    `, 0)).deep.equal(['before', 'after']);
  });

  it('while_loop_never_entered', async () => {
    expect(await runSeeking(`
      let n = 0;
      while (n > 0) {
        COMEHERE:with (_) { log('in loop'); }
        n--;
      }
    `, 1)).deep.equal(['in loop']);
  });

  it('for_loop_never_entered', async () => {
    expect(await runSeeking(`
      for (let i = 0; i < 0; i++) {
        COMEHERE:with (_) { log('in for ' + i); }
      }
    `, 1)).deep.equal(['in for 0']);
  });

  it('do_while_after_early_exit', async () => {
    expect(await runSeeking(`
      function f(early) {
        if (early) { return; }
        do {
          COMEHERE:with (early = false) { log('in do'); }
        } while (false);
      }
      f(true);
    `, 1)).deep.equal(['in do']);
  });

  it('for_of_over_empty_iterable', async () => {
    expect(await runSeeking(`
      for (let x of []) {
        COMEHERE:with (_) { log('x=' + x); }
      }
    `, 1)).deep.equal(['x=undefined']);
  });

  it('for_of_over_non_empty_iterable_with_body_run_once', async () => {
    expect(await runSeeking(`
      function g(items) {
        for (let x of items) {
          COMEHERE:with (items = [7]) { log('x=' + x); }
        }
      }
      g([1, 2]);
    `, 1)).deep.equal(['x=7']);
  });

  it('for_in_over_empty_object', async () => {
    expect(await runSeeking(`
      for (let k in {}) {
        COMEHERE:with (_) { log('in for-in'); }
      }
    `, 1)).deep.equal(['in for-in']);
  });

  it('switch_case_that_does_not_match', async () => {
    expect(await runSeeking(`
      let x = 5;
      switch (x) {
      case 1: log('one'); break;
      case 2:
        COMEHERE:with (_) { log('in two'); }
        break;
      default: log('default');
      }
    `, 1)).deep.equal(['in two']);
  });

  it('switch_default_that_does_not_match', async () => {
    expect(await runSeeking(`
      let x = 1;
      switch (x) {
      case 1: log('one'); break;
      default:
        COMEHERE:with (_) { log('in default'); }
      }
    `, 1)).deep.equal(['in default']);
  });

  it('catch_block_without_throw', async () => {
    expect(await runSeeking(`
      try {
        log('try');
      } catch (e) {
        COMEHERE:with (e = new Error('made up')) { log('caught ' + e.message); }
      }
    `, 1)).deep.equal(['caught made up']);
  });

  it('finally_block_after_return', async () => {
    expect(await runSeeking(`
      function f() {
        try {
          return 'r';
        } finally {
          COMEHERE:with (_) { log('in finally'); }
        }
      }
      f();
    `, 1)).deep.equal(['in finally']);
  });

  it('second_block_selected', async () => {
    expect(await runSeeking(`
      function f(x) {
        if (x) {
          COMEHERE:with (x = 1) { log('first'); }
        } else {
          COMEHERE:with (x = 0) { log('second'); }
        }
      }
    `, 2)).deep.equal(['second']);
  });

  it('after_return_logs_function_result', async () => {
    expect(await runSeeking(`
      function f(x) {
        if (!x) { return 'falsey'; }
        return x * 2;
        COMEHERE:with (x = 21) { log('result ' + Function.return); }
      }
    `, 1)).deep.equal(['result 42']);
  });

  it('recursion_before_block_only_hits_outer_call', async () => {
    expect(await runSeeking(`
      function fact(n) {
        if (n <= 1) { return 1; }
        let r = n * fact(n - 1);
        COMEHERE:with (n = 4) { log('r=' + r); }
        return r;
      }
    `, 1)).deep.equal(['r=24']);
  });

  it('nested_ifs_loops_and_try', async () => {
    expect(await runSeeking(`
      function f(ok, n) {
        if (!ok) { throw new Error('not ok'); }
        for (let i = 0; i < n; i++) {
          try {
            if (i === 0) { continue; }
            switch (i) {
            case 1: log('one'); break;
            default:
              COMEHERE:with (ok = true, n = 0) { log('deep ' + i); }
            }
          } finally {
            log('finally');
          }
        }
      }
    `, 1)).deep.equal(['deep 0', 'finally']);
  });

  it('method_in_class_behind_guard', async () => {
    expect(await runSeeking(`
      class C {
        m(x) {
          if (x < 0) { throw new RangeError('neg'); }
          COMEHERE:with (C.m.x = -1) { log('m x=' + x); }
        }
      }
    `, 1)).deep.equal(['m x=-1']);
  });
});
