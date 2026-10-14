/**
 * @fileoverview
 * Regenerates a Babel BlockStatement from a Cfg.
 *
 * Strategy ("Beyond Relooper"-style structuring):
 *
 * - Each region (root, `try`/`catch`/`finally`, lexical BLOCK) is emitted as a
 *   frame.  Inside a frame, child regions are contracted to single units:
 *   all of a try's regions form one unit emitted as a `try` statement, and a
 *   BLOCK region becomes a `{ ... }` statement.  That keeps `finally`
 *   semantics and lexical scopes intact.
 * - Within a frame, we compute dominators over forward edges.  Units with
 *   multiple forward predecessors ("merges") get a labeled block placed so
 *   that jumps to them are `break label`.  Loops become
 *   `label: while (true) { ... }` with `continue label` for back edges.
 * - Units that are single-predecessor are inlined at the branch.
 * - Lexical declarations directly in a region are hoisted to the top of the
 *   region as `let x;` plus assignments at the original sites, so that
 *   labeled blocks do not hide bindings from later code.
 * - A final peephole pass removes redundant tail `break`s and unused labels.
 */

import * as types from '@babel/types';
import { CfgEdgeKind, CfgRegionKind, reachableNodes } from './cfg.mjs';

const { LOCAL_THROWS, LOOP_BACK, CASE } = CfgEdgeKind;

// ---------------------------------------------------------------------------
// Peephole simplification
// ---------------------------------------------------------------------------

function referencesLabel(node, label) {
  let found = false;
  let visit = (n) => {
    if (!n || found || typeof n.type !== 'string') { return }
    if ((n.type === 'BreakStatement' || n.type === 'ContinueStatement') &&
        n.label && n.label.name === label) {
      found = true;
      return;
    }
    for (let key of types.VISITOR_KEYS[n.type] || []) {
      let child = n[key];
      if (Array.isArray(child)) { child.forEach(visit) } else { visit(child) }
    }
  };
  visit(node);
  return found;
}

/** Removes `break label;` from tail positions of `list`. */
function removeTailBreak(list, label) {
  let last = list[list.length - 1];
  if (!last) { return }
  if (types.isBreakStatement(last) && last.label && last.label.name === label) {
    list.pop();
  } else if (types.isIfStatement(last)) {
    for (let key of ['consequent', 'alternate']) {
      let branch = last[key];
      if (types.isBlockStatement(branch)) {
        removeTailBreak(branch.body, label);
      } else if (types.isBreakStatement(branch) && branch.label &&
                 branch.label.name === label) {
        last[key] = types.blockStatement([]);
      }
    }
  } else if (types.isBlockStatement(last)) {
    removeTailBreak(last.body, label);
  } else if (types.isTryStatement(last)) {
    // Falling out of the end of a try or catch block is equivalent to a
    // `break` to just after it, even with a `finally`.  The `finally` block
    // is different: `break` there overrides pending abrupt completions.
    removeTailBreak(last.block.body, label);
    if (last.handler) { removeTailBreak(last.handler.body.body, label) }
  }
}

/** Replaces `break from`/`continue from` with `to`. */
function retarget(node, from, to) {
  let visit = (n) => {
    if (!n || typeof n.type !== 'string') { return }
    if ((n.type === 'BreakStatement' || n.type === 'ContinueStatement') &&
        n.label && n.label.name === from) {
      n.label = types.identifier(to);
    }
    for (let key of types.VISITOR_KEYS[n.type] || []) {
      let child = n[key];
      if (Array.isArray(child)) { child.forEach(visit) } else { visit(child) }
    }
  };
  visit(node);
}

/**
 * Turns `break label`/`continue label` that target `loop` into unlabeled
 * jumps where nothing else breakable intervenes, and drops the label when
 * nothing refers to it.  Returns the possibly-unlabeled loop.
 */
function unlabelLoopJumps(loop, label) {
  let visit = (n, inLoop, inSwitch) => {
    if (!n || typeof n.type !== 'string') { return }
    if (types.isFunction(n)) { return }
    if (n.type === 'BreakStatement' && n.label && n.label.name === label &&
        !inLoop && !inSwitch) {
      n.label = null;
    } else if (n.type === 'ContinueStatement' && n.label &&
               n.label.name === label && !inLoop) {
      n.label = null;
    }
    let nowInLoop = inLoop || types.isLoop(n);
    let nowInSwitch = inSwitch || types.isSwitchStatement(n);
    for (let key of types.VISITOR_KEYS[n.type] || []) {
      let child = n[key];
      if (Array.isArray(child)) {
        child.forEach((c) => visit(c, nowInLoop, nowInSwitch));
      } else { visit(child, nowInLoop, nowInSwitch) }
    }
  };
  visit(loop.body, false, false);
  return referencesLabel(loop.body, label)
    ? types.labeledStatement(types.identifier(label), loop)
    : loop;
}

const isTrue = (n) => types.isBooleanLiteral(n, { value: true });
const isJump = (n, type, label) => types.isBlockStatement(n) &&
    n.body.length === 1 && n.body[0].type === type &&
    n.body[0].label && n.body[0].label.name === label;

/**
 * Recognizes
 *     outer: { inner: while (true) { if (C) { B; continue inner; } else { break outer; } } }
 * and
 *     outer: { inner: while (true) { B; if (E) { continue inner; } else { break outer; } } }
 * and rewrites them to `while (C) { B }` and `do { B } while (E)`.
 */
function recoverLoop(outerLabel, block) {
  if (!types.isBlockStatement(block) || block.body.length !== 1) { return null }
  let labeled = block.body[0];
  if (!types.isLabeledStatement(labeled)) { return null }
  let innerLabel = labeled.label.name;
  let loop = labeled.body;
  if (!types.isWhileStatement(loop) || !isTrue(loop.test)) { return null }
  let stmts = loop.body.body;
  let last = stmts[stmts.length - 1];
  if (!types.isIfStatement(last) || !last.alternate) { return null }
  let done = (branch) => isJump(branch, 'BreakStatement', outerLabel);
  let again = (branch) => isJump(branch, 'ContinueStatement', innerLabel);
  let result = null;
  if (stmts.length === 1 && types.isBlockStatement(last.consequent) &&
      done(last.alternate)) {
    let body = last.consequent.body;
    let tail = body[body.length - 1];
    if (types.isContinueStatement(tail) && tail.label &&
        tail.label.name === innerLabel) {
      result = types.whileStatement(
        last.test, types.blockStatement(body.slice(0, -1)));
    }
  } else if (again(last.consequent) && done(last.alternate)) {
    result = types.doWhileStatement(
      last.test, types.blockStatement(stmts.slice(0, -1)));
  }
  if (!result) { return null }
  // Remaining exits through the outer label now just exit the loop.
  retarget(result.body, outerLabel, innerLabel);
  return unlabelLoopJumps(result, innerLabel);
}

/**
 * Recognizes `outer: { switch (...) { ... break outer; ... } }` and turns the
 * jumps into plain `break`s where nothing else breakable intervenes.
 */
function recoverSwitch(outerLabel, block) {
  if (!types.isBlockStatement(block) || block.body.length !== 1 ||
      !types.isSwitchStatement(block.body[0])) {
    return null;
  }
  let sw = block.body[0];
  let visit = (n, inLoop) => {
    if (!n || typeof n.type !== 'string' || types.isFunction(n)) { return }
    if (n.type === 'BreakStatement' && n.label &&
        n.label.name === outerLabel && !inLoop) {
      n.label = null;
    }
    let nowInLoop = inLoop || types.isLoop(n) || types.isSwitchStatement(n);
    for (let key of types.VISITOR_KEYS[n.type] || []) {
      let child = n[key];
      if (Array.isArray(child)) { child.forEach((c) => visit(c, nowInLoop)) } else {
        visit(child, nowInLoop);
      }
    }
  };
  for (let c of sw.cases) { c.consequent.forEach((x) => visit(x, false)) }
  // Drop a redundant trailing `break;` and an empty trailing `default:`.
  let last = sw.cases[sw.cases.length - 1];
  if (last) {
    let tail = last.consequent[last.consequent.length - 1];
    if (types.isBreakStatement(tail) && !tail.label) { last.consequent.pop() }
    if (last.test === null && last.consequent.length === 0 && sw.cases.length > 1) {
      sw.cases.pop();
    }
  }
  return referencesLabel(sw, outerLabel)
    ? types.labeledStatement(types.identifier(outerLabel), block)
    : sw;
}

/** If a block contains just one block, returns its statements instead. */
function flattenBlock(block) {
  while (block.body.length === 1 && types.isBlockStatement(block.body[0])) {
    block.body = block.body[0].body;
  }
  return block;
}

function simplifyList(list) {
  let out = [];
  for (let s of list) {
    let r = simplifyStatement(s);
    if (Array.isArray(r)) { out.push(...r) } else { out.push(r) }
  }
  return out;
}

function asBlock(s) {
  return types.isBlockStatement(s) ? s : types.blockStatement([s]);
}

/** Returns a statement, or an array of statements to splice. */
function simplifyStatement(s) {
  switch (s.type) {
  case 'BlockStatement':
    s.body = simplifyList(s.body);
    return s;
  case 'IfStatement': {
    s.consequent = flattenBlock(asBlock(first(simplifyStatement(asBlock(s.consequent)))));
    if (s.alternate) {
      let alt = types.isIfStatement(s.alternate)
        ? first(simplifyStatement(s.alternate))
        : flattenBlock(asBlock(first(simplifyStatement(asBlock(s.alternate)))));
      s.alternate = alt;
      if (types.isBlockStatement(alt) && alt.body.length === 0) {
        s.alternate = null;
      }
    }
    return s;
  }
  case 'LabeledStatement': {
    let label = s.label.name;
    let body = first(simplifyStatement(s.body));
    s.body = body;
    let recovered = recoverLoop(label, body);
    if (recovered) { return simplifyStatement(recovered) }
    let recoveredSwitch = recoverSwitch(label, body);
    if (recoveredSwitch) { return recoveredSwitch }
    if (types.isBlockStatement(body)) {
      removeTailBreak(body.body, label);
    }
    if (!referencesLabel(body, label)) {
      return types.isBlockStatement(body) ? body.body : body;
    }
    return s;
  }
  case 'WhileStatement':
  case 'DoWhileStatement':
  case 'ForStatement':
    s.body = flattenBlock(asBlock(first(simplifyStatement(asBlock(s.body)))));
    return s;
  case 'SwitchStatement':
    for (let c of s.cases) { c.consequent = simplifyList(c.consequent) }
    return s;
  case 'TryStatement':
    s.block.body = simplifyList(s.block.body);
    flattenBlock(s.block);
    if (s.handler) { s.handler.body.body = simplifyList(s.handler.body.body) }
    if (s.finalizer) {
      s.finalizer.body = simplifyList(s.finalizer.body);
      flattenBlock(s.finalizer);
    }
    return s;
  default:
    return s;
  }
}

function first(x) {
  if (Array.isArray(x)) { return types.blockStatement(x) }
  return x;
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/**
 * @param {import('./cfg.mjs').Cfg} cfg
 * @param nameMaker used to allocate label names.
 * @return a Babel BlockStatement.
 */
export function cfgToBody(cfg, nameMaker) {
  const rt = cfg.regionTable;

  const reachableList = reachableNodes(cfg);
  const reachable = new Set(reachableList);

  const fresh = (prefix) => nameMaker.unusedName(prefix);
  const emitted = new Set();

  function chainHasGroup(region, group) {
    for (let r = region; r !== null; r = rt.get(r).parent) {
      if (rt.get(r).group === group) { return true }
    }
    return false;
  }

  /** Representative node of the unit of `r`'s frame containing `n`, or null. */
  function unitRepOf(n, r) {
    let c = n.region;
    if (c === r) { return n }
    while (c !== null && rt.get(c).parent !== r) { c = rt.get(c).parent }
    if (c === null) { return null }
    let reg = rt.get(c);
    if (reg.group !== null) {
      return rt.get(rt.groupMembers(reg.group)[CfgRegionKind.TRY]).entry;
    }
    return reg.entry;
  }

  /** Emits the statements for region `r`. */
  function emitFrame(r, parentCtx) {
    const labels = new Map(parentCtx ? parentCtx.labels : []);
    const loops = new Map(parentCtx ? parentCtx.loops : []);
    const endLabel = fresh('L');
    let endUsed = false;

    const entryNode = r === 0 ? cfg.start : rt.get(r).entry;
    const entryRep = entryNode;

    // ---- Collect units -------------------------------------------------
    const units = new Map(); // rep -> unit
    const nodesInFrame = [];
    for (let n of reachableList) {
      if (!rt.contains(r, n.region)) { continue }
      nodesInFrame.push(n);
      let rep = unitRepOf(n, r);
      let u = units.get(rep);
      if (!u) {
        let kind = 'node', region = null;
        if (rep.region !== r) {
          // Find child region.
          let c = rep.region;
          while (rt.get(c).parent !== r) { c = rt.get(c).parent }
          region = c;
          kind = rt.get(c).group !== null ? 'group' : 'block';
        }
        u = { rep, kind, region, members: [], succs: [], preds: [] };
        units.set(rep, u);
      }
      u.members.push(n);
    }

    // ---- Unit graph ----------------------------------------------------
    const backEdges = []; // [fromUnit, toUnit]
    const forcedMerge = new Set();
    const fwdInCount = new Map();
    for (let u of units.values()) {
      for (let m of u.members) {
        // Several `case`s of one switch can share a body: count that once.
        let switchTargets = new Set();
        for (let e of m.outgoing) {
          if (e.kind === LOCAL_THROWS) { continue }
          let tu = rt.contains(r, e.target.region) ? units.get(unitRepOf(e.target, r)) : null;
          if (!tu || tu === u) { continue }
          if (m.tag === 'switch') {
            if (switchTargets.has(tu)) { continue }
            switchTargets.add(tu);
          }
          if (e.kind === LOOP_BACK) {
            backEdges.push([u, tu]);
            continue;
          }
          u.succs.push(tu);
          tu.preds.push(u);
          fwdInCount.set(tu, (fwdInCount.get(tu) || 0) + 1);
          if (u.kind !== 'node' && m.tag !== 'finally-end') { forcedMerge.add(tu) }
        }
      }
    }
    const entry = units.get(entryRep);

    // ---- Reverse post order and dominators -----------------------------
    const rpoIndex = new Map();
    const order = [];
    {
      let visited = new Set();
      let post = [];
      let dfs = (u) => {
        visited.add(u);
        for (let s of u.succs) { if (!visited.has(s)) { dfs(s) } }
        post.push(u);
      };
      dfs(entry);
      order.push(...post.reverse());
      order.forEach((u, i) => rpoIndex.set(u, i));
    }
    const idom = new Map();
    idom.set(entry, entry);
    {
      let intersect = (a, b) => {
        while (a !== b) {
          while (rpoIndex.get(a) > rpoIndex.get(b)) { a = idom.get(a) }
          while (rpoIndex.get(b) > rpoIndex.get(a)) { b = idom.get(b) }
        }
        return a;
      };
      let changed = true;
      while (changed) {
        changed = false;
        for (let u of order) {
          if (u === entry) { continue }
          let newIdom = null;
          for (let p of u.preds) {
            if (!idom.has(p)) { continue }
            newIdom = newIdom === null ? p : intersect(p, newIdom);
          }
          if (newIdom !== null && idom.get(u) !== newIdom) {
            idom.set(u, newIdom);
            changed = true;
          }
        }
      }
    }

    // ---- Loops ---------------------------------------------------------
    const loopBodies = new Map(); // header unit -> Set<unit>
    for (let [from, header] of backEdges) {
      if (!rpoIndex.has(from)) { continue }
      let body = loopBodies.get(header);
      if (!body) {
        body = new Set([header]);
        loopBodies.set(header, body);
      }
      let stack = [from];
      while (stack.length) {
        let x = stack.pop();
        if (body.has(x)) { continue }
        body.add(x);
        for (let p of x.preds) { stack.push(p) }
      }
    }
    const loopsBySize = [...loopBodies.entries()]
      .sort((a, b) => b[1].size - a[1].size);

    // Loop exits dominated from inside a loop are emitted just after it.
    const liftedBy = new Map(); // header unit -> [units]
    const liftedSet = new Set();
    for (let u of order) {
      if (u === entry) { continue }
      for (let [header, body] of loopsBySize) {
        if (body.has(idom.get(u)) && !body.has(u)) {
          if (!liftedBy.has(header)) { liftedBy.set(header, []) }
          liftedBy.get(header).push(u);
          liftedSet.add(u);
          break;
        }
      }
    }

    // Merges, and who owns their labeled blocks.
    const children = new Map(); // unit -> [merge units]
    for (let u of order) {
      if (u === entry || liftedSet.has(u)) { continue }
      if ((fwdInCount.get(u) || 0) >= 2 || forcedMerge.has(u)) {
        let owner = idom.get(u);
        if (!children.has(owner)) { children.set(owner, []) }
        children.get(owner).push(u);
      }
    }
    const byRpo = (a, b) => rpoIndex.get(a) - rpoIndex.get(b);
    for (let list of children.values()) { list.sort(byRpo) }
    for (let list of liftedBy.values()) { list.sort(byRpo) }

    // ---- Declarations hoisted to the top of the region -----------------
    // Lexical declarations are normally turned into `let x;` at the top of the
    // region plus an assignment, so that labeled blocks never hide a binding
    // from code that follows.  Declarations that end up at the top level of
    // the region's statement list, outside any labeled block or branch, can
    // stay as they are.
    const hoistNames = [];
    const prelude = [];
    let nesting = 0;
    if (r === 0) {
      for (let n of [cfg.returnedName, cfg.thrownName]) {
        if (n) { hoistNames.push(n) }
      }
    }
    for (let n of nodesInFrame) {
      if (n.region === r && n.stmt && types.isFunctionDeclaration(n.stmt)) {
        prelude.push(n.stmt);
      }
    }
    const allowInPlace = prelude.length === 0 && !(r === 0 && cfg.preamble.length);

    /** Statements for the declaration or other statement of node `n`. */
    function statementsFor(n) {
      let s = n.stmt;
      if (types.isFunctionDeclaration(s)) { return [] }
      let lexical = (types.isVariableDeclaration(s) && s.kind !== 'var') ||
          types.isClassDeclaration(s);
      if (!lexical || (nesting === 0 && allowInPlace)) { return [s] }
      if (types.isClassDeclaration(s)) {
        hoistNames.push(s.id.name);
        return [types.expressionStatement(
          types.assignmentExpression(
            '=', types.identifier(s.id.name),
            types.classExpression(s.id, s.superClass, s.body, s.decorators)))];
      }
      let out = [];
      for (let d of s.declarations) {
        hoistNames.push(...Object.keys(types.getBindingIdentifiers(d.id)));
        if (d.init) {
          out.push(types.expressionStatement(
            types.assignmentExpression('=', d.id, d.init)));
        }
      }
      return out;
    }

    // ---- Emission ------------------------------------------------------
    const ctx = { labels, loops };

    function register(ys) {
      for (let y of ys) { labels.set(y.rep, fresh('L')) }
    }

    function doTree(u) {
      if (emitted.has(u)) { throw new Error('Unit emitted twice'); }
      emitted.add(u);
      if (loopBodies.has(u)) { return doLoop(u) }
      return nodeWithin(u, children.get(u) || []);
    }

    function wrap(code, ys) {
      for (let y of ys) {
        code = [
          types.labeledStatement(
            types.identifier(labels.get(y.rep)), types.blockStatement(code)),
          ...doTree(y),
        ];
      }
      return code;
    }

    function nodeWithin(u, ys) {
      register(ys);
      if (ys.length) { nesting++ }
      let code = unitCode(u);
      if (ys.length) { nesting-- }
      return wrap(code, ys);
    }

    function doLoop(u) {
      let lifted = liftedBy.get(u) || [];
      register(lifted);
      let loopLabel = fresh('L');
      loops.set(u.rep, loopLabel);
      nesting++;
      let inner = nodeWithin(u, children.get(u) || []);
      nesting--;
      let code = [
        types.labeledStatement(
          types.identifier(loopLabel),
          types.whileStatement(types.booleanLiteral(true), types.blockStatement(inner))),
      ];
      return wrap(code, lifted);
    }

    function jump(label, kind = 'break') {
      let id = types.identifier(label);
      return [kind === 'break' ? types.breakStatement(id) : types.continueStatement(id)];
    }

    function endBreak() {
      endUsed = true;
      return jump(endLabel);
    }

    /** Statements transferring control along `e`. */
    function branchCode(e) {
      if (e.kind === LOCAL_THROWS) {
        return [types.throwStatement(e.expr || types.nullLiteral())];
      }
      if (e.kind === LOOP_BACK) {
        let l = loops.get(e.target);
        if (!l) { throw new Error('continue without loop label'); }
        return jump(l, 'continue');
      }
      let t = e.target;
      if (rt.contains(r, t.region)) {
        let rep = unitRepOf(t, r);
        if (labels.has(rep)) { return jump(labels.get(rep)) }
        return doTree(units.get(rep));
      }
      let g = rt.get(r).group;
      if (g !== null && chainHasGroup(t.region, g)) { return endBreak() }
      if (labels.has(t)) { return jump(labels.get(t)) }
      throw new Error('No label for external jump target');
    }

    function nodeCode(m) {
      let out = [];
      if (m.stmt) {
        out.push(...statementsFor(m));
      }
      let outgoing = m.outgoing;
      for (let e of outgoing) {
        if (e.dummy && e.guard) {
          out.push(types.ifStatement(
            e.guard,
            types.blockStatement([types.throwStatement(e.expr || types.nullLiteral())])));
        }
      }
      let rest = outgoing.filter((e) => !e.dummy);
      let thrower = rest.find((e) => e.kind === LOCAL_THROWS);
      if (thrower) {
        out.push(...branchCode(thrower));
        return out;
      }
      if (m.tag === 'switch') {
        // Group edges that go to the same place: `case a: case b: body`.
        let groups = [];
        let byTarget = new Map();
        for (let e of rest) {
          let key = e.target;
          let group = byTarget.get(key);
          if (!group) {
            group = { tests: [], edge: e, hasDefault: false };
            byTarget.set(key, group);
            groups.push(group);
          }
          if (e.kind === CASE) { group.tests.push(e.expr) } else { group.hasDefault = true }
        }
        // `default` last.
        groups.sort((a, b) => a.hasDefault - b.hasDefault);
        let cases = [];
        nesting++;
        for (let group of groups) {
          let labels = [...group.tests, ...(group.hasDefault ? [null] : [])];
          labels.forEach((test, i) => {
            cases.push(types.switchCase(
              test, i === labels.length - 1 ? branchCode(group.edge) : []));
          });
        }
        nesting--;
        out.push(types.switchStatement(m.discriminant, cases));
        return out;
      }
      if (m.tag === 'finally-end') {
        out.push(...endBreak());
        return out;
      }
      if (rest.length === 0) {
        if (!(types.isReturnStatement(m.stmt) || types.isThrowStatement(m.stmt))) {
          out.push(...endBreak());
        }
        return out;
      }
      if (rest.length === 1 && !rest[0].expr) {
        out.push(...branchCode(rest[0]));
        return out;
      }
      // if / else if / else chain
      let conditional = rest.filter((e) => e.expr);
      let unconditional = rest.find((e) => !e.expr);
      if (!unconditional) { throw new Error('Branch with no default edge'); }
      nesting++;
      let tail = types.blockStatement(branchCode(unconditional));
      for (let i = conditional.length; --i >= 0;) {
        let e = conditional[i];
        tail = types.ifStatement(e.expr, types.blockStatement(branchCode(e)), tail);
      }
      nesting--;
      out.push(tail);
      return out;
    }

    function unitCode(u) {
      if (u.kind === 'node') { return nodeCode(u.rep) }
      if (u.kind === 'block') {
        return [types.blockStatement(emitFrame(u.region, ctx))];
      }
      // try / catch / finally group
      let g = rt.get(u.region).group;
      let members = rt.groupMembers(g);
      let tryBlock = types.blockStatement(emitFrame(members[CfgRegionKind.TRY], ctx));
      let handler = null;
      if (members[CfgRegionKind.CATCH] !== undefined) {
        let cr = members[CfgRegionKind.CATCH];
        handler = types.catchClause(
          rt.get(cr).param,
          types.blockStatement(emitFrame(cr, ctx)));
      }
      let finalizer = null;
      let tail = [];
      if (members[CfgRegionKind.FINALLY] !== undefined) {
        let fr = members[CfgRegionKind.FINALLY];
        finalizer = types.blockStatement(emitFrame(fr, ctx));
        let finTail = reachableList.find(
          (n) => n.region === fr && n.tag === 'finally-end');
        if (finTail) {
          for (let e of finTail.outgoing) { tail.push(...branchCode(e)) }
        }
      }
      return [types.tryStatement(tryBlock, handler, finalizer), ...tail];
    }

    let body = doTree(entry);
    if (endUsed) {
      body = [types.labeledStatement(
        types.identifier(endLabel), types.blockStatement(body))];
    }
    let decls = [];
    if (hoistNames.length) {
      decls.push(types.variableDeclaration(
        'let',
        [...new Set(hoistNames)].map((n) => types.variableDeclarator(types.identifier(n)))));
    }
    return [...decls, ...prelude, ...body];
  }

  let statements = emitFrame(0, null);
  // Twice: removing tail breaks can leave empty `else` blocks and unused labels.
  statements = simplifyList(simplifyList(statements));
  return types.blockStatement([...cfg.preamble, ...statements]);
}
