import { expect } from 'chai';
import { describe, it } from 'mocha';

import { parse } from '@babel/parser';
import * as types from '@babel/types';
import generateDefault from '@babel/generator';

import { NameMaker, namesUsedIn } from '../src/name-maker.mjs';
import { cfgFromBody } from '../src/cfg-from-body.mjs';
import { cfgToBody } from '../src/cfg-to-body.mjs';
import { seekTargets, findNodeFor, findPaths } from '../src/cfg-seek.mjs';

const generate = generateDefault.default || generateDefault;

/**
 * Rewrites `function f(...)` in `src` so that a call to `target()` is
 * reached whenever `seeking` is truthy, no matter the inputs.
 * Returns the new source, with `seeking` a free variable.
 */
function seekingTarget(src) {
  let ast = parse(src);
  let fn = ast.program.body[0];
  let nameMaker = new NameMaker(namesUsedIn(ast));
  nameMaker.unusedName('seeking'); // don't collide with the free variable below
  let cfg = cfgFromBody(fn.body, nameMaker);
  // The target is the statement `target();`
  let goal;
  types.traverseFast(fn.body, (n) => {
    if (types.isExpressionStatement(n) && types.isCallExpression(n.expression) &&
        types.isIdentifier(n.expression.callee, { name: 'target' })) {
      goal = n;
    }
  });
  let node = findNodeFor(cfg, goal);
  expect(node, 'target node').not.equal(null);
  let { modified, unreachable } = seekTargets(
    cfg,
    new Map([[node, {
      positive: () => types.identifier('seeking'),
      negative: () => types.unaryExpression('!', types.identifier('seeking')),
    }]]),
    nameMaker);
  expect(unreachable).length(0);
  fn.body = cfgToBody(cfg, nameMaker);
  return { code: generate(ast).code, modified };
}

/** Runs f(...args) with `seeking`; returns {hit, threw, returned}. */
function runSeeking(code, args, seeking) {
  let hit = 0;
  let outcome = {};
  // Like a COMEHERE block, reaching the target turns seeking off.
  let f = new Function(
    'hit', 'log', 'SEEK',
    `let seeking = SEEK; const target = () => { hit(); seeking = false; };\n${code}\nreturn f;`
  )(() => { hit++ }, () => {}, seeking);
  try {
    outcome.returned = f(...args);
  } catch (e) {
    outcome.threw = String(e && e.message || e);
  }
  outcome.hit = hit;
  return outcome;
}

describe('cfg-seek', () => {
  describe('seeking_reaches_the_target_despite_inputs', () => {
    const cases = {
      guard_with_throw: [
        `function f(x) {
           if (typeof x !== 'number') { throw new TypeError(x); }
           target();
         }`,
        [['not a number'], [1]],
      ],
      guard_with_return_first: [
        `function f(x) {
           if (typeof x === 'number') { target(); return; }
           throw new TypeError(x);
         }`,
        [['nope'], [1]],
      ],
      else_branch: [
        `function f(x) {
           if (x) { log(1); } else { log(2); target(); }
         }`,
        [[1], [0]],
      ],
      chain_of_else_ifs: [
        `function f(x) {
           if (x === 1) { log(1); }
           else if (x === 2) { log(2); }
           else { target(); }
         }`,
        [[1], [2], [3]],
      ],
      while_loop_never_entered: [
        `function f(n) { while (n > 0) { target(); n--; } }`,
        [[0], [2]],
      ],
      for_loop_never_entered: [
        `function f(n) { for (let i = 0; i < n; i++) { target(); } }`,
        [[0], [2]],
      ],
      do_while_after_early_exit: [
        `function f(n) {
           if (n) { return 'early'; }
           do { log('x'); } while (false);
           target();
         }`,
        [[1], [0]],
      ],
      for_of_over_empty: [
        `function f(xs) { for (const x of xs) { target(); } }`,
        [[[]], [[1, 2]]],
      ],
      for_in_over_empty: [
        `function f(o) { for (const k in o) { target(); } }`,
        [[{}], [{ a: 1 }]],
      ],
      switch_case: [
        `function f(x) {
           switch (x) { case 1: log(1); break; case 2: target(); break; default: log('d'); }
         }`,
        [[1], [2], [3]],
      ],
      switch_default: [
        `function f(x) {
           switch (x) { case 1: log(1); break; default: target(); }
         }`,
        [[1], [3]],
      ],
      switch_fallthrough: [
        `function f(x) {
           switch (x) { case 1: log(1); case 2: target(); break; case 3: log(3); }
         }`,
        [[1], [2], [3], [4]],
      ],
      catch_block: [
        `function f(x) {
           try { log(x); } catch (e) { target(); }
         }`,
        [[1]],
      ],
      catch_block_after_throwing_try: [
        `function f(x) {
           try { if (x) { throw x; } log('no throw'); } catch (e) { target(); }
           log('after');
         }`,
        [[0], [1]],
      ],
      finally_block_after_return: [
        `function f(x) {
           try { if (x) { return 'r'; } log('no'); } finally { target(); }
         }`,
        [[0], [1]],
      ],
      nested_ifs_loops_and_try: [
        `function f(a, n) {
           if (!a) { return 'nope'; }
           for (let i = 0; i < n; i++) {
             try {
               if (i === 0) { continue; }
               switch (i) { case 1: log(1); break; default: target(); }
             } finally {
               log('f');
             }
           }
         }`,
        [[0, 0], [1, 0], [1, 5]],
      ],
      inside_catch_inside_loop: [
        `function f(n) {
           for (let i = 0; i < n; i++) {
             try { log(i); }
             catch (e) { target(); }
           }
           return 'done';
         }`,
        [[0], [3]],
      ],
    };

    for (let [name, [src, inputs]] of Object.entries(cases)) {
      it(name, () => {
        let { code, modified } = seekingTarget(src);
        for (let args of inputs) {
          let seekingRun = runSeeking(code, args, true);
          expect(seekingRun.hit, `seeking with ${JSON.stringify(args)}\n${code}`)
            .at.least(1);
          // Not seeking: behaves as the original.
          let want = runSeeking(src, args, false);
          let got = runSeeking(code, args, false);
          expect(got, `not seeking with ${JSON.stringify(args)}\n${code}`).deep.equal(want);
        }
        void modified;
      });
    }
  });

  describe('findPaths', () => {
    it('prefers_paths_with_fewer_throws', () => {
      let ast = parse(`function f(x) {
        try { if (x) { throw 1; } target(); } catch (e) { target(); }
      }`);
      let fn = ast.program.body[0];
      let nm = new NameMaker(namesUsedIn(ast));
      let cfg = cfgFromBody(fn.body, nm);
      let targets = [];
      types.traverseFast(fn.body, (n) => {
        if (types.isExpressionStatement(n) &&
            types.isCallExpression(n.expression)) { targets.push(n) }
      });
      let tryTarget = findNodeFor(cfg, targets[0]);
      let paths = findPaths(cfg, [tryTarget]);
      let path = paths.get(tryTarget);
      expect(path.some((e) => e.kind === 3)).equal(false);
    });

    it('reports_unreachable_targets', () => {
      let ast = parse(`function f() { return 1; target(); }`);
      let fn = ast.program.body[0];
      let nm = new NameMaker(namesUsedIn(ast));
      let cfg = cfgFromBody(fn.body, nm);
      let call = fn.body.body[1];
      let node = findNodeFor(cfg, call);
      let { unreachable } = seekTargets(
        cfg,
        new Map([[node, { positive: () => types.identifier('s'), negative: () => types.identifier('s') }]]),
        nm);
      expect(unreachable).deep.equal([node]);
    });
  });
});
