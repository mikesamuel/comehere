/**
 * @fileoverview
 *
 * A control flow graph representation that can be extracted from and used to
 * regenerate, Babel ASTs.
 */

import { parse } from '@babel/parser';
import { traverse, generate } from './babel-bits-and-bobs.mjs';
import * as types from '@babel/types';
import { NameMaker, namesUsedIn } from './name-maker.mjs';
import { AssignedNames, declareAssignedNames } from './assigned-names.mjs';
import { isDeclared } from './ast-declared.mjs';

/**
 * A Cfg (control-flow-graph) is meant to make it easy to find paths to
 * specific instruction blocks.
 *
 * To that end, it normalizes exits from the FunctionBody/ModuleBody that
 * the Cfg represents: `return`s and `throw`s.
 *
 * Note that the two function bodies below are equivalent:
 *
 *     // Returns/throws from multiple locations
 *     if (isBad(x)) { throw new Error(x); }
 *     if (isBaddish(y)) { throw new Error(y); }
 *     if (x === y) { return OK }
 *     return null;
 *
 *
 *     // Returns from at most one location, throws from at most one.
 *     let thrown, returned;
 *     abrupt: {
 *       normal: {
 *         if (isBad(x)) { thrown = new Error(x); break abrupt; }
 *         if (isBaddish(y)) { thrown = new Error(y); break abrupt; }
 *         if (x === y) { returned = OK; break normal; }
 *         returned = null; break normal;
 *       }
 *       return returned;
 *     }
 *     throw thrown;
 *
 * The second snippet is semantically equivalent, but it uses `break`s to
 * the end of a labeled block to allow for normal and abrupt exits with
 * results.
 *
 * That allows for joining all the normal exits and all the abrupt exits
 * together as below:
 *
 *     START -+- (isBad(x)) ----> (thrown = new Error(x)) --+----> {throw thrown} --> ABRUPT_EXIT
 *            |                                             |
 *            +- (isBaddish) ---> (thrown = new Error(y)) --/
 *            |
 *            +- (x === y) -----> (returned = OK) -----+------> {return returned} --> NORMAL_EXIT
 *            |                                        |
 *            +-----------------> (returned = null) ---/
 *
 * So each Cfg has a start and two optional exit nodes allowing forward and reverse
 * graph traversals.
 *
 * --------------------------------------------------------------------------
 *
 * Each Cfg also has a table of regions.
 *
 * A region is meant to allow preserving structures that are hard to analyze.
 * `try`/`catch`/`finally` structures are tricky.  Instructions within the `try`
 * portion need to remain there so that any exceptions raised by them cause an
 * implicit transition to the `catch` or `finally` if there is no catch.
 * `finally` are odd because transitions out of the `try` and `catch` implicitly
 * go there before bouncing on to their eventual destination if the `finally` exits
 * normally.
 *
 *     try {
 *       instruction1();
 *       if (instruction2()) {
 *         return x; // Goes to finally before exiting function body.
 *       }
 *       if (instruction3()) {
 *         break outer; // Goes to finally before jumping to wherever outer specifies
 *       }
 *     } finally {
 *       instruction4(); // Could throw obviating any eventual destination.
 *     }
 *
 * Cfg edges can specify that they go to a destination "by way of" a finally block
 * specified as a region.
 *
 * A try and its catch and finally regions are grouped together in the region table.
 *
 * CfgNodes are tagged with a regionIndex so a CfgEdge whose source's and target's
 * region indices are different is one of:
 *
 * - a transition into a `try` clause when the target region is contained
 *   (possibly transitively) by the source region.
 * - a transition out of a `try` into the `catch` via a LOCAL_THROWS edge,
 * - a transition out of the `try`/`catch`/`finally` "by way of" the finally block
 * - a transition out where there is no finally block.
 */
export class Cfg {
  constructor({ start, normalExit, abruptExit, regionTable }) {
    if (!(start instanceof CfgNode && start.incoming.length === 0)) {
      throw new Error(start);
    }
    if (normalExit !== null &&
        !(normalExit instanceof CfgNode && normalExit.outgoing.length === 0)) {
      throw new Error(normalExit);
    }
    if (abruptExit !== null &&
        !(abruptExit instanceof CfgNode && abruptExit.outgoing.length === 0)) {
      throw new Error(abruptExit);
    }
    if (!(regionTable instanceof CfgRegionTable)) {
      throw new Error(regionTable);
    }

    this.start = start;
    this.normalExit = normalExit;
    this.abruptExit = abruptExit;
    this.regionTable = regionTable;
  }
}

/**
 * A CfgNode optionally has a babel
 * AST specifying a non-control-flow statement or expression statement.
 *
 * It also has two CfgEdge arrays: incoming and outgoing.
 * Each incoming edge must have `this` CfgNode as its `target`, and each outgoing edge
 * must have `this` CfgNode as its `.source`.
 */
export class CfgNode {
  /**
   * @param stmt A Babel AST for a non-control-flow statement or null.
   * @param {number} regionIndex an index into the owning Cfg's regionTable.
   */
  constructor(stmt, regionIndex) {
    this.stmt = stmt;
    this.region = regionIndex;
    // The graph is built by adding to these arrays post-construction.
    this.incoming = [];
    this.outgoing = [];
  }
}

/** An enum of values for CfgEdge.kind */
export const CfgEdgeKind = {
  /**
   * An edge that may not have an AST, but if it does, its a branch condition:
   * the edge is only followed when the result of evaluating the AST is truthy.
   */
  NORMAL: 1,
  /**
   * These should only be outgoing edges from a CfgNode with an AST which specifies
   * the value to match.  They must have their own AST which specifies the expression
   * to match against.
   *
   * Consider `switch (x) { case 1: log("One"); break; default: log("Else"); }`
   *
   * That corresponds to nodes and edges like this:
   *
   *     +-----+                   +---------------+
   *     | (x) | -+-- CASE:(1) --> | {log("One")}  | --NORMAL--+--> ...
   *     +-----+  |                +---------------+           |
   *              |                                            |
   *              |                +---------------+           |
   *              +-- NORMAL ----> | {log("Else")} | ----------/
   *                               +---------------+
   *
   * A `switch` with zero `case`s is structurally and functionally equivalent
   * to evaluating the expression to match and then proceeding to the `default`
   * statements, treating them as a no-op if there is no explicit `default`.
   */
  CASE: 2,
  /**
   * An edge whose AST specifies what to throw and whose target is the entry point
   * into a `catch` region in the same function/module body.
   */
  LOCAL_THROWS: 3,
  /**
   * An edge from the end of a loop (after any increment clause) back to its beginning
   * (before its condition check).
   *
   * It's often convenient to avoid follow LOOP_BACK edges as the other edges form a DAG.
   * A node that has a loop back edge in its incoming list is the entry point to a loop.
   *
   * Since LOOP_BACK is the only
   */
  LOOP_BACK: -1,
};

/**
 * An edge connecting two CfgNodes in a larger Cfg.
 */
export class CfgEdge {
  constructor(
    {
      kind, // One of the members of CfgEdgeKind
      source,
      target,
      /**
       * Null or a region index for a `finally` region this needs to stop over at on its
       * way to its target
       */
      byWayOf = null,
    }
  ) {
    if (typeof kind !== 'number') { throw new Error(kind); }
    if (!(source instanceof CfgNode)) { throw new Error(source); }
    if (!(target instanceof CfgNode)) { throw new Error(target); }
    if (byWayOf !== null && typeof byWayOf !== 'number') { throw new Error(byWayOf); }
    this.kind = kind;
    this.source = source;
    this.target = target;
    this.byWayOf = byWayOf;
  }
}
