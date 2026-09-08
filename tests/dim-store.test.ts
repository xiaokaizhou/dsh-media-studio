import { describe, expect, it } from 'vitest'
import { buildAdjacency, computeRelated, getDimSet, setDimSet } from '../src/client/dim-store'

/** Tiny edge-list helper. */
function adjOf(pairs: Array<[string, string]>) {
  return buildAdjacency(pairs.map(([source, target]) => ({ source, target })))
}

describe('buildAdjacency', () => {
  it('indexes outgoing and incoming lists', () => {
    const a = adjOf([['a', 'b'], ['b', 'c'], ['x', 'b']])
    expect([...a.out.get('b')!]).toEqual(['c'])
    expect([...a.in.get('b')!]).toEqual(['a', 'x'])
    expect(a.out.has('c')).toBe(false) // no outgoing edges from c
    expect(a.in.has('a')).toBe(false)
  })

  it('keeps duplicate edges as duplicate adjacency entries', () => {
    const a = adjOf([['a', 'b'], ['a', 'b']])
    expect(a.out.has('b')).toBe(false)
    expect([...a.out.get('a')!]).toEqual(['b', 'b'])
  })
})

describe('computeRelated — upstream closure', () => {
  it('reaches all ancestors of the selection', () => {
    // p → q → r → sel
    const a = adjOf([['p', 'q'], ['q', 'r'], ['r', 'sel']])
    expect(computeRelated(a, ['sel'])).toEqual(new Set(['sel', 'r', 'q', 'p']))
  })
})

describe('computeRelated — downstream closure', () => {
  it('reaches all descendants of the selection', () => {
    // sel → a1 → a2
    const a = adjOf([['sel', 'a1'], ['a1', 'a2']])
    expect(computeRelated(a, ['sel'])).toEqual(new Set(['sel', 'a1', 'a2']))
  })
})

describe('computeRelated — sibling branches stay unrelated', () => {
  it('an ancestor of a descendant (not of the selection) is excluded', () => {
    // u → d ← s : s's downstream is {d}; u feeds d but is NOT an ancestor of s
    const a = adjOf([['u', 'd'], ['s', 'd']])
    const rel = computeRelated(a, ['s'])
    expect(rel).toEqual(new Set(['s', 'd']))
    expect(rel.has('u')).toBe(false)
  })
})

describe('computeRelated — multi-select unions the closures', () => {
  it('merges upstream + downstream of every selected node', () => {
    // a → m → c ; b → m ; sel1 → c ; sel2 → d
    const a = adjOf([['a', 'm'], ['b', 'm'], ['m', 'c'], ['sel1', 'c'], ['sel2', 'd']])
    const rel = computeRelated(a, ['sel1', 'sel2'])
    // related = up({sel1, sel2}) ∪ down({sel1, sel2}) = {sel1, sel2, c, d}.
    // a/b/m feed c (a DESCENDANT of sel1), they are not ancestors of the
    // selection itself → they stay dimmed ("与当前节点无关" per spec).
    expect(rel).toEqual(new Set(['sel1', 'sel2', 'c', 'd']))
  })
})

describe('computeRelated — cycle safety', () => {
  it('terminates on a cycle and includes the whole ring', () => {
    const a = adjOf([['x', 'y'], ['y', 'z'], ['z', 'x']])
    const rel = computeRelated(a, ['x'])
    expect(rel).toEqual(new Set(['x', 'y', 'z']))
  })
})

describe('computeRelated — trivial cases', () => {
  it('isolated selected node → only itself', () => {
    expect(computeRelated(adjOf([]), ['solo'])).toEqual(new Set(['solo']))
  })

  it('empty selection → empty set', () => {
    const a = adjOf([['a', 'b']])
    expect(computeRelated(a, [])).toEqual(new Set())
  })

  it('edge dim rule: both endpoints related ⇒ highlighted', () => {
    // a → sel → c : edge a→sel and sel→c are chain edges (both endpoints related)
    const a = adjOf([['a', 'sel'], ['sel', 'c'], ['z', 'q']])
    const rel = computeRelated(a, ['sel'])
    const edgeRelated = (s: string, t: string) => rel.has(s) && rel.has(t)
    expect(edgeRelated('a', 'sel')).toBe(true)
    expect(edgeRelated('sel', 'c')).toBe(true)
    expect(edgeRelated('z', 'q')).toBe(false)
  })
})

describe('dim store (module-level set, per-canvas)', () => {
  it('publishes, reads and clears per canvas id', () => {
    const set = new Set(['a', 'b'])
    setDimSet('c1', set)
    expect(getDimSet('c1')).toBe(set)
    expect(getDimSet('c2')).toBe(null)
    setDimSet('c1', null)
    expect(getDimSet('c1')).toBe(null)
  })

  it('re-publishing the same reference is a no-op; a new ref republishes', () => {
    const set = new Set(['x'])
    setDimSet('c1', set)
    // Same reference → early return, stored reference untouched.
    setDimSet('c1', set)
    expect(getDimSet('c1')).toBe(set)
    // Different reference with equal content → dispatch + replace.
    setDimSet('c1', new Set(['x']))
    expect(getDimSet('c1')).not.toBe(set)
    expect(getDimSet('c1')).toEqual(new Set(['x']))
    setDimSet('c1', null)
  })
})
