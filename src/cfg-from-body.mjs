/**
 * @fileoverview
 * Builds a Cfg from a Babel BlockStatement (or Program) node.
 *
 * Normalizations:
 * - All normal exits (`return`, falling off the end) flow to one `normalExit`
 *   node which does `return returned_N`.  Each `return x` becomes
 *   `returned_N = x` then an edge to normalExit.
 * - All abrupt exits that no enclosing `catch` in this body handles flow to
 *   one `abruptExit` node which does `throw thrown_N`.
 * - Throws inside a `try` that has a `catch` are LOCAL_THROWS edges to the
 *   catch region's entry.  Each `try` entry also gets a "dummy" LOCAL_THROWS
 *   edge, normally unreachable, so that a catch can be a seek target.
 * - `for (... of ...)` and `for (... in ...)` are desugared to `for (;;)` loops
 *   plus iterator protocol calls inside a try/finally.
 * - Blocks that declare lexical bindings become BLOCK regions so that their
 *   scopes survive regeneration.
 */

import { parse } from '@babel/parser';
import * as types from '@babel/types';
import {
  Cfg, CfgNode, CfgEdge, CfgEdgeKind, CfgRegionTable, CfgRegionKind,
} from './cfg.mjs';

const { NORMAL, CASE, LOCAL_THROWS, LOOP_BACK } = CfgEdgeKind;

/** True for statements that introduce a block-scoped binding. */
export function isLexicalDeclaration(s) {
  return (types.isVariableDeclaration(s) && s.kind !== 'var') ||
    types.isClassDeclaration(s) ||
    types.isFunctionDeclaration(s);
}

/** Parses `code` as statements, replacing `$NAME` identifiers from `subst`. */
function snippet(code, subst = {}) {
  let { program } = parse(code, { sourceType: 'script' });
  let replaceIn = (node) => {
    for (let key of types.VISITOR_KEYS[node.type] || []) {
      let child = node[key];
      if (Array.isArray(child)) {
        child.forEach((c, i) => {
          if (types.isIdentifier(c) && Object.hasOwn(subst, c.name)) {
            child[i] = types.cloneNode(subst[c.name]);
          } else if (c) { replaceIn(c) }
        });
      } else if (child) {
        if (types.isIdentifier(child) && Object.hasOwn(subst, child.name)) {
          node[key] = types.cloneNode(subst[child.name]);
        } else { replaceIn(child) }
      }
    }
  };
  program.body.forEach((stmt) => {
    // Top-level statements can't be identifiers, so just recurse.
    replaceIn(stmt);
  });
  return program.body;
}

function desugarForIn(s) {
  // for (L in R) B -> for (L of (function*(o){ for (const k in o) yield k })(R)) B
  let [gen] = snippet('(function*(o){ for (const k in o) { yield k; } })($R);', {
    $R: s.right,
  });
  return types.forOfStatement(s.left, gen.expression, s.body);
}

/** Returns a statement equivalent to `s`, a for-of, with no for-of. */
function desugarForOf(s, labels, nameMaker) {
  if (s.await) { throw new Error('for await is not supported'); }
  let id = (prefix) => types.identifier(nameMaker.unusedName(prefix));
  let iter = id('iter'), done = id('done'), step = id('step');
  let { left } = s;
  let bind;
  let value = types.memberExpression(types.cloneNode(step), types.identifier('value'));
  if (types.isVariableDeclaration(left)) {
    bind = types.variableDeclaration(left.kind, [
      types.variableDeclarator(left.declarations[0].id, value),
    ]);
  } else {
    bind = types.expressionStatement(types.assignmentExpression('=', left, value));
  }
  let body = types.isBlockStatement(s.body) ? s.body.body : [s.body];
  let block = snippet(
    `{
       const $ITER = ($R)[Symbol.iterator]();
       let $DONE = false;
       try {
         for (;;) {
           $DONE = true;
           const $STEP = $ITER.next();
           $DONE = $STEP.done;
           if ($DONE) { break; }
         }
       } finally {
         if (!$DONE) { const r = $ITER.return; if (r) { r.call($ITER); } }
       }
     }`,
    { $R: s.right, $ITER: iter, $DONE: done, $STEP: step },
  )[0];
  let forStmt = block.body[2].block.body[0];
  forStmt.body.body.push(bind, ...body);
  // Re-attach labels so `continue label` and `break label` hit the inner loop.
  let inner = forStmt;
  for (let i = labels.length; --i >= 0;) {
    inner = types.labeledStatement(types.identifier(labels[i]), inner);
  }
  block.body[2].block.body[0] = inner;
  return block;
}

/**
 * @param body A Babel BlockStatement or Program.
 * @param nameMaker used to allocate fresh names that do not conflict.
 * @param {{isFunction?: boolean}} opts `isFunction` is false for module bodies.
 * @return {Cfg}
 */
export function cfgFromBody(body, nameMaker, { isFunction = true } = {}) {
  const regions = new CfgRegionTable();
  const preamble = [];
  let returnedName = null;
  let thrownName = null;
  const getReturned = () => returnedName ||= nameMaker.unusedName('returned');
  const getThrown = () => thrownName ||= nameMaker.unusedName('thrown');

  const mk = (region, stmt = null) => {
    let n = new CfgNode(stmt, region);
    return n;
  };
  const edge = (source, target, kind = NORMAL, expr = null) =>
    new CfgEdge({ kind, source, target, expr });

  const start = mk(0);
  const normalExit = mk(0);
  const abruptExit = mk(0);

  /** Stack of break/continue targets. */
  const ctxs = [];
  /** Stack of catch entry nodes, innermost last. */
  const handlers = [];
  /** Exports collected from `export const x = ...` so they can be hoisted. */
  let exportedNames = [];

  const simple = (s, cur, region) => {
    let n = mk(region, s);
    edge(cur, n);
    return n;
  };

  function dead(region) { return mk(region); }

  function bodyOf(stmts, cur, region) {
    for (let s of stmts) { cur = stmt(s, cur, region, []); }
    return cur;
  }

  function newRegion(kind, parent, group = null, param = null) {
    return regions.add(kind, parent, group, param);
  }

  /**
   * Enters a BLOCK region if `stmts` need one.
   * Returns [innerRegion, innerStart, finish(endNode) -> outerNode].
   */
  function maybeBlockRegion(needed, cur, region) {
    if (!needed) { return [region, cur, (end) => end]; }
    let r = newRegion(CfgRegionKind.BLOCK, region);
    let entry = mk(r);
    regions.get(r).entry = entry;
    edge(cur, entry);
    return [r, entry, (end) => {
      let exit = mk(region);
      edge(end, exit);
      return exit;
    }];
  }

  function findCtx(label, forContinue) {
    for (let i = ctxs.length; --i >= 0;) {
      let c = ctxs[i];
      if (label !== null) {
        if (c.labels.includes(label)) { return c; }
      } else if (forContinue ? c.continueTarget : c.kind !== 'label') {
        return c;
      }
    }
    throw new Error(`No target for ${forContinue ? 'continue' : 'break'} ${label ?? ''}`);
  }

  function loopHelper(labels, kind) {
    return { labels, kind, breakTarget: null, continueTarget: null, continueIsBack: false };
  }

  function stmt(s, cur, region, labels) {
    switch (s.type) {
    case 'EmptyStatement':
      return cur;
    case 'ExpressionStatement':
    case 'VariableDeclaration':
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'DebuggerStatement':
      return simple(s, cur, region);
    case 'BlockStatement': {
      let [r, inner, finish] = maybeBlockRegion(s.body.some(isLexicalDeclaration), cur, region);
      return finish(bodyOf(s.body, inner, r));
    }
    case 'IfStatement': {
      let cond = mk(region);
      cond.source = s;
      edge(cur, cond);
      let join = mk(region);
      let thenStart = mk(region);
      edge(cond, thenStart, NORMAL, s.test);
      edge(stmt(s.consequent, thenStart, region, []), join);
      if (s.alternate) {
        let elseStart = mk(region);
        edge(cond, elseStart);
        edge(stmt(s.alternate, elseStart, region, []), join);
      } else {
        edge(cond, join);
      }
      return join;
    }
    case 'LabeledStatement': {
      let name = s.label.name;
      let inner = s.body;
      if (types.isLoop(inner) || types.isLabeledStatement(inner)) {
        return stmt(inner, cur, region, [...labels, name]);
      }
      let after = mk(region);
      let c = loopHelper([...labels, name], 'label');
      c.breakTarget = after;
      ctxs.push(c);
      let end = stmt(inner, cur, region, []);
      ctxs.pop();
      edge(end, after);
      return after;
    }
    case 'WhileStatement': {
      let head = mk(region);
      edge(cur, head);
      let after = mk(region);
      let bodyStart = mk(region);
      edge(head, bodyStart, NORMAL, s.test);
      edge(head, after);
      let c = loopHelper(labels, 'loop');
      c.breakTarget = after; c.continueTarget = head; c.continueIsBack = true;
      ctxs.push(c);
      let end = stmt(s.body, bodyStart, region, []);
      ctxs.pop();
      edge(end, head, LOOP_BACK);
      return after;
    }
    case 'DoWhileStatement': {
      let head = mk(region);
      edge(cur, head);
      let condNode = mk(region);
      let after = mk(region);
      let c = loopHelper(labels, 'loop');
      c.breakTarget = after; c.continueTarget = condNode;
      ctxs.push(c);
      let end = stmt(s.body, head, region, []);
      ctxs.pop();
      edge(end, condNode);
      edge(condNode, head, LOOP_BACK, s.test);
      edge(condNode, after);
      return after;
    }
    case 'ForStatement': {
      let lexicalInit = types.isVariableDeclaration(s.init) && s.init.kind !== 'var';
      let [r, inner, finish] = maybeBlockRegion(lexicalInit, cur, region);
      let c0 = inner;
      if (s.init) {
        c0 = simple(
          types.isVariableDeclaration(s.init) ? s.init : types.expressionStatement(s.init),
          c0, r);
      }
      let head = mk(r);
      edge(c0, head);
      let after = mk(r);
      let bodyStart = mk(r);
      let update = mk(r, s.update ? types.expressionStatement(s.update) : null);
      if (s.test) {
        edge(head, bodyStart, NORMAL, s.test);
        edge(head, after);
      } else {
        edge(head, bodyStart);
      }
      let c = loopHelper(labels, 'loop');
      c.breakTarget = after; c.continueTarget = update;
      ctxs.push(c);
      let end = stmt(s.body, bodyStart, r, []);
      ctxs.pop();
      edge(end, update);
      edge(update, head, LOOP_BACK);
      return finish(after);
    }
    case 'ForInStatement':
      return stmt(desugarForIn(s), cur, region, labels);
    case 'ForOfStatement':
      return stmt(desugarForOf(s, labels, nameMaker), cur, region, []);
    case 'SwitchStatement': {
      let needBlock = s.cases.some((c) => c.consequent.some(isLexicalDeclaration));
      let [r, inner, finish] = maybeBlockRegion(needBlock, cur, region);
      let head = mk(r);
      head.tag = 'switch';
      head.discriminant = s.discriminant;
      edge(inner, head);
      let after = mk(r);
      let c = loopHelper(labels, 'switch');
      c.breakTarget = after;
      ctxs.push(c);
      let entries = s.cases.map(() => mk(r));
      let prevEnd = null;
      s.cases.forEach((sc, i) => {
        if (prevEnd) { edge(prevEnd, entries[i]); }
        if (sc.test) { edge(head, entries[i], CASE, sc.test); }
        prevEnd = bodyOf(sc.consequent, entries[i], r);
      });
      ctxs.pop();
      edge(prevEnd || head, after);
      let defaultIndex = s.cases.findIndex((sc) => !sc.test);
      edge(head, defaultIndex >= 0 ? entries[defaultIndex] : after);
      return finish(after);
    }
    case 'BreakStatement': {
      let c = findCtx(s.label ? s.label.name : null, false);
      edge(cur, c.breakTarget);
      return dead(region);
    }
    case 'ContinueStatement': {
      let c = findCtx(s.label ? s.label.name : null, true);
      edge(cur, c.continueTarget, c.continueIsBack ? LOOP_BACK : NORMAL);
      return dead(region);
    }
    case 'ReturnStatement': {
      if (!isFunction) { throw new Error('return outside function'); }
      if (s.argument) {
        let n = mk(region, types.expressionStatement(
          types.assignmentExpression(
            '=', types.identifier(getReturned()), s.argument)));
        edge(cur, n);
        cur = n;
      }
      edge(cur, normalExit);
      return dead(region);
    }
    case 'ThrowStatement': {
      let handler = handlers[handlers.length - 1];
      if (handler) {
        edge(cur, handler, LOCAL_THROWS, s.argument);
      } else {
        let n = mk(region, types.expressionStatement(
          types.assignmentExpression(
            '=', types.identifier(getThrown()), s.argument)));
        edge(cur, n);
        edge(n, abruptExit);
      }
      return dead(region);
    }
    case 'TryStatement': {
      let group = regions.newGroup();
      let hasCatch = !!s.handler;
      let hasFinally = !!s.finalizer;
      let tryR = newRegion(CfgRegionKind.TRY, region, group);
      let catchR = hasCatch
        ? newRegion(CfgRegionKind.CATCH, region, group, s.handler.param) : null;
      let finR = hasFinally ? newRegion(CfgRegionKind.FINALLY, region, group) : null;
      let tryEntry = mk(tryR);
      regions.get(tryR).entry = tryEntry;
      edge(cur, tryEntry);
      let after = mk(region);
      let catchEntry = null;
      if (hasCatch) {
        catchEntry = mk(catchR);
        regions.get(catchR).entry = catchEntry;
        let dummy = edge(tryEntry, catchEntry, LOCAL_THROWS, null);
        dummy.dummy = true;
      }
      let finEntry = null;
      if (hasFinally) {
        finEntry = mk(finR);
        regions.get(finR).entry = finEntry;
      }
      let normalTarget = finEntry || after;

      if (hasCatch) { handlers.push(catchEntry); }
      let tryBody = mk(tryR);
      edge(tryEntry, tryBody);
      let tryEnd = bodyOf(s.block.body, tryBody, tryR);
      if (hasCatch) { handlers.pop(); }
      edge(tryEnd, normalTarget);

      if (hasCatch) {
        let catchBody = mk(catchR);
        edge(catchEntry, catchBody);
        let catchEnd = bodyOf(s.handler.body.body, catchBody, catchR);
        edge(catchEnd, normalTarget);
      }
      if (hasFinally) {
        let finBody = mk(finR);
        edge(finEntry, finBody);
        let finEnd = bodyOf(s.finalizer.body, finBody, finR);
        let finTail = mk(finR);
        finTail.tag = 'finally-end';
        edge(finEnd, finTail);
        edge(finTail, after);
      }
      return after;
    }
    case 'ImportDeclaration':
      preamble.push(s);
      return cur;
    case 'ExportAllDeclaration':
      preamble.push(s);
      return cur;
    case 'ExportNamedDeclaration': {
      let d = s.declaration;
      if (!d) { preamble.push(s); return cur; }
      if (types.isFunctionDeclaration(d)) {
        // Hoisted anyway; keep as is at the top.
        preamble.push(s);
        return cur;
      }
      let names = Object.keys(types.getBindingIdentifiers(d));
      exportedNames.push(...names);
      return stmt(d, cur, region, []);
    }
    default:
      throw new Error(`Unsupported statement type ${s.type}`);
    }
  }

  let last = bodyOf(body.body, start, 0);
  edge(last, normalExit);

  if (exportedNames.length) {
    preamble.push(types.exportNamedDeclaration(
      null,
      exportedNames.map((n) => types.exportSpecifier(
        types.identifier(n), types.identifier(n))),
    ));
  }
  if (returnedName) {
    normalExit.stmt = types.returnStatement(types.identifier(returnedName));
  }
  if (thrownName || abruptExit.incoming.length) {
    abruptExit.stmt = types.throwStatement(types.identifier(getThrown()));
  }

  return new Cfg({
    start,
    normalExit: normalExit.incoming.length ? normalExit : null,
    abruptExit: abruptExit.incoming.length ? abruptExit : null,
    regionTable: regions,
    returnedName,
    thrownName,
    preamble,
  });
}
