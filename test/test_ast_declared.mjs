import { expect, assert } from "chai";
import { describe, it } from "mocha";

import { isDeclared } from "../src/ast-declared.mjs";

import {parse} from '@babel/parser';
import { traverse } from '../src/babel-bits-and-bobs.mjs';

describe('ast-declared', () => {
  it('isDeclared', () => {
    let source = `
let a = 1;
let [b] = c;
let { d } = { e, f: g };
function h(i, [j], k = l) { m }
class n extends o {
  p(q) { r }
  s;
  static t = u;
}
v = w;
`;
    let ast = parse(source);
    let answers = {};
    traverse(
      ast,
      {
        Identifier(path) {
          let name = path.node.name;
          answers[name] = (answers[name] || false) || isDeclared(path);
        }
      }
    );
    expect(
      {
        a: true,
        b: true,
        c: false,
        d: true,
        e: true,
        f: true,
        g: false,
        h: true,
        i: true,
        j: true,
        k: true,
        l: false,
        m: false,
        n: true,
        o: false,
        p: true,
        q: true,
        r: false,
        s: true,
        t: true,
        u: false,
        v: false,
        w: false,
      }
    ).deep.equals(answers);
  });
});
