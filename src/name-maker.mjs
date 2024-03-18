import { traverse } from './babel-bits-and-bobs.mjs';
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
  traverse(ast, visitor);
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

  unusedNameAndSuffixNum(identifierPrefix = 't') {
    let namesUsed = this.#namesUsed;
    let counters = this.#counters;
    let suffixCounter = counters.get(identifierPrefix) || 0;
    while (true) {
      let suffixNum = suffixCounter;
      let candidate = `${identifierPrefix}_${suffixNum}`;
      suffixCounter += 1;
      if (!namesUsed.has(candidate)) {
        counters.set(identifierPrefix, suffixCounter);
        return [candidate, suffixNum];
      }
    }
  }

  unusedName(identifierPrefix = 't') {
    return this.unusedNameAndSuffixNum(identifierPrefix)[0];
  }
}
