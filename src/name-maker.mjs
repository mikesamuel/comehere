import traverseDefault from '@babel/traverse';
import * as types from '@babel/types';

export function namesUsedIn(ast) {
  let namesUsed = new Set();
  let visitor = {
    Identifier(path) {
      let parent = path.parent;
      if (parent && parent.type === 'ObjectProperty' &&
          parent.key === path.node &&
          !parent.computed && !parent.shorthand) {
        return;
      }
      if (parent && parent.type === 'MemberExpression' &&
          parent.property == path.node &&
          !parent.computed) {
        return;
      }
      namesUsed.add(path.node.name);
    }
  };
  traverseDefault.default(ast, visitor);
  return namesUsed;
}

/**
 * Utility class that inspects a Babel AST to find used names
 * so that we can fabricate names that do not mask/conflict.
 */
export class NameMaker {
  #namesUsed;
  #counters;

  constructor(namesUsed) {
    this.#namesUsed = namesUsed;
    this.#counters = new Map();
  }

  unusedName(identifierPrefix = 't') {
    let namesUsed = this.#namesUsed;
    let counters = this.#counters;
    let suffixCounter = counters.get(identifierPrefix) || 0;
    while (true) {
      let candidate = `${identifierPrefix}_${suffixCounter}`;
      suffixCounter += 1;
      if (!namesUsed.has(candidate)) {
        counters.set(identifierPrefix, suffixCounter);
        return candidate;
      }
    }
  }
}
