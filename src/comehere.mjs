/**
 * @fileoverview
 *
 * A JS -> JS conversion that detects additional syntax like the below and
 * rewrites control flow to allow implementing COMEHERE semantics.
 *
 *   function f(a, b) {
 *     let result = a + b;
 *     COMEHERE with (a = 1, b = 2) {
 *       console.log
 *     }
 *     return result;
 *   }
 */

import {parse} from '@babel/parser';
import { traverse, generate } from './babel-bits-and-bobs.mjs';
import * as types from '@babel/types';
import { NameMaker, namesUsedIn } from './name-maker.mjs';
import { AssignedNames, declareAssignedNames } from './assigned-names.mjs';
import { isDeclared } from './ast-declared.mjs';

/**
 * Ensure that control-flow statements use blocks around statements
 * so that we have a home in case we need to pull sub-expressions into
 * temporaries.
 */
export function blockify(ast) {
  function maybeBlockifyPath(path) {
    if (path?.node && !path.isBlockStatement()) {
      path.replaceWith(
        types.blockStatement([path.node])
      )
    }
  }
  const visitor = {
    IfStatement: {
      // This visitor does things on exit so as to avoid
      // complications from making mutating changes to children.
      exit(path) {
        maybeBlockifyPath(path.get('consequent'));
        let alternate = path.get('alternate');
        if (alternate?.node && !alternate.isIfStatement()) {
          maybeBlockifyPath(alternate);
        }
      }
    },
    Loop: {
      exit(path) {
        maybeBlockifyPath(path.get('body'));
      }
    },
    ArrowFunctionExpression: {
      exit(path) {
        let body = path.get('body');
        if (body.isExpression()) {
          body.replaceWith(
            types.blockStatement([
              types.returnStatement(body.node),
            ])
          );
        }
      }
    },
    WithStatement: {
      exit(path) {
        maybeBlockifyPath(path.get('body'));
      }
    },
  };
  traverse(ast, visitor);
}

function enclosingFn(contextPath) {
  let path = contextPath;
  while (path) {
    if (path.isFunction()) {
      return path;
    }
    path = path.parentPath;
  }
  return null;
}

/**
 * Install a prefix like the below into the enclosing function if there
 * is one that needs one:
 *
 *     let isActiveCall_3 = (activeFn_0 >> 3n) & 1n;
 *     activeFn_3 &= ~(1n << 3n);
 *
 * Returns a record like:
 *
 * {
 *   fnPath: {Babel path to enclosing function},
 *   isActiveCall: 'isActiveCall_3',
 *   bitIndex: 3n,
 * }
 *
 * If there is no containing function body,
 * returns a similar record with all null values.
 */
function ensureActiveFnBodyPrefixPresent(contextPath, assignedNames) {
  let existing = enclosingActiveFnContext(contextPath, assignedNames);
  if (existing.isActiveCall) { return existing }
  let {fnPath} = existing;
  if (!fnPath) {
    return { fnPath, isActiveCall: null, bitIndex: null };
  }
  let activeFn = assignedNames.requireActiveFns();
  let [isActiveCall, suffixNum] = assignedNames.nameMaker.unusedNameAndSuffixNum('isActiveCall');
  let bitIndex = BigInt(suffixNum);
  fnPath.node.body.body.unshift(
    types.variableDeclaration(
      'const',
      [
        types.variableDeclarator(
          types.identifier(isActiveCall),
          types.binaryExpression(
            '&',
            types.binaryExpression(
              '>>',
              types.identifier(activeFn),
              types.bigIntLiteral('' + bitIndex),
            ),
            types.bigIntLiteral('1'),
          ),
        ),
      ]
    ),
    types.expressionStatement(
      types.assignmentExpression(
        '&=',
        types.identifier(activeFn),
        types.unaryExpression(
          '~',
          types.binaryExpression(
            '<<',
            types.bigIntLiteral('1'),
            types.bigIntLiteral('' + bitIndex),
          ),
        ),
      ),
    ),
  );
  return {
    fnPath,
    isActiveCall,
    bitIndex,
  };
}

/**
 * Unpacks the prefix created by ensureActiveFnBodyPrefixPresent.
 */
function enclosingActiveFnContext(contextPath, assignedNames) {
  let isActiveCall = null, bitIndex = null;
  let fnPath = enclosingFn(contextPath);
  let { activeFns } = assignedNames;
  if (fnPath && activeFns) {
    let body0 = fnPath.node.body.body[0];
    if (
      types.isVariableDeclaration(body0) &&
        body0.kind === 'const' &&
        body0.declarations.length === 1
    ) {
      let { id, init } = body0.declarations[0];
      if (types.isIdentifier(id) && init) {
        if (types.isBinaryExpression(init) && init.operator === '&') {
          let { left, right } = init;
          if (types.isBigIntLiteral(right) && types.isBinaryExpression(left)) {
            if (left.operator === '>>') {
              let { left: leftLeft, right: leftRight } = left;
              if (types.isIdentifier(leftLeft) && leftLeft.name === activeFns &&
                  types.isBigIntLiteral(leftRight)) {
                isActiveCall = id.name;
                bitIndex = BigInt(leftRight.value);
              }
            }
          }
        }
      }
    }
  }
  return {
    fnPath,
    isActiveCall,
    bitIndex,
  };
}

/**
 * isActiveCall_0 && seeking_0 === 123
 */
function seekingCheck(
  assignedNames,
  seekingValue,
  contextPath,
  inverted = false
) {
  let { seekingVarName } = assignedNames;
  let { isActiveCall } = enclosingActiveFnContext(contextPath, assignedNames);

  let [comparisonOp, combiningOp] = inverted
      ? ['!==', '||']
      : ['===', '&&']
  let check = types.binaryExpression(
    comparisonOp,
    types.identifier(seekingVarName),
    types.numericLiteral(seekingValue),
  );
  if (isActiveCall) {
    let isActiveCallCheck = types.identifier(isActiveCall);
    if (inverted) {
      isActiveCallCheck = types.unaryExpression('!', isActiveCallCheck);
    }
    check = types.logicalExpression(
      combiningOp,
      isActiveCallCheck,
      check
    );
  }
  return check;
}

function isComehereBlock(node) {
  return types.isLabeledStatement(node) && node.label.name === 'COMEHERE' &&
    types.isWithStatement(node.body);
}

/**
 * It's convenient to be able to use a COMEHERE block that can log the
 * function result.
 *
 * This identifies such blocks, before they are desugared into simpler
 * constructs and makes sure that they run anyway.
 */
function pullComeHereBlocksAfterReturnIntoFinally(ast, assignedNames) {
  //    return x;
  //    COMEHERE:with (...) { ... }
  // ->
  //    let functionReturn_0;
  //    try {
  //      return (functionReturn_0 = x);
  //    } finally {
  //      COMEHERE:with (...) { ... }
  //    }

  // We look for return statements, then look forward for
  // COMEHERE blocks and adjust from there.
  let visitor = {
    ReturnStatement: {
      exit(returnPath) {
        let containing = returnPath.parentPath;
        if (!containing.isBlockStatement()) { return }
        let statements = containing.node.body;
        let returnIndex = statements.indexOf(returnPath.node);
        let candidateIndex = returnIndex + 1;
        while (candidateIndex < statements.length) {
          let candidate = statements[candidateIndex];
          if (!isComehereBlock(candidate)) { break }
          candidateIndex += 1;
        }
        let first = returnIndex + 1;
        let afterLast = candidateIndex;
        let nComeHereBlocks = afterLast - first;
        let comeHereBlocks = statements.slice(first, afterLast);
        if (nComeHereBlocks) {
          let functionReturnName = assignedNames.nameMaker
              .unusedName('functionReturn');

          // Rewrite Function.return
          for (let i = first; i < afterLast; ++i) {
            let comeHereBlockBodyPath = containing.get(`body.${i}`)
                .get('body').get('body');
            traverse(
              comeHereBlockBodyPath.node,
              {
                MemberExpression(path) {
                  let {object, computed, property} = path.node;
                  if (
                    !computed &&
                      types.isIdentifier(object) &&
                      object.name === 'Function' &&
                      types.isIdentifier(property) &&
                      property.name === 'return'
                  ) {
                    path.replaceWith(types.identifier(functionReturnName));
                  }
                }
              },
              comeHereBlockBodyPath.scope,
            )
          }

          let returned = returnPath.get('argument');
          let returnedExpression = returned.node;
          if (returnedExpression) {
            returned.replaceWith(types.identifier(functionReturnName));
          }
          statements.splice(
            returnIndex,
            afterLast,
            types.variableDeclaration(
              'let',
              [
                types.variableDeclarator(
                  types.identifier(functionReturnName),
                  returnedExpression,
                )
              ]
            ),
            ...comeHereBlocks,
            returnPath.node,
          );
        }
      }
    }
  }
  traverse(ast, visitor);
}

/**
 * Converts `COMEHERE: with (initializers) { ... }` to
 * `if (seeking_0 === 1) { seeking_0 = 0; ... }` and squirrels away
 * assignments in `initializers` so that we can emplace
 * them later.
 *
 * The `seeking_0 === 1` uses the pre-allocated
 * `seekingVarName` and controls how we load the module
 * to cause control to reach the *COMEHERE* block but
 * without changing the behaviour of reentrant uses.
 * The `1` there differs for each extracted block and
 * serves as an identifier.
 */
function extractComeHereBlocks(
  ast,
  assignedNames,
  console,
) {
  let { seekingVarName } = assignedNames;

  let extracted = [];

  let visitor = {
    // The kind of visitor who comes to your house
    // to rummage through your closets.

    WithStatement(path) {
      let parentPath = path.parentPath;
      if (isComehereBlock(parentPath.node)) {
        // Zero as a seekingValue means not seeking any COMEHERE.
        let seekingValue = extracted.length + 1;
        let initializersNode = path.get('object').node;
        let body = path.get('body'); // A block because of blockify above.
        ensureActiveFnBodyPrefixPresent(parentPath, assignedNames);
        // Turn the `with` into an `if`.
        parentPath.replaceWith(
          types.ifStatement(
            seekingCheck(assignedNames, seekingValue, path),
            body.node,
          )
        );
        // Turn off seeking now that we found it, so that reentrant uses
        // function correctly.
        let startOfBody = body.get('body')[0];
        let resetStatement = types.expressionStatement(
          types.assignmentExpression(
            '=',
            types.identifier(seekingVarName),
            types.numericLiteral(0)
          )
        );
        if (startOfBody) {
          startOfBody.insertBefore(resetStatement);
        } else {
          body.node.body.push(resetStatement);
        }

        // Deconstruct initializersNode to [dotted-path, right-hand-side] pairs
        let initializers = [];
        let description = null;
        {
          let it = (types.isSequenceExpression(initializersNode))
              ? initializersNode.expressions
              : [initializersNode];

          if (types.isStringLiteral(it[0])) {
            description = it[0].value || null;
            it.splice(0, 1);
          }

          initializer_loop:
          for (let initializer of it) {
            // `COMEHERE: with (_) { ... }` has zero initializers.
            if (types.isIdentifier(initializer) && initializer.name === '_') { continue }
            // Warn on malformed initializers
            if (!(types.isAssignmentExpression(initializer) || initializer.operator != '=')) {
              let { code } = generate(initializer);
              console.error(`COMEHERE: expected assignment but got \`${code}\`.`);
              continue initializer_loop;
            }
            let { left, right } = initializer;
            let parts = [];
            while (true) {
              if (types.isIdentifier(left)) {
                parts.push(left.name);
                break;
              }
              if (
                types.isMemberExpression(left) &&
                  !left.computed &&
                  types.isIdentifier(left.property)
              ) {
                parts.push(left.property.name);
                left = left.object;
              } else {
                let { code } = generate(initializer);
                console.error(`COMEHERE: expected assignment to dotted path, but got \`${code}\`.`);
                continue initializer_loop;
              }
            }
            parts.reverse();
            initializers.push([parts.join('.'), right]);
          }
        }

        extracted.push(new ComeHereBlock(description, seekingValue, parentPath, initializers));
      }
    }
  };

  traverse(ast, visitor);

  return extracted;
}

class ComeHereBlock {
  #description;
  #seekingValue;
  #path;
  #initializers;

  /**
   * A textual description or null if unavailable.
   *
   * If the first item in the `with` block is a string, that's
   * used as the description.  This may be presented in a UI
   * to help the developer choose the block they want to run.
   *
   * `COMEHERE: with ("description", a = 1) { ... }`
   */
  get description() { return this.#description }

  /**
   * The value used in `seeking_0 === ...` branch conditions
   * to drive control towards COMEHERE
   */
  get seekingValue() { return this.#seekingValue }

  /**
   * A babel path that points to the COME_HERE block.
   */
  get path() { return this.#path }

  /**
   * Babel AST nodes corresponding to assignments in the
   * `with` portion of the original COMEHERE block.
   */
  get initializers() { return this.#initializers }

  constructor(description, seekingValue, path, initializers) {
    this.#description = description;
    this.#seekingValue = seekingValue;
    this.#path = path;
    this.#initializers = initializers;
  }
}

/**
 * Add instructions that depend on the seeking var to drive control to
 * each comeHereBlock.
 */
function driveControlToComeHereBlocks(
  comeHereBlocks,
  assignedNames,
  console
) {
  for (let comeHereBlock of comeHereBlocks) {
    driveControlToComeHereBlock(comeHereBlock, assignedNames, console);
  }
}

/**
 * Adjust branch conditions, control flow instructions, and function bodies so
 * that control is driven towards the COMEHERE block identified by `seeking_0`.
 */
function driveControlToComeHereBlock(
  comeHereBlock,
  assignedNames,
  console
) {
  let seekingVarName = assignedNames.seekingVarName;
  let seekingValue = comeHereBlock.seekingValue;
  let nameMaker = assignedNames.nameMaker;

  let initializers = comeHereBlock.initializers;

  // To drive control into a function, we need to synthesize a call.
  // To that end, we build argument lists by pulling expressions out
  // of the COMEHERE block's initializer list.
  // We need arguments for the call, and if the callable is a method,
  // we may need to construct a `this` value which requires building
  // an argument list for the class's constructor.
  // Find a dotted name among unused initializers and consume it.
  // Returns [undottedParamName, initializer] pair or null if not found.
  function lookupAndConsumeParam(prefix, paramName) {
    let wantedDottedName = [...prefix, paramName].join('.');
    let initializerIndex = initializers.findIndex(
      ([dottedName]) => dottedName === wantedDottedName
    );
    if (initializerIndex >= 0) {
      let [_, initializer] = initializers[initializerIndex];
      initializers.splice(initializerIndex, 1);
      return [paramName, initializer];
    }
    return null;
  }

  let seekingCheckForBlock = seekingCheck.bind(null, assignedNames, seekingValue);

  // Walk rootward from the path adding instructions.
  function adjust(goal) {
    let path = goal.parentPath;
    if (path.isIfStatement()) {
      //    if (c) { then } else { alt }
      // When the goal is within `then`:
      // -> if (c || seekingVar === seekingValue) { then } else { alt }
      // When the goal is within `alt`:
      // -> if (c && seekingVar !== seekingValue) { then } else { alt }
      let test = path.get('test');
      let thenClause = path.get('consequent');
      let elseClause = path.get('alternate');
      if (thenClause.node === goal.node) {
        test.replaceWith(
          types.logicalExpression('||', test.node, seekingCheckForBlock(path))
        )
      } else if (elseClause.node === goal.node) {
        test.replaceWith(
          types.logicalExpression('&&', test.node, seekingCheckForBlock(path, true))
        )
      }
    } else if (path.isSwitchStatement()) {
      //    switch (e) {
      //    case f(): ...;
      //    case g(): ...;
      //    case h(): ...;
      //    }
      //
      // When the goal is within statements following and closest to `case g():`
      //
      // -> const caseToken = {},
      //      caseExpr = e;
      //    switch (seekingVar === seekingValue ? caseToken : caseExpr) {
      //    case f(): ...;
      //    case g():
      //    case caseToken:
      //      ...;
      //    case h(): ...;
      //    }
      //
      // When the goal is within statements following and closest to `default:`
      // we can similarly add `case caseToken:` alongside the `default:`.
      if (goal.isSwitchCase()) {
        let discriminant = path.get('discriminant');
        let discriminantNode = discriminant.node;
        let caseTokenName = nameMaker.unusedName('caseToken');
        let caseExprName = nameMaker.unusedName('caseExpr');
        discriminant.replaceWith(
          types.conditionalExpression(
            seekingCheckForBlock(path),
            types.identifier(caseTokenName),
            types.identifier(caseExprName),
          )
        );
        path.insertBefore(
          types.variableDeclaration(
            'const',
            [
              types.variableDeclarator(
                types.identifier(caseTokenName),
                types.objectExpression([]),
              ),
              types.variableDeclarator(
                types.identifier(caseExprName),
                discriminantNode,
              )
            ],
          )
        );
        let goalConsequent = goal.node.consequent;
        goal.node.consequent = [];
        let newCase = types.switchCase(
          types.identifier(caseTokenName),
          goalConsequent
        );
        goal.insertAfter(newCase);
      }
    } else if (path.isLoop()) {
      // When the goal is within body:
      //
      //    while (c) { body }
      // -> while (c || seekingVar === seekingValue) { body }
      //
      //    for (;c;) { body }
      // -> for (; c || seekingVar === seekingValue) { body }
      //
      //    for (let el of it) { body }
      // -> for (let el of maybeNotEmptyIterator(it, seekingVar === seekingValue)) { body }
      //
      //    for (let el in it) { body }
      // -> for (let el of maybeNotEmptyKeyIterator(it, seekingVar === seekingValue)) { body }
      if (goal.node === path.node.body) {
        let test = path.get('test');
        if (path.isForStatement() || path.isWhileStatement()) {
          test.replaceWith(
            types.logicalExpression('||', test.node, seekingCheckForBlock(path))
          );
        } else if (path.isForOfStatement() || path.isForInStatement()) {
          let isForIn = path.isForInStatement();
          let right = path.get('right');

          let wrapperName = isForIn
              ? assignedNames.requireMaybeNotEmptyKeyIterator()
              : assignedNames.requireMaybeNotEmptyIterator();

          right.replaceWith(
            types.callExpression(
              types.identifier(wrapperName),
              [ right.node, seekingCheckForBlock(path) ]
            )
          );

          if (isForIn) {
            path.replaceWith(
              types.forOfStatement(
                path.node.left,
                path.node.right,
                path.node.body,
              )
            )
          }
        }
      }
    } else if (path.isTryStatement()) {
      // The goal could be in any of:
      //
      // - The `try` clause.  No changes necessary.
      // - The `finally` clause.  No changes necessary.
      // - The `catch` clause.
      //   Add the below to the beginning of the corresponding `try` clause.
      //
      //      try { ... }
      //   -> try { if (seekingVar === seekingValue) { throw null; } ... }
      let catchClause = path.get('handler');
      if (goal.node === catchClause.node) {
        let catchParam = catchClause.node.param;
        let catchParamName = catchParam && types.isIdentifier(catchParam)
            ? catchParam.name
            : null;
        // If the catch parameter name is 'e', then we fall through
        // several strategies to find the expression to throw:
        //    catch.e
        //    e
        // If neither of those work, we just `throw new globalThis.Error`.
        let throwableExpression = (
            catchParamName
            ? (lookupAndConsumeParam(['catch'], catchParamName)
               || lookupAndConsumeParam([], catchParamName))?.[1]
            : null
        ) || types.newExpression(
          types.memberExpression(
            types.identifier('globalThis'),
            types.identifier('Error')
          ),
          []
        );
        let conditionalThrow = types.ifStatement(
          seekingCheckForBlock(path),
          types.blockStatement([
            types.throwStatement(throwableExpression),
          ])
        );
        let tryBlock = path.get('block')
        let startOfTry = tryBlock.get('body')[0];
        if (startOfTry) {
          startOfTry.insertBefore(conditionalThrow)
        } else {
          tryBlock.node.body.push(conditionalThrow);
        }
      }
    } else if (path.isFunction()) {
      // When the goal is within the function body, do the following.
      //
      // Find the arguments based on the signature and generate an argument list.
      //
      // For a function with an argument list like
      //     (a,    b,     c)
      // If the function is a method named `f` in a class `C`, look for initializers
      // like the below.
      //     C.f.a, C.f.b, C.f.c
      // Consume them if present and mark the corresponding argument as satisfied.
      //
      // If the function has a name, `f`, then look for initializers for still
      // unsatisfied arguments like the below:
      //       f.a,   f.b,   f.c
      // Consume and mark as above.
      //
      // For any still unsatisfied arguments, look for initializers like
      //         a,     b,     c
      // Consume and mark as above.
      //
      //
      // When looking to generate an argument list for the constructor to a type C
      // to construct an instance of a class so we can drive control into one of
      // its methods, perform similar steps as above except look for initializers
      // that include the `this` keyword like
      //
      //         C.this.a, C.this.b, C.this.b
      //
      //
      // Then do one of the following:
      // - FunctionDeclaration
      //   Wrap in an immediately called lambda
      //       function name(args) { ... }
      //    -> function name(args) { ... };
      //       if (seekingVar === seekingValue) {
      //         name(generatedArgs);
      //       }
      // - ArrowFunctionExpression, FunctionExpression
      //       (args) => body
      //    -> ((f) => {
      //         if (seekingVar === seekingValue) { f(generatedArgs) };
      //         return f
      //       })((args) => body)
      // - ClassMethod, ClassPrivateMethod
      //   Figure out how to construct a value by matching name paths like
      //   `C.this.x` with constructor parameter names.
      //
      //   If the class is a ClassExpression instead of a ClassDeclaration
      //   wrap in an immediately called lambda.
      //
      //   If the method is private, add an accessor method.
      //
      //       class C { p(args) { ... } }
      //    -> class C { p(args) { ... } }
      //       if (seekingVar === seekingValue) {
      //         let c = new C(generatedConstructorArgs);
      //         c.p(args);
      //       }
      // - ObjectMethod ->
      //       ({ p() { ... } })
      //    -> ((o) => {
      //         if (seekingVar === seekingValue) { o.p(generatedArgs) }
      //       })({ p() { ... } })
      function paramNameOf(param) {
        if (types.isAssignmentPattern(param)) {
          param = param.left;
        }
        if (types.isIdentifier(param)) { return param.name; }
        return null;
      }
      let {node} = path;
      if (node.body === goal.node) {
        let { isActiveCall, bitIndex } = ensureActiveFnBodyPrefixPresent(path, assignedNames);

        let nameId = node.id;
        if (nameId == null && types.isIdentifier(node.key) && !node.computed) {
          // If we're in a named method, allow that name to be used to qualify
          // things, including the special name 'constructor'.
          nameId = node.key
        }
        let containingClass = path.parentPath.isClassBody() ? path.parentPath.parentPath : null;
        let containingClassName = containingClass?.node?.id?.name;
        let isObjectMethod = path.isObjectMethod()
        let thisArgument = null;
        // If we have a class name, C, because the function is a method,
        // and `C.this` is present, then we can avoid having to manufacture an
        // instance.
        thisArgument = lookupAndConsumeParam([containingClassName], 'this');

        // Build an argument list from a set of parameter names, and
        // prefixes in descending order of specificity.
        // This involves generating narrowly scoped declarators for the
        // parameter names so that earlier argument expressions can
        // depend on later ones.
        let declarators = [];
        function buildArgumentList(params, prefixes) {
          let argumentList = params.map(() => null);
          let nParams = params.length;
          for (let prefix of prefixes) {
            for (let paramIndex = 0; paramIndex < nParams; ++paramIndex) {
              if (argumentList[paramIndex] !== null) { continue }
              let param = params[paramIndex];
              let paramName = paramNameOf(param);
              if (!paramName) { continue }
              argumentList[paramIndex] = lookupAndConsumeParam(prefix, paramName);
            }
          }

          let unsupplied = [];
          for (let i = 0; i < nParams; ++i) {
            if (!argumentList[i] && !types.isAssignmentPattern(params[i])) {
              unsupplied.push(i);
            }
          }
          if (unsupplied.length) {
            let prefix = prefixes[0].length ? prefixes[0].join('.') + '.' : '';
            console.warn('COMEHERE: Missing arguments for function: ' + (
              unsupplied.map((i) => {
                let param = params[i];
                let name = paramNameOf(param);
                return `#${i}:\`${name ? prefix + name : generate(param).code}\``;
              })
            ) + '.');
          }

          // generate declarations for argument initializers,
          // and a positional argument list
          let positionalArgumentExpressions = [];
          for (let i = 0; i < argumentList.length; ++i) {
            let nameAndInitializer = argumentList[i];
            if (nameAndInitializer) {
              let [name, initializer] = nameAndInitializer;
              declarators.push(
                types.variableDeclarator(
                  types.identifier(name),
                  initializer,
                )
              );

              while (positionalArgumentExpressions.length < i) {
                positionalArgumentExpressions.push(
                  types.unaryExpression('void', types.numericLiteral(0))
                );
              }
              positionalArgumentExpressions.push(types.identifier(name));
            }
          }

          return positionalArgumentExpressions;
        }

        // Build prefixes for the main function call.
        let prefixes = [];
        if (containingClassName && nameId) {
          prefixes.push([containingClassName, nameId.name]);
        }
        if (nameId) {
          prefixes.push([nameId.name]);
        }
        prefixes.push([]);

        if (thisArgument === null && !path.isArrowFunctionExpression()) {
          for (let prefix of prefixes) {
            // f.this binds the this value for the function call.
            thisArgument = lookupAndConsumeParam(prefix, 'this');
            if (thisArgument) { break }
          }
        }

        // Construct a block like the below so that we can use
        // the parameter bare names.
        // This allows one initializer expression to depend on another
        // as long as they bind at the same level.
        //
        //     if (seekingVar === seekingValue && isActive) {
        //       try {
        //         const callee = f,
        //               thisValue = thisInitializer,
        //               x = initializerForX,;
        //         globalThis.Reflect.apply(callee, thisValue, [x]);
        //       } finally {
        //         seekingVar = 0;
        //       }
        //     }
        let calleeName = containingClass || isObjectMethod
            ? null
            : nameMaker.unusedName('callee');
        let functionName = containingClass
            ? null // Apply as a method call.
            : path.isDeclaration()
            ? path.node.id.name
            : nameMaker.unusedName('f'); // Turned into an IIFE arg
        if (calleeName) {
          declarators.push(
            types.variableDeclarator(
              types.identifier(calleeName),
              types.identifier(functionName),
            )
          );
        }

        let className = containingClass
          // If it's an anonymous class expression, we're going to need to
          // make up a name to be used in an IIFE like
          // `((class_0) => { ... })(class { ... })`
          ? containingClassName || nameMaker.unusedName('class')
          : null;

        // If we need an instance but don't have one, synthesize one
        // by invoking `new` on the class with arguments.
        if (thisArgument === null && containingClass && !node.static &&
            // If the COMEHERE block is in the constructor, we don't
            // need an instance, we just use `new` in lieu of a call.
            node.kind !== 'constructor') {
          let classBody = path.parentPath;
          let members = classBody.node.body;
          let constructorIndex = members.findIndex((member) => member.kind === 'constructor');
          let constructorArgumentList;
          if (constructorIndex < 0) {
            constructorArgumentList = []; // Default zero arg constructor
          } else {
            let constructorArgumentPrefixes = [];
            if (containingClassName) {
              constructorArgumentPrefixes.push([containingClassName, 'this']);
            }
            constructorArgumentPrefixes.push(['this']);
            constructorArgumentList = buildArgumentList(
              members[constructorIndex].params,
              constructorArgumentPrefixes
            );
          }
          thisArgument = [null, types.newExpression(
            types.identifier(className),
            constructorArgumentList
          )];
        }

        let thisName = null;
        if (thisArgument || isObjectMethod) {
          thisName = nameMaker.unusedName('this');
          if (thisArgument) { // For object methods, thisName is declared on an IIFE
            declarators.push(
              types.variableDeclarator(
                types.identifier(thisName),
                thisArgument[1],
              ),
            );
          }
        }

        // Now that we know the `this` value, build the argument list.
        // By doing this, we make sure that the declarators for any
        // constructor call come before the arguments which are used
        // later in the function/method call.
        let argumentList = buildArgumentList(node.params, prefixes);

        // If the COMEHERE block is inside a generator, then we need
        // to invoke `.next()` on its result.
        // TODO: if the COMEHERE block is inside an async block then
        // do we need to `await` it?
        // Sample these bits before changing them by creating an
        // accessor method.
        let needDotNextCall = node.generator;

        let methodKeyExpression = null;
        let methodKind = node.kind;
        if ((containingClass || isObjectMethod) && methodKind !== 'constructor') {
          let key = path.get('key');
          let computed = node.computed;
          if (!computed && key.isIdentifier()) {
            methodKeyExpression = types.identifier(key.node.name);
          } else {
            // For private methods, and method defined with a complex,
            // potentially side-effecting key expression like the below,
            // create a method with a well-known name and
            // have the complex one call the simple one.
            //
            // class C {
            //   async [expression](x, y) { bodyWithCOMEHERE }
            //   #foo(a, b) { bodyWithCOMEHERE }
            // }
            //
            // ->
            //
            // class C {
            //   async accessor_0(x, y) { bodyWithCOMEHERE }
            //   [expression](...args) { return this.accessor_0(...args); }
            //   accessor_1(a, b) { bodyWithCOMEHERE }
            //   #foo(...args) { return this.accessor_1(...args); }
            // }

            let stableMethodName = nameMaker.unusedName('accessor');
            let {body, params, 'async': isAsync, generator, 'static': isStatic, kind} = node;
            node.async = node.generator = false;
            let delegateMemberExpression = types.memberExpression(
              isStatic ? types.identifier(className) : types.thisExpression(),
              types.identifier(stableMethodName),
            );
            let delegatingExpression;
            switch (kind) {
            case 'method':
              node.params = [types.restElement(types.identifier('args'))];
              delegatingExpression = types.callExpression(
                delegateMemberExpression,
                [types.spreadElement(types.identifier('args'))],
              );
              break;
            case 'get':
              node.params = [];
              delegatingExpression = delegateMemberExpression;
              break;
            case 'set':
              node.params = [types.identifier('newValue')];
              delegatingExpression = types.assignmentExpression(
                '=',
                delegateMemberExpression,
                types.identifier('newValue')
              );
              break;
            default: throw kind;
            }
            path.get('body').replaceWithMultiple([ // return this.stableName(...args)
              types.returnStatement(delegatingExpression)
            ]);
            let delegatingMethod = isObjectMethod
                ? types.objectMethod(
                  kind,
                  types.identifier(stableMethodName),
                  params,
                  body,
                  /* computed */ false,
                  /* generator */ generator,
                  /* async */ isAsync,
                )
                : types.classMethod(
                  kind,
                  types.identifier(stableMethodName),
                  params,
                  body,
                  /* computed */ false,
                  /* static */ isStatic,
                  /* generator */ generator,
                  /* async */ isAsync,
                );
            path.insertBefore(delegatingMethod);
            methodKeyExpression = types.identifier(stableMethodName);
          }
        }

        let invocationExpression;
        if (methodKeyExpression) { // Invoke as method
          let memberExpression = types.memberExpression(
            types.identifier(thisName || className),
            methodKeyExpression,
          );
          switch (methodKind) {
          case 'method':
            invocationExpression = types.callExpression(
              memberExpression,
              argumentList,
            );
            break;
          case 'get':
            invocationExpression = memberExpression;
            break;
          case 'set':
            invocationExpression = types.assignmentExpression(
              '=',
              memberExpression,
              argumentList[0] || types.nullLiteral(),
            );
            break;
          default:
            throw methodKind;
          }
        } else if (thisName) { // Invoke via `Reflect.apply`
          invocationExpression = types.callExpression(
            types.memberExpression(
              types.memberExpression(
                types.identifier('globalThis'),
                types.identifier('Reflect'),
              ),
              types.identifier('apply'),
            ),
            [
              types.identifier(calleeName),
              types.identifier(thisName),
              types.arrayExpression(argumentList),
            ]
          );
        } else if (className && node.kind === 'constructor') {
          invocationExpression = types.newExpression(
            types.identifier(className),
            argumentList,
          );
        } else { // Simple function call
          invocationExpression = types.callExpression(
            types.identifier(calleeName),
            argumentList,
          );
        }
        if (needDotNextCall) {
          invocationExpression = types.callExpression(
            types.memberExpression(
              invocationExpression,
              types.identifier('next'),
            ),
            [],
          );
        }

        let setActiveFnBitExpression = types.assignmentExpression(
          '|=',
          types.identifier(assignedNames.requireActiveFns()),
          types.binaryExpression(
            '<<',
            types.bigIntLiteral('1'),
            types.bigIntLiteral('' + bitIndex),
          ),
        );

        // Generate a block of statements that call the function/method.
        // Later we look at the kind of function to figure out where to
        // emplace the block so that we can call it.
        let callBlock = types.ifStatement(
          // The check is outside the context of the function.
          seekingCheckForBlock(path.parentPath),
          types.blockStatement([
            types.tryStatement(
              types.blockStatement(
                [
                  declarators.length
                    ? types.variableDeclaration(
                      'const',
                      declarators,
                    )
                    : null,
                  types.expressionStatement(setActiveFnBitExpression),
                  types.expressionStatement(invocationExpression),
                ].filter((x) => x)
              ),
              null,
              types.blockStatement(
                [
                  types.expressionStatement(
                    types.assignmentExpression(
                      '=',
                      types.identifier(seekingVarName),
                      types.numericLiteral(0),
                    )
                  )
                ]
              )
            )
          ])
        );

        if (path.isFunctionDeclaration()) {
          let containerPath = path.parentPath;
          let insertionPoint = path;
          if (containerPath.isExportDeclaration()) {
            insertionPoint = containerPath;
            containerPath = containerPath.parentPath;
          }
          if (!containerPath.isProgram() || containerPath.isBlockStatement()) {
            throw Error(`Blockify failed ${containerPath.type}`);
          }
          insertionPoint.insertAfter(callBlock);
        } else if (path.isFunctionExpression() || path.isArrowFunctionExpression()) {
          path.replaceWith(
            types.callExpression(
              types.arrowFunctionExpression(
                [types.identifier(functionName)],
                types.blockStatement([
                  callBlock,
                  types.returnStatement(types.identifier(functionName)),
                ]),
              ),
              [path.node]
            )
          );
        } else if (containingClass) {
          if (containingClass.isClassDeclaration()) {
            containingClass.insertAfter(callBlock);
          } else {
            // (className => { callBlock; return className })(class {...})
            containingClass.replaceWith(
              types.callExpression(
                types.arrowFunctionExpression(
                  [types.identifier(className)],
                  types.blockStatement([
                    callBlock,
                    types.returnStatement(types.identifier(className)),
                  ]),
                ),
                [containingClass.node]
              )
            )
          }
        } else if (isObjectMethod) {
          let parent = path.parent;
          // (thisName => { callBlock; return thisName })({ method() ... })
          path.parentPath.replaceWith(
            types.callExpression(
              types.arrowFunctionExpression(
                [types.identifier(thisName)],
                types.blockStatement([
                  callBlock,
                  types.returnStatement(types.identifier(thisName)),
                ]),
              ),
              [parent]
            )
          );
        } else {
          throw 'TODO other';
        }
      } else {
        // TODO: when the goal is within an argument initializer expression,
        // do something similar but only compute an argument list for
        // lexically preceding expressions.
        throw 'TODO';
      }
    } else if (path.isConditionalExpression()) {
      //    a ? b : c
      //
      // If the goal is reached from `b`:
      // -> a || seekingVar === seekingValue ? b : c
      // If the goal is reached from `c`:
      // -> a && seekingVar !== seekingValue ? b : c
      let test = path.get('test');
      let consequent = path.get('consequent');
      let alternate = path.get('alternate');
      if (goal.node === consequent.node) {
        test.replaceWith(
          types.logicalExpression(
            '||',
            test.node,
            seekingCheckForBlock(path),
          )
        );
      } else if (goal.node === alternate.node) {
        test.replaceWith(
          types.logicalExpression(
            '&&',
            test.node,
            seekingCheckForBlock(path, true),
          )
        );
      }
    } else if (path.isLogicalExpression()) {
      // If the goal is in the right hand operand, `b`:
      //    a || b
      // -> or(a, () => b, seekingVar === seekingValue)
      //    a && b
      // -> and(a, () => b, seekingVar === seekingValue)
      let left = path.get('left');
      let right = path.get('right');
      if (goal.node === right.node) {
        let supportFnName = null;
        switch (path.node.operator) {
        case '||':
          supportFnName = assignedNames.requireOr();
          break;
        case '&&':
          supportFnName = assignedNames.requireAnd();
          break;
        }
        if (supportFnName) {
          path.replaceWith(
            types.callExpression(
              types.identifier(supportFnName),
              [
                left.node,
                types.arrowFunctionExpression(
                  [],
                  right.node
                ),
                seekingCheckForBlock(path),
              ]
            )
          )
        }
      }
    }
  }

  let path = comeHereBlock.path;
  while (!path.isProgram()) {
    adjust(path);
    path = path.parentPath;
  }

  if (initializers.length) {
    let unused = initializers.map(
      ([dottedPath, right]) =>
          `\`${dottedPath} = ${generate(right).code}\``
    ).join(", ")
    console.error(`COMEHERE: Initializer(s) did not match variables needed: ${unused}.`);
  }
}

/**
 * Allow for syntax like `$$0` to be used to capture names in a way that
 * aids debugging.
 *
 * This syntax looks for all uses of identifiers that start with
 * two dollar signs.
 *
 * For each such name, refered to as `$$name` below, do the following:
 *
 * 1. If it is used in a declaration, or in the parameter list of a function,
 *    return, skipping the remaining steps.
 * 2. Let scope be the deepest common ancestor of all uses that is a function
 *    or module body.
 * 3. Add a declaration to that common ancestor like
 *    `const $$name = [void 0, "$$name undefined"];`.
 * 4. For each use of $$name, it is either the left-hand side of an assignment
 *   expression or it is not.
 *   a. If use is the child of a spread expression, continue to the next use.
 *   b. If use is the left of an assignment expression, let sourceText be
 *     the result of converting the right-hand side to JavaScript followed
 *     by a space followed by the assignment operator reversed.
 *     So if use's parent is `$$name += f() - 1`, sourceText is "f() - 1 =+".
 *   c. Else sourceText is null.
 *   d. rewrite it to `$$name[0]`.
 *   e. If sourceText is non-null, replace it's parent with a sequence
 *      expression that assigns sourceText to `$$name[1]`.
 *      So `$$name += f() - 1` becomes
 *      `($$name[1] = "f() - 1 =+", $$name[0] += f() - 1)`.
 *
 * With that transformation in place, `$$name` can be used to capture the
 * result of an intermediate expression, and can be spread into logging calls.
 *
 *     function g() { return 42 }
 *
 *     let x = f($$0 = g());
 *     console.log(...$$0); // Logs 'g() = 42'
 *
 * That gives a hint about the expression that last affected the value of
 * the sub-expression.
 */
export function desugarDollarDollarVarShorthand(ast, assignedNames) {
  let dollarDollarNameToUses = new Map();
  traverse(
    ast,
    {
      Identifier(path) {
        let {name} = path.node;
        if (name.substring(0, 2) === '$$') {
          if (!dollarDollarNameToUses.has(name)) {
            dollarDollarNameToUses.set(name, []);
          }
          dollarDollarNameToUses.get(name).push(path);
        }
      }
    }
  );

  // Group all the declarations for each function together
  // so that we can use a single const declaration.
  //     const $$0 = [...], $$1 = [...];
  let collectedDeclarators = new Map();

  name_loop:
  for (let [name, uses] of dollarDollarNameToUses.entries()) {
    for (let use of uses) {
      if (isDeclared(use)) {
        continue name_loop;
      }
    }

    // Find the common function ancestors
    let commonFunctions = new Map(); // node -> path
    function* functionsDeepestToShallowest(path) {
      let p = path;
      while (p && !p.isFile()) {
        if (p.isFunction()) { yield p; }
        p = p.parentPath;
      }
    }
    uses.forEach((use, i) => {
      if (!i) { // Initialize from first.
        for (let f of functionsDeepestToShallowest(use)) {
          commonFunctions.set(f.node, f);
        }
      } else { // Intersect
        let fns = new Set();
        for (let f of functionsDeepestToShallowest(use)) {
          fns.add(f.node);
        }
        let toRemove = [];
        for (let f of commonFunctions.keys()) {
          if (!fns.has(f)) {
            toRemove.push(f);
          }
        }
        for (let f of toRemove) {
          commonFunctions.delete(f);
        }
      }
    });
    let commonAncestor;
    for ([, commonAncestor] of commonFunctions.entries()) { break }
    if (commonAncestor) {
      if (!collectedDeclarators.has(commonAncestor.node)) {
        collectedDeclarators.set(commonAncestor.node, []);
      }
      collectedDeclarators.get(commonAncestor.node).push(
        types.variableDeclarator(
          types.identifier(name),
          types.arrayExpression([
            types.stringLiteral('undefined'),
            types.unaryExpression('void', types.numericLiteral(0)),
          ]),
        )
      );
    }

    // Now edit them.
    for (let use of uses) {
      let parent = use.parentPath;
      if (parent.isSpreadElement()) { continue; }
      use.replaceWith(
        types.memberExpression(
          use.node,
          types.numericLiteral(1),
          /* computed */ true,
        )
      );
      if (parent.isAssignmentExpression() && use.node === parent.node.left) {
        let sourceText = `${generate(parent.node.right).code} ${parent.node.operator.split('').reverse().join('')}`;
        parent.replaceWith(
          types.sequenceExpression([
            types.assignmentExpression(
              '=',
              types.memberExpression(
                types.identifier(name),
                types.numericLiteral(0),
                /* computed */ true,
              ),
              types.stringLiteral(sourceText),
            ),
            parent.node,
          ])
        );
      }
    }
  }

  for (let [fnNode, declarators] of collectedDeclarators.entries()) {
    fnNode.body.body.unshift(
      types.variableDeclaration('const', declarators)
    );
  }
}

/**
 * Recognize and rewrite a module that may contain
 * `COMEHERE: with (...) { ... }` syntax to drive control
 * to a COMEHERE block of the developer's choice.
 */
export function transform(jsSource, console = globalThis.console) {
  let ast = parse(
    jsSource,
    {
      // Work on modules so we can pass off `import.meta`
      // to our debug host hooks.
      sourceType: 'module',
      // errorRecovery is needed to parse `with` statements
      // in module mode which we rewrite to allowed AST nodes
      // before synthesizing.
      errorRecovery: true,
    }
  );
  let nameMaker = new NameMaker(namesUsedIn(ast));

  // Make sure we have blocks to insert instructions into.
  blockify(ast);

  let assignedNames = new AssignedNames(nameMaker);

  pullComeHereBlocksAfterReturnIntoFinally(ast, assignedNames);

  let comeHereBlocks = extractComeHereBlocks(ast, assignedNames, console);

  driveControlToComeHereBlocks(comeHereBlocks, assignedNames, console);

  desugarDollarDollarVarShorthand(ast, assignedNames);

  declareAssignedNames(ast, assignedNames);

  return {
    code: generate(ast).code,
    blocks: comeHereBlocks.map(b => b.description),
  };
}
