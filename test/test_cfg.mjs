import { expect } from 'chai';
import { describe, it } from 'mocha';

import { parse } from '@babel/parser';
import generateDefault from '@babel/generator';

import { NameMaker, namesUsedIn } from '../src/name-maker.mjs';
import { CfgEdgeKind, CfgRegionKind } from '../src/cfg.mjs';
import { cfgFromBody } from '../src/cfg-from-body.mjs';
import { cfgToBody } from '../src/cfg-to-body.mjs';

const generate = generateDefault.default || generateDefault;

/** Parses `src`, whose first statement is a function declaration. */
function cfgOf(src) {
  let ast = parse(src);
  let fn = ast.program.body[0];
  let nameMaker = new NameMaker(namesUsedIn(ast));
  let cfg = cfgFromBody(fn.body, nameMaker);
  return { ast, fn, cfg, nameMaker };
}

/** Round trips function `f` in `src` through a Cfg and returns the new source. */
function roundTripped(src) {
  let { ast, fn, cfg, nameMaker } = cfgOf(src);
  fn.body = cfgToBody(cfg, nameMaker);
  return generate(ast).code;
}

/** Runs `f` from `src` on `args`, capturing logs, results, and exceptions. */
function run(src, args) {
  let logs = [];
  let log = (...x) => { logs.push(x.map(String).join(' ')) };
  let f = new Function('log', `${src}\nreturn f;`)(log);
  let outcome = {};
  try {
    outcome.returned = f(...args);
  } catch (e) {
    outcome.threw = e instanceof Error ? e.message : `thrown:${String(e)}`;
  }
  outcome.logs = logs;
  return outcome;
}

/** Asserts that source and regenerated source behave identically. */
function sameBehavior(src, inputs) {
  let after = roundTripped(src);
  for (let args of inputs) {
    let want = run(src, args);
    let got;
    try {
      got = run(after, args);
    } catch (e) {
      throw new Error(`${e.message}\nRegenerated:\n${after}`);
    }
    expect(got, `args ${JSON.stringify(args)}\nRegenerated:\n${after}`).deep.equal(want);
  }
  return after;
}

/** Collects nodes reachable from the start of the graph. */
function reachableNodes(cfg) {
  let seen = new Set();
  let stack = [cfg.start];
  while (stack.length) {
    let n = stack.pop();
    if (seen.has(n)) { continue }
    seen.add(n);
    for (let e of n.outgoing) { stack.push(e.target) }
  }
  return seen;
}

const range = (n) => Array.from({ length: n }, (_, i) => i);

describe('cfg', () => {
  describe('cfgFromBody', () => {
    it('straight_line_has_one_normal_exit_and_no_abrupt_exit', () => {
      let { cfg } = cfgOf('function f(a) { a++; a++; }');
      expect(cfg.normalExit).not.equal(null);
      expect(cfg.abruptExit).equal(null);
      expect(cfg.normalExit.outgoing).length(0);
      expect(cfg.start.incoming).length(0);
    });

    it('all_returns_share_one_normal_exit', () => {
      let { cfg } = cfgOf(`function f(a) {
        if (a) { return 1; }
        if (!a) { return 2; }
        return 3;
      }`);
      expect(cfg.returnedName).equal('returned_0');
      // Three returns + nothing falls off the end (dead code after return).
      let writes = [...reachableNodes(cfg)].filter(
        (n) => n.stmt && n.stmt.type === 'ExpressionStatement' &&
          n.stmt.expression.type === 'AssignmentExpression');
      expect(writes).length(3);
      for (let w of writes) {
        expect(w.outgoing).length(1);
        expect(w.outgoing[0].target).equal(cfg.normalExit);
      }
      expect(cfg.normalExit.stmt.type).equal('ReturnStatement');
    });

    it('all_uncaught_throws_share_one_abrupt_exit', () => {
      let { cfg } = cfgOf(`function f(a) {
        if (a === 1) { throw new Error('1'); }
        if (a === 2) { throw new Error('2'); }
      }`);
      expect(cfg.abruptExit).not.equal(null);
      expect(cfg.abruptExit.incoming).length(2);
      expect(cfg.abruptExit.stmt.type).equal('ThrowStatement');
    });

    it('throw_in_try_with_catch_is_a_local_throw_edge', () => {
      let { cfg } = cfgOf(`function f(a) {
        try { throw a; } catch (e) { log(e); }
      }`);
      expect(cfg.abruptExit).equal(null);
      let edges = [...reachableNodes(cfg)].flatMap((n) => n.outgoing);
      let throws = edges.filter((e) => e.kind === CfgEdgeKind.LOCAL_THROWS);
      // One real throw and the normally unreachable one from the try's start.
      expect(throws).length(2);
      expect(throws.filter((e) => e.dummy)).length(1);
      let catchRegion = [...Array(cfg.regionTable.size).keys()].find(
        (i) => cfg.regionTable.get(i).kind === CfgRegionKind.CATCH);
      for (let e of throws) {
        expect(e.target.region).equal(catchRegion);
      }
    });

    it('loops_have_loop_back_edges', () => {
      let { cfg } = cfgOf(`function f(n) {
        let i = 0;
        while (i < n) { i++; }
        do { i--; } while (i > 0);
        for (let j = 0; j < 3; ++j) { log(j); }
      }`);
      let edges = [...reachableNodes(cfg)].flatMap((n) => n.outgoing);
      expect(edges.filter((e) => e.kind === CfgEdgeKind.LOOP_BACK)).length(3);
    });

    it('for_of_is_desugared_to_iterator_protocol', () => {
      let { cfg } = cfgOf(`function f(xs) { for (const x of xs) { log(x); } }`);
      let code = [...reachableNodes(cfg)]
        .filter((n) => n.stmt)
        .map((n) => generate(n.stmt).code)
        .join('\n');
      expect(code).contains('Symbol.iterator');
      expect(code).contains('.next()');
      expect(code).contains('.return');
      let kinds = [...Array(cfg.regionTable.size).keys()]
        .map((i) => cfg.regionTable.get(i).kind);
      expect(kinds).include(CfgRegionKind.FINALLY);
    });

    it('switch_has_case_edges', () => {
      let { cfg } = cfgOf(`function f(x) {
        switch (x) { case 1: log(1); break; case 2: log(2); default: log('d'); }
      }`);
      let edges = [...reachableNodes(cfg)].flatMap((n) => n.outgoing);
      expect(edges.filter((e) => e.kind === CfgEdgeKind.CASE)).length(2);
    });

    it('blocks_with_lexical_declarations_get_regions', () => {
      let { cfg } = cfgOf(`function f(x) { { let y = x; log(y); } { log(x); } }`);
      let kinds = [...Array(cfg.regionTable.size).keys()]
        .map((i) => cfg.regionTable.get(i).kind);
      expect(kinds.filter((k) => k === CfgRegionKind.BLOCK)).length(1);
    });
  });

  describe('cfgToBody readability', () => {
    it('if_else_returns', () => {
      expect(roundTripped(`function f(x) { if (x) { log(1); } else { log(2); } log(3); }`))
        .equals(
          [
            'function f(x) {',
            '  if (x) {',
            '    log(1);',
            '  } else {',
            '    log(2);',
            '  }',
            '  log(3);',
            '}',
          ].join('\n'));
    });

    it('while_loop_is_recovered', () => {
      expect(roundTripped(`function f(n) { while (n) { n--; } return n; }`))
        .equals(
          [
            'function f(n) {',
            '  let returned_0;',
            '  while (n) {',
            '    n--;',
            '  }',
            '  returned_0 = n;',
            '  return returned_0;',
            '}',
          ].join('\n'));
    });

    it('do_while_loop_is_recovered', () => {
      expect(roundTripped(`function f(n) { do { n--; } while (n); }`))
        .equals(
          [
            'function f(n) {',
            '  do {',
            '    n--;',
            '  } while (n);',
            '}',
          ].join('\n'));
    });
  });

  describe('round trips preserve behavior', () => {
    describe('straight_line_and_ifs', () => {
      it('empty', () => sameBehavior(`function f() {}`, [[]]));

      it('guard_then_work', () => sameBehavior(
        `function f(x) {
           if (typeof x !== 'number') { throw new TypeError('bad ' + x); }
           log('ok', x);
           return x * 2;
         }`,
        [[1], ['a'], [0]]));

      it('if_else_chain', () => sameBehavior(
        `function f(x) {
           let r = 'none';
           if (x === 1) { r = 'one'; }
           else if (x === 2) { r = 'two'; }
           else if (x === 3) { r = 'three'; }
           else { r = 'many'; }
           log(r);
           return r;
         }`,
        range(5).map((i) => [i])));

      it('nested_ifs', () => sameBehavior(
        `function f(a, b, c) {
           let out = [];
           if (a) {
             if (b) { out.push('ab'); } else { out.push('a'); }
             if (c) { out.push('ac'); }
           } else if (b) {
             if (c) { out.push('bc'); return out.join(); }
             out.push('b');
           }
           out.push('end');
           return out.join();
         }`,
        [0, 1].flatMap((a) => [0, 1].flatMap((b) => [0, 1].map((c) => [a, b, c])))));

      it('early_returns_and_fallthrough_merges', () => sameBehavior(
        `function f(a, b) {
           if (a) { log('a'); if (b) { return 'ab'; } }
           else { log('not a'); if (b) { log('b'); } }
           log('merged');
           return 'done';
         }`,
        [[0, 0], [0, 1], [1, 0], [1, 1]]));

      it('closures_see_hoisted_lexical_bindings', () => sameBehavior(
        `function f(x) {
           if (!x) { return 'no'; }
           let y = x + 1;
           const get = () => y;
           function g() { return get() * 2; }
           y++;
           return g();
         }`,
        [[0], [1], [5]]));

      it('destructuring_declarations', () => sameBehavior(
        `function f(o) {
           if (!o) { return null; }
           let { a, b: [c, d = 4] } = o;
           const [e, ...rest] = [a, c, d];
           return [a, c, d, e, rest.length].join();
         }`,
        [[null], [{ a: 1, b: [2] }], [{ a: 1, b: [2, 3] }]]));

      it('class_declarations', () => sameBehavior(
        `function f(x) {
           if (x) { return 'x'; }
           class A { m() { return 'A.m'; } }
           class B extends A { m() { return 'B>' + super.m(); } }
           return new B().m();
         }`,
        [[0], [1]]));

      it('conditional_expressions_and_logical_ops_are_opaque', () => sameBehavior(
        `function f(a, b) {
           let x = a ? b : a || b;
           return a && b ? x : (a ?? 'dflt');
         }`,
        [[0, 1], [1, 0], [null, 2], [3, 4]]));
    });

    describe('loops', () => {
      it('while', () => sameBehavior(
        `function f(n) { let s = 0; while (n > 0) { s += n; n--; } return s; }`,
        [[0], [1], [5]]));

      it('do_while', () => sameBehavior(
        `function f(n) { let s = 0; do { s += n; n--; } while (n > 0); return s; }`,
        [[0], [1], [5]]));

      it('for', () => sameBehavior(
        `function f(n) { let s = 0; for (let i = 0; i < n; i++) { s += i; } return s; }`,
        [[0], [1], [5]]));

      it('for_without_test', () => sameBehavior(
        `function f(n) { let i = 0; for (;;) { if (++i > n) { break; } } return i; }`,
        [[0], [3]]));

      it('sequential_for_loops_reuse_the_loop_variable_name', () => sameBehavior(
        `function f(n) {
           let out = [];
           for (let i = 0; i < n; i++) { out.push(i); }
           for (let i = n; i > 0; i--) { out.push(i); }
           return out.join();
         }`,
        [[0], [3]]));

      it('break_and_continue', () => sameBehavior(
        `function f(n) {
           let out = [];
           for (let i = 0; i < 10; i++) {
             if (i % 2) { continue; }
             if (i > n) { break; }
             out.push(i);
           }
           return out.join();
         }`,
        [[-1], [0], [5], [20]]));

      it('labeled_break_and_continue_in_nested_loops', () => sameBehavior(
        `function f(n) {
           let out = [];
           outer: for (let i = 0; i < 4; i++) {
             for (let j = 0; j < 4; j++) {
               if (j === n) { continue outer; }
               if (i === 3) { break outer; }
               out.push(i * 10 + j);
             }
           }
           return out.join();
         }`,
        [[0], [2], [9]]));

      it('labeled_non_loop_block', () => sameBehavior(
        `function f(a) {
           let r = [];
           blk: {
             r.push(1);
             if (a) { break blk; }
             r.push(2);
           }
           r.push(3);
           return r.join();
         }`,
        [[0], [1]]));

      it('closures_capture_per_iteration_bindings', () => sameBehavior(
        `function f(n) {
           let fs = [];
           for (let i = 0; i < n; i++) { let k = i * 2; fs.push(() => k); }
           return fs.map((g) => g()).join();
         }`,
        [[0], [3]]));

      it('for_of', () => sameBehavior(
        `function f(xs) { let s = 0; for (const x of xs) { s += x; } return s; }`,
        [[[]], [[1, 2, 3]]]));

      it('for_of_with_break_calls_iterator_return', () => sameBehavior(
        `function f(n) {
           let closed = 0;
           let it = {
             [Symbol.iterator]() {
               let i = 0;
               return {
                 next() { return { done: i >= 10, value: i++ }; },
                 return() { closed++; return {}; },
               };
             },
           };
           let seen = [];
           for (let x of it) {
             if (x === n) { break; }
             seen.push(x);
           }
           return seen.join() + '|' + closed;
         }`,
        [[0], [3], [99]]));

      it('for_of_with_destructuring_and_assignment_targets', () => sameBehavior(
        `function f(m) {
           let out = [], k, v;
           for (const [a, b] of m) { out.push(a + b); }
           for ([k, v] of m) { out.push(k * v); }
           return out.join();
         }`,
        [[[[1, 2], [3, 4]]]]));

      it('for_in', () => sameBehavior(
        `function f(o) {
           let ks = [];
           for (let k in o) { if (k === 'skip') { continue; } ks.push(k); }
           return ks.join();
         }`,
        [[{}], [{ a: 1, skip: 2, b: 3 }]]));

      it('for_of_with_continue_label', () => sameBehavior(
        `function f(xs) {
           let out = [];
           outer: for (const a of xs) {
             for (const b of xs) {
               if (b > a) { continue outer; }
               out.push(a + ':' + b);
             }
           }
           return out.join();
         }`,
        [[[1, 2, 3]]]));

      it('return_from_inside_loops', () => sameBehavior(
        `function f(n) {
           for (let i = 0; i < 10; i++) {
             while (true) {
               if (i === n) { return 'found ' + i; }
               break;
             }
           }
           return 'none';
         }`,
        [[0], [4], [10]]));

      it('ifs_inside_loops_and_loops_inside_ifs', () => sameBehavior(
        `function f(a, n) {
           let out = [];
           if (a) {
             for (let i = 0; i < n; i++) {
               if (i % 2) { out.push('odd'); } else { out.push('even'); }
             }
           } else {
             let i = n;
             while (i--) { if (i === 1) { out.push('one'); } }
           }
           return out.join();
         }`,
        [[0, 0], [0, 3], [1, 0], [1, 4]]));

      it('loop_with_multiple_exits_to_different_targets', () => sameBehavior(
        `function f(n) {
           let i = 0;
           while (true) {
             i++;
             if (i === n) { log('hit n'); break; }
             if (i > 5) { log('too far'); return 'far'; }
           }
           log('after');
           return 'ok';
         }`,
        [[2], [9]]));

      it('nested_loops', () => sameBehavior(
        `function f(n) {
           let c = 0;
           for (let i = 0; i < n; i++) {
             for (let j = 0; j < n; j++) {
               let k = 0;
               do { c++; k++; } while (k < 2);
             }
           }
           return c;
         }`,
        [[0], [1], [3]]));
    });

    describe('switch', () => {
      it('with_breaks_and_default', () => sameBehavior(
        `function f(x) {
           switch (x) {
           case 1: log('one'); break;
           case 2: log('two'); break;
           default: log('other');
           }
           return 'end';
         }`,
        [[1], [2], [3]]));

      it('fallthrough', () => sameBehavior(
        `function f(x) {
           switch (x) {
           case 1: log('one');
           case 2: log('two'); break;
           case 3: log('three');
           default: log('d');
           }
           return 'end';
         }`,
        [[1], [2], [3], [4]]));

      it('default_in_the_middle', () => sameBehavior(
        `function f(x) {
           switch (x) {
           case 1: log('one'); break;
           default: log('d');
           case 2: log('two'); break;
           }
           return 'end';
         }`,
        [[1], [2], [3]]));

      it('without_default', () => sameBehavior(
        `function f(x) { switch (x) { case 1: log(1); } return x; }`,
        [[1], [2]]));

      it('lexical_declarations_in_cases', () => sameBehavior(
        `function f(x) {
           switch (x) {
           case 0: { let y = 'zero'; log(y); break; }
           case 1: let z = 'one'; log(z); break;
           default: log('d');
           }
           return x;
         }`,
        [[0], [1], [2]]));

      it('returns_inside_cases', () => sameBehavior(
        `function f(x) {
           switch (x) { case 1: return 'a'; case 2: log('b'); break; }
           return 'c';
         }`,
        [[1], [2], [3]]));

      it('switch_in_loop_with_continue_and_break', () => sameBehavior(
        `function f(xs) {
           let out = [];
           loop: for (const x of xs) {
             switch (x) {
             case 'skip': continue loop;
             case 'stop': break loop;
             case 'plain': out.push('p'); break;
             default: out.push(x);
             }
             out.push('.');
           }
           return out.join('');
         }`,
        [[['a', 'skip', 'plain', 'b', 'stop', 'c']]]));

      it('loop_in_switch', () => sameBehavior(
        `function f(x) {
           let s = 0;
           switch (x) {
           case 1: for (let i = 0; i < 3; i++) { s += i; } break;
           case 2: while (s < 10) { s += 4; }
           }
           return s;
         }`,
        [[1], [2], [3]]));
    });

    describe('try_catch_finally', () => {
      it('try_catch', () => sameBehavior(
        `function f(x) {
           try {
             if (x) { throw new Error('boom ' + x); }
             log('fine');
           } catch (e) {
             log('caught ' + e.message);
           }
           return 'end';
         }`,
        [[0], [1]]));

      it('implicit_exceptions_reach_catch', () => sameBehavior(
        `function f(o) {
           try { return o.a.b; } catch { return 'oops'; }
         }`,
        [[{ a: { b: 1 } }], [{}], [null]]));

      it('catch_without_binding_and_rethrow', () => sameBehavior(
        `function f(x) {
           try { throw x; } catch (e) { if (e === 1) { throw 'one'; } log('e=' + e); }
           return 'done';
         }`,
        [[1], [2]]));

      it('try_finally_with_return', () => sameBehavior(
        `function f(x) {
           try {
             if (x) { return 'from try'; }
             log('no return');
           } finally {
             log('finally');
           }
           return 'after';
         }`,
        [[0], [1]]));

      it('finally_overrides_return', () => sameBehavior(
        `function f(x) {
           try { return 'try'; }
           finally { if (x) { return 'finally'; } log('f'); }
         }`,
        [[0], [1]]));

      it('finally_runs_on_throw', () => sameBehavior(
        `function f(x) {
           try {
             if (x) { throw new Error('t'); }
           } finally {
             log('cleanup');
           }
           return 'ok';
         }`,
        [[0], [1]]));

      it('try_catch_finally', () => sameBehavior(
        `function f(x) {
           let r = [];
           try {
             r.push('try');
             if (x === 1) { throw 1; }
             if (x === 2) { return 'early'; }
           } catch (e) {
             r.push('catch' + e);
             if (x === 1) { r.push('c1'); }
           } finally {
             r.push('fin');
             log(r.join());
           }
           return r.join();
         }`,
        [[0], [1], [2]]));

      it('nested_try_statements', () => sameBehavior(
        `function f(x) {
           let r = [];
           try {
             try {
               if (x === 1) { throw 'inner'; }
               if (x === 2) { throw 'outer'; }
               r.push('body');
             } catch (e) {
               r.push('c1:' + e);
               if (e === 'outer') { throw 'rethrown'; }
             } finally {
               r.push('f1');
             }
             r.push('mid');
           } catch (e) {
             r.push('c2:' + e);
           } finally {
             r.push('f2');
           }
           return r.join();
         }`,
        [[0], [1], [2]]));

      it('throw_in_catch_propagates_out_of_function', () => sameBehavior(
        `function f(x) {
           try { throw x; } catch (e) { throw new Error('wrapped ' + e); }
         }`,
        [[1]]));

      it('ifs_inside_try_and_try_inside_ifs', () => sameBehavior(
        `function f(a, b) {
           let r = [];
           if (a) {
             try {
               if (b) { throw 'b'; } else { r.push('nb'); }
             } catch (e) { r.push(e); }
             r.push('after try');
           } else {
             r.push('no a');
           }
           return r.join();
         }`,
        [[0, 0], [1, 0], [1, 1]]));

      it('loops_inside_try_and_try_inside_loops', () => sameBehavior(
        `function f(n) {
           let r = [];
           try {
             for (let i = 0; i < 5; i++) {
               try {
                 if (i === n) { throw 'at ' + i; }
                 if (i === 1) { continue; }
                 r.push(i);
               } catch (e) {
                 r.push(e);
                 break;
               } finally {
                 r.push('f' + i);
               }
             }
           } finally {
             r.push('done');
           }
           return r.join();
         }`,
        [[0], [2], [9]]));

      it('break_and_continue_through_finally', () => sameBehavior(
        `function f(n) {
           let out = [];
           for (let i = 0; i < 4; i++) {
             try {
               if (i === 1) { continue; }
               if (i === n) { break; }
               out.push('b' + i);
             } finally {
               out.push('f' + i);
             }
           }
           return out.join();
         }`,
        [[2], [9]]));

      it('return_from_catch_and_loop_in_catch', () => sameBehavior(
        `function f(x) {
           try { throw x; }
           catch (e) {
             for (let i = 0; i < 3; i++) { if (i === e) { return 'ret' + i; } }
             return 'none';
           }
         }`,
        [[1], [7]]));

      it('lexical_declarations_in_try_catch_finally', () => sameBehavior(
        `function f(x) {
           try {
             let a = x * 2;
             if (a > 4) { throw a; }
             log('a=' + a);
           } catch (e) {
             const b = e + 1;
             log('b=' + b);
           } finally {
             let c = 'c';
             log(c);
           }
           return 'ok';
         }`,
        [[1], [3]]));

      it('for_of_in_try_with_throwing_body', () => sameBehavior(
        `function f(xs) {
           let r = [];
           try {
             for (const x of xs) { if (x === 2) { throw 'two'; } r.push(x); }
           } catch (e) { r.push(e); }
           return r.join();
         }`,
        [[[1, 2, 3]], [[1]]]));
    });

    describe('generators_and_async', () => {
      it('generator_body', () => {
        let src = `function* f(n) { for (let i = 0; i < n; i++) { if (i % 2) { yield i; } } return 'end'; }`;
        let after = roundTripped(src);
        let collect = (code) => {
          let g = new Function(`${code}\nreturn f;`)()(6);
          let out = [];
          for (let r = g.next(); ; r = g.next()) {
            out.push(r.value);
            if (r.done) { break; }
          }
          return out;
        };
        expect(collect(after)).deep.equal(collect(src));
      });
    });
  });
});
