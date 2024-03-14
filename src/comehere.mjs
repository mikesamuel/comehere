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
import generateDefault from '@babel/generator';
import traverseDefault from '@babel/traverse';
import * as types from '@babel/types';
import { NameMaker, namesUsedIn } from './name-maker.mjs';
import { AssignedNames, declareAssignedNames } from './assigned-names.mjs';

let traverse = traverseDefault.default;
let generate = generateDefault.default;

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
  seekingVarName,
  ast,
  nameMaker
) {
  let extracted = [];

  let visitor = {
    // The kind of visitor who comes to your house
    // to rummage through your closets.

    WithStatement(path) {
      let parentPath = path.parentPath;
      if (parentPath.isLabeledStatement() && parentPath.node.label.name === 'COMEHERE') {
        // Zero as a seekingValue means not seeking any COMEHERE.
        let seekingValue = extracted.length + 1;
        let initializers = path.get('object').node;
        let body = path.get('body'); // A block because of blockify above.
        // Turn the `with` into an `if`.
        parentPath.replaceWith(
          types.ifStatement(
            types.binaryExpression(
              '===',
              types.identifier(seekingVarName),
              types.numericLiteral(seekingValue)
            ),
            body.node,
          )
        );
        // Turn off seeking now that we found it, so that reentrant uses
        // function correctly.
        body.get('body')[0].insertBefore(
          types.expressionStatement(
            types.assignmentExpression(
              '=',
              types.identifier(seekingVarName),
              types.numericLiteral(0)
            )
          )
        );
        extracted.push(new ComeHereBlock(seekingValue, parentPath, initializers));
      }
    }
  };

  traverse(ast, visitor);

  return extracted;
}

class ComeHereBlock {
  #seekingValue;
  #path;
  #initializers;

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

  constructor(seekingValue, path, initializers) {
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

function driveControlToComeHereBlock(
  comeHereBlock,
  assignedNames,
  console
) {
  let seekingVarName = assignedNames.seekingVarName;
  let seekingValue = comeHereBlock.seekingValue;
  let nameMaker = assignedNames.nameMaker;
  // Deconstruct initializers to [dotted-path, right-hand-side] pairs
  let initializers = [];
  {
    let it = (types.isSequenceExpression(comeHereBlock.initializers))
        ? comeHereBlock.initializers.expressions
        : [comeHereBlock.initializers];
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

  function seekingCheck(comparisonOp = '===') {
    return types.binaryExpression(
      comparisonOp,
      types.identifier(seekingVarName),
      types.numericLiteral(seekingValue),
    );
  }

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
          types.logicalExpression('||', test.node, seekingCheck())
        )
      } else if (elseClause.node === goal.node) {
        test.replaceWith(
          types.logicalExpression('&&', test.node, seekingCheck('!=='))
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
            seekingCheck(),
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
            types.logicalExpression('||', test.node, seekingCheck())
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
              [ right.node, seekingCheck() ]
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
        let conditionalThrow = types.ifStatement(
          seekingCheck(),
          types.blockStatement([
            types.throwStatement(types.nullLiteral()),
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
        //     if (seekingVar === seekingValue) {
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

        // Generate a block of statements that call the function/method.
        // Later we look at the kind of function to figure out where to
        // emplace the block so that we can call it.
        let callBlock = types.ifStatement(
          seekingCheck(),
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
            seekingCheck(),
          )
        );
      } else if (goal.node === alternate.node) {
        test.replaceWith(
          types.logicalExpression(
            '&&',
            test.node,
            seekingCheck('!=='),
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
                seekingCheck(),
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

  // We need a local variable to tell us which block we're seeking.
  let seekingVarName = nameMaker.unusedName('seeking');

  let comeHereBlocks = extractComeHereBlocks(seekingVarName, ast, nameMaker);
  let assignedNames = new AssignedNames(nameMaker, seekingVarName);

  driveControlToComeHereBlocks(comeHereBlocks, assignedNames, console);

  declareAssignedNames(ast, assignedNames);

  return generate(ast).code;
}
