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
  seekingVarName;
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

  constructor(nameMaker, seekingVarName) {
    this.nameMaker = nameMaker;
    this.seekingVarName = seekingVarName;
  }

  #defineOnDemand(propertyName) {
    let name = this[propertyName];
    if (!name) {
      name = this[propertyName] =
        this.nameMaker.unusedName(propertyName);
    }
    return name;
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
