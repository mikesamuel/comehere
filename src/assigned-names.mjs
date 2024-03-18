/**
 * @fileoverview
 * COMEHERE support needs some functions.
 * We could import them from a well-known module, but that
 * makes it harder to show self-contained code in a demo
 * window.
 *
 * This file defines a pool that assigns names as needed
 * and a function that adds definitions for those names
 * to the top of the transformed JS.
 */

import { traverse } from './babel-bits-and-bobs.mjs';
import * as types from '@babel/types';

/**
 * Pools names used for supporting functions.
 */
export class AssignedNames {
  nameMaker;
  /** Identifies the COMEHERE block that we are driving control into. */
  seekingVarName;
  /**
   * A bit-set of which lexical function bodies we are in the process of calling.
   * This is used to allow a function to recurse before its COMEHERE block without
   * hijacking the behaviour of the wrong invocation.
   *
   * For example, in the below, we'll insert a call like `fibonacci(10)`,
   * but the first time control reaches the COMEHERE block, `n = 2` because of
   * the recursive calls.
   *
   *     function fibonacci(n) {
   *       if (n <= 1) { return 1; }
   *       let fibLessTwo = fibonacci(n - 2);
   *       let fibLessOne = fibonacci(n - 1);
   *       COMEHERE: with (n = 10) {
   *         ...
   *       }
   *       return fibLessTwo + fibLessOne;
   *     }
   *
   * If we naively converted that to the below, then the control-driving
   * instructions would affect every call before the one we want which, in this
   * case, would drive control away from the base case, `return 1` leading to
   * a stack overflow before the COMEHERE executed.
   *
   *     function fibonacci(n) {
   *       // NEEDS TO STORE ACTIVE BIT LOCALLY AND UNSET ACTIVE BIT BEFORE ANY REENTRANT CALL
   *       if (n <= 1
   *           && seeking_0 !== 1 // NEEDS ACTIVE CHECK
   *       ) { return 1; }
   *       let fibLessTwo = fibonacci(n - 2);
   *       let fibLessOne = fibonacci(n - 1);
   *       if (seeling_0 === 1    // NEEDS ACTIVE CHECK
   *       ) { ... }
   *       return fibLessTwo + fibLessOne;
   *     }
   *     if (seeking_0 === 1) {
   *       // SET ACTIVE BIT
   *       fibonacci(10);
   *     }
   *
   * We optimistically assume that generators do not proxy functions in ways that
   * re-enter them with different arguments before the first proxied call.
   * This could be fixed by splitting each function in two: one that is presented
   * to the outside world with the original signature and which delegates to the
   * second which takes an extra argument to identify it as active.
   * Inserted calls would have direct access to the second and call it in active
   * mode.
   */
  activeFns;
  /**
   * A generator function that iterates its first argument,
   * and if that iterates nothing and the second argument is true, iterates `null`.
   */
  maybeNotEmptyIterator;
  /**
   * A generator function like maybeNotEmptyIterator but that iterates keys as
   * `for (... in ...)`.
   */
  maybeNotEmptyKeyIterator;
  /**
   * `or(x, () => y, seeking)` is Like `x || y()` but guarantees that `y` is
   * evaluated when `seeking` is true indicating a COMEHERE goal there.
   */
  or;
  /**
   * `and(x, () => y, seeking)` is Like `x && y()` but guarantees that `y` is
   * evaluated when `seeking` is true indicating a COMEHERE goal there.
   */
  and;

  constructor(nameMaker) {
    this.nameMaker = nameMaker;
    this.seekingVarName = nameMaker.unusedName('seeking')
  }

  #defineOnDemand(propertyName, nameHint = propertyName) {
    let name = this[propertyName];
    if (!name) {
      name = this[propertyName] = this.nameMaker.unusedName(nameHint);
    }
    return name;
  }

  requireActiveFns() {
    return this.#defineOnDemand('activeFns');
  }

  requireMaybeNotEmptyIterator() {
    return this.#defineOnDemand('maybeNotEmptyIterator');
  }

  requireMaybeNotEmptyKeyIterator() {
    return this.#defineOnDemand('maybeNotEmptyKeyIterator');
  }

  requireOr() {
    return this.#defineOnDemand('or');
  }

  requireAnd() {
    return this.#defineOnDemand('and');
  }
}


/**
 * Put at the top code like the below:
 *
 *     let seeking = globalThis.debugHooks?.getWhichSeeking(import.meta) || 0;
 *
 * That allows host code to initialize the seeking variable based on
 * an environment variable, or using `prompt` in a browser.
 */
export function declareAssignedNames(ast, assignedNames) {
  let declarations = [];

  let {
    seekingVarName,
    activeFns,
    maybeNotEmptyIterator,
    maybeNotEmptyKeyIterator,
    or,
    and,
  } = assignedNames;

  declarations.push(
    types.variableDeclaration(
      'let',
      [types.variableDeclarator(
        types.identifier(seekingVarName),
        types.logicalExpression(
          '||',
          types.callExpression(
            types.memberExpression(
              types.memberExpression(
                types.identifier("globalThis"),
                types.identifier("debugHooks"),
              ),
              types.identifier("getWhichSeeking"),
              /* computed */ false,
              /* optional */ true,
            ),
            [
              types.metaProperty(
                types.identifier("import"),
                types.identifier("meta"),
              )
            ],
            /* optional */ true,
          ),
          types.numericLiteral(0)
        )
      )]
    )
  );

  if (activeFns) {
    declarations.push(
      types.variableDeclaration(
        'let',
        [types.variableDeclarator(
          types.identifier(activeFns),
          types.bigIntLiteral('0'),
        )]
      )
    );
  }

  if (maybeNotEmptyIterator) {
    declarations.push(
      types.functionDeclaration(
        types.identifier(maybeNotEmptyIterator),
        [
          types.identifier('items'),
          types.identifier('seeking'),
        ],
        types.blockStatement([
          // for (let e of items) {
          //   yield e;
          //   seeking = false;
          // }
          // if (seeking) {
          //   yield {};
          // }
          types.forOfStatement(
            types.variableDeclaration(
              'let',
              [
                types.variableDeclarator(types.identifier('e')),
              ],
            ),
            types.identifier('items'),
            types.blockStatement([
              types.expressionStatement(
                types.yieldExpression(types.identifier('e'))
              ),
              types.expressionStatement(
                types.assignmentExpression(
                  '=',
                  types.identifier('seeking'),
                  types.booleanLiteral(false),
                )
              ),
            ])
          ),
          types.ifStatement(
            types.identifier('seeking'),
            types.blockStatement([
              types.expressionStatement(
                types.yieldExpression(
                  types.objectExpression([])
                )
              )
            ])
          )
        ]),
        /* generator */ true,
      )
    )
  }

  if (maybeNotEmptyKeyIterator) {
    declarations.push(
      types.functionDeclaration(
        types.identifier(maybeNotEmptyKeyIterator),
        [
          types.identifier('obj'),
          types.identifier('seeking'),
        ],
        types.blockStatement([
          // for (let k in obj) {
          //   yield k;
          //   seeking = false;
          // }
          // if (seeking) {
          //   yield '';
          // }
          types.forInStatement(
            types.variableDeclaration(
              'let',
              [
                types.variableDeclarator(types.identifier('k')),
              ],
            ),
            types.identifier('obj'),
            types.blockStatement([
              types.expressionStatement(
                types.yieldExpression(types.identifier('k'))
              ),
              types.expressionStatement(
                types.assignmentExpression(
                  '=',
                  types.identifier('seeking'),
                  types.booleanLiteral(false),
                )
              ),
            ])
          ),
          types.ifStatement(
            types.identifier('seeking'),
            types.blockStatement([
              types.expressionStatement(
                types.yieldExpression(
                  types.stringLiteral('')
                )
              )
            ])
          )
        ]),
        /* generator */ true,
      )
    )
  }

  for (let [name, operator] of [[or, '||'], [and, '&&']]) {
    if (!name) { continue }
    declarations.push(
      types.functionDeclaration(
        types.identifier(name),
        [
          types.identifier('x'),
          types.identifier('y'),
          types.identifier('seeking'),
        ],
        types.blockStatement([
          types.ifStatement(
            types.identifier('seeking'),
            types.blockStatement([
              types.variableDeclaration(
                'const',
                [
                  types.variableDeclarator(
                    types.identifier('yr'),
                    types.callExpression(types.identifier('y'), [])
                  ),
                ]
              ),
              types.returnStatement(
                types.logicalExpression(
                  operator,
                  types.identifier('x'),
                  types.identifier('yr'),
                )
              ),
            ]),
            types.blockStatement([
              types.returnStatement(
                types.logicalExpression(
                  operator,
                  types.identifier('x'),
                  types.callExpression(types.identifier('y'), [])
                )
              ),
            ]),
          )
        ]),
      )
    );
  }

  traverse(
    ast,
    {
      Program(path) {
        let startOfBody = path.get('body')[0];
        if (startOfBody) {
          startOfBody.insertBefore(declarations);
        }
      }
    }
  );
}
