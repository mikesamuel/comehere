/**
 * @fileoverview
 * Given a Cfg and a set of target nodes, finds paths from the start of the
 * Cfg to each target, then adjusts branch conditions along those paths so
 * that control reaches the target when a "seeking" predicate holds.
 */

import * as types from '@babel/types';
import {
  CfgNode, CfgEdge, CfgEdgeKind, CfgRegionKind, reachableNodes,
} from './cfg.mjs';

const { NORMAL, CASE, LOCAL_THROWS, LOOP_BACK } = CfgEdgeKind;

/**
 * @typedef {Object} SeekTarget
 * @property {() => types.Expression} positive builds a fresh expression that
 *     is truthy when we are seeking this target.
 * @property {() => types.Expression} negative builds a fresh expression that
 *     is truthy when we are not seeking this target.
 * @property {(param: any) => types.Expression|null} [throwableFor] given the
 *     parameter of a `catch` clause, returns an expression to throw to get
 *     there, or null for a default.
 */

/**
 * Searches for paths from `cfg.start` to each target.
 *
 * Paths that throw fewer exceptions are preferred.
 *
 * @param {Cfg} cfg
 * @param {Iterable<CfgNode>} targetNodes
 * @return {Map<CfgNode, Array>} a path (array of edges) for each reachable
 *     target.  Some edges may be pseudo-edges (plain objects with
 *     `pseudo: true`) that enter a `finally` region.
 */
export function findPaths(cfg, targetNodes) {
  const targets = new Set(targetNodes);
  const rt = cfg.regionTable;
  const found = new Map();
  if (targets.has(cfg.start)) { found.set(cfg.start, []) }
  if (found.size === targets.size) { return found }

  // Regions of finally blocks that contain a target, so we know when to add
  // pseudo-edges from the start of a try/catch into the finally.
  const finallyHasTarget = (finRegion) => {
    for (let t of targets) {
      if (rt.contains(finRegion, t.region)) { return true }
    }
    return false;
  };

  const normalQueue = [];
  const throwQueue = [];
  const visited = new Set([cfg.start]);

  const enqueue = (edge, path) => {
    (edge.kind === LOCAL_THROWS ? throwQueue : normalQueue).push({ edge, path });
  };
  const enqueueOutgoing = (node, path) => {
    for (let edge of node.outgoing) {
      if (edge.kind !== LOOP_BACK) { enqueue(edge, path) }
    }
    let region = rt.get(node.region);
    if (
      region.entry === node &&
        (region.kind === CfgRegionKind.TRY || region.kind === CfgRegionKind.CATCH)
    ) {
      let members = rt.groupMembers(region.group);
      let finRegion = members[CfgRegionKind.FINALLY];
      if (finRegion !== undefined && finallyHasTarget(finRegion)) {
        enqueue(
          {
            kind: NORMAL,
            source: node,
            target: rt.get(finRegion).entry,
            expr: null,
            pseudo: true,
          },
          path,
        );
      }
    }
  };

  enqueueOutgoing(cfg.start, []);
  for (;;) {
    let item = normalQueue.length ? normalQueue.shift() : throwQueue.shift();
    if (!item) { break }
    let { edge, path } = item;
    let { target } = edge;
    if (visited.has(target)) { continue }
    visited.add(target);
    let newPath = [...path, edge];
    if (targets.has(target) && !found.has(target)) {
      found.set(target, newPath);
      if (found.size === targets.size) { break }
    }
    enqueueOutgoing(target, newPath);
  }
  return found;
}

/** The set of nodes from which `target` is reachable without loop-back edges. */
function nodesThatCanReach(target) {
  const reaching = new Set([target]);
  const stack = [target];
  while (stack.length) {
    let n = stack.pop();
    for (let e of n.incoming) {
      if (e.kind === LOOP_BACK || reaching.has(e.source)) { continue }
      reaching.add(e.source);
      stack.push(e.source);
    }
  }
  return reaching;
}

/** Inserts a new node containing `stmt` between a node and its incoming edges. */
function insertBefore(cfg, node, stmt) {
  let fresh = new CfgNode(stmt, node.region);
  for (let e of node.incoming) {
    e.target = fresh;
    fresh.incoming.push(e);
  }
  node.incoming = [];
  new CfgEdge({ kind: NORMAL, source: fresh, target: node });
  let region = cfg.regionTable.get(node.region);
  if (region.entry === node) { region.entry = fresh }
  if (cfg.start === node) { cfg.start = fresh }
  return fresh;
}

function and(a, b) { return types.logicalExpression('&&', a, b) }
function or(a, b) { return types.logicalExpression('||', a, b) }

/**
 * Modifies the Cfg so that control reaches the targets when seeking.
 *
 * @param {Cfg} cfg
 * @param {Map<CfgNode, SeekTarget>} targets
 * @param {NameMaker} nameMaker
 * @return {{ modified: boolean, unreachable: CfgNode[] }}
 */
export function seekTargets(cfg, targets, nameMaker) {
  const paths = findPaths(cfg, targets.keys());
  const unreachable = [...targets.keys()].filter((t) => !paths.has(t));

  // Decide what needs adjusting before changing any structure.
  const jobs = [];
  for (let [target, path] of paths) {
    let canReach = nodesThatCanReach(target);
    for (let edge of path) {
      if (edge.pseudo) { continue }
      let siblings = edge.source.outgoing.filter(
        (e) => e !== edge && !e.dummy && e.kind !== LOCAL_THROWS);
      let needsAdjustment = edge.dummy ||
          siblings.some((e) => !canReach.has(e.target));
      if (needsAdjustment) { jobs.push({ edge, seek: targets.get(target) }) }
    }
  }

  let modified = false;
  for (let { edge, seek } of jobs) {
    let source = edge.source;
    if (edge.kind === LOCAL_THROWS) {
      if (!edge.dummy) { continue }
      // `if (seeking) throw <value>;` at the start of the try block.
      let param = cfg.regionTable.get(edge.target.region).param;
      let thrown = seek.throwableFor ? seek.throwableFor(param) : null;
      let guard = seek.positive();
      edge.guard = edge.guard ? or(edge.guard, guard) : guard;
      edge.expr = edge.expr || thrown || types.newExpression(
        types.memberExpression(
          types.identifier('globalThis'), types.identifier('Error')),
        []);
      modified = true;
      continue;
    }

    if (source.tag === 'switch') {
      // Use a sentinel that matches no case, and add a case for it if the
      // path goes through a `case` rather than the default.
      let tokenName = nameMaker.unusedName('caseToken');
      let exprName = nameMaker.unusedName('caseExpr');
      let oldDiscriminant = source.discriminant;
      insertBefore(cfg, source, types.variableDeclaration('const', [
        types.variableDeclarator(types.identifier(tokenName), types.objectExpression([])),
        types.variableDeclarator(types.identifier(exprName), oldDiscriminant),
      ]));
      source.discriminant = types.conditionalExpression(
        seek.positive(), types.identifier(tokenName), types.identifier(exprName));
      if (edge.kind === CASE) {
        let sentinel = new CfgEdge({
          kind: CASE,
          source,
          target: edge.target,
          expr: types.identifier(tokenName),
        });
        // Move before the edge it shadows.
        source.outgoing.pop();
        source.outgoing.splice(source.outgoing.indexOf(edge), 0, sentinel);
      }
      modified = true;
      continue;
    }

    let index = source.outgoing.indexOf(edge);
    for (let i = 0; i < index; ++i) {
      let earlier = source.outgoing[i];
      if (earlier.expr && !earlier.dummy && earlier.kind !== LOCAL_THROWS) {
        earlier.expr = and(earlier.expr, seek.negative());
      }
    }
    if (edge.expr) { edge.expr = or(edge.expr, seek.positive()) }
    modified = true;
  }

  return { modified, unreachable };
}

/**
 * Finds the CfgNode that evaluates `astNode`: the node whose statement
 * contains it, or the branching node whose edge expressions contain it, or
 * the node built from it (like an `if` statement's branching node).
 *
 * @return {CfgNode|null}
 */
export function findNodeFor(cfg, astNode) {
  let owner = null;
  const scan = (root, node) => {
    if (!root || owner) { return }
    if (root === astNode) { owner = node; return }
    for (let key of types.VISITOR_KEYS[root.type] || []) {
      let child = root[key];
      if (Array.isArray(child)) { child.forEach((c) => scan(c, node)) } else { scan(child, node) }
    }
  };
  for (let n of reachableNodes(cfg)) {
    if (n.source === astNode) { return n }
    scan(n.stmt, n);
    scan(n.discriminant, n);
    for (let e of n.outgoing) { scan(e.expr, n) }
    if (owner) { break }
  }
  return owner;
}
