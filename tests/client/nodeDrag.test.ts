import { describe, it, expect } from 'vitest';
import { createNodeDrag, CLICK_DISTANCE } from '../../src/client/graph/nodeDrag.js';

function harness(nodes = new Set(['a', 'b'])) {
  const log: string[] = [];
  const drag = createNodeDrag({
    hasNode: (n) => nodes.has(n),
    toGraph: (p) => ({ x: p.x * 10, y: p.y * 10 }),
    pin: (n, x, y) => log.push(`pin ${n} ${x},${y}`),
    release: (n) => log.push(`release ${n}`),
    open: (n) => log.push(`open ${n}`),
  });
  return { drag, log, nodes };
}

// sigma turns both a mouse click and a touch tap into clickNode; the touch path never reached the
// old mouseup-only handler, so a tap opened nothing.
describe('createNodeDrag', () => {
  it('a tap or click that did not move opens the page after releasing the node', () => {
    const { drag, log } = harness();
    drag.down('a', 5, 5);
    drag.up();
    drag.click('a');
    expect(log).toEqual(['release a', 'open a']);
  });

  it('a nudge under the click distance still opens, and still releases the pin', () => {
    const { drag, log } = harness();
    drag.down('a', 5, 5);
    expect(drag.move(5 + CLICK_DISTANCE - 1, 5)).toBe(true);
    drag.up();
    drag.click('a');
    expect(log).toEqual(['pin a 80,50', 'release a', 'open a']);
  });

  it('a drag moves the node under the pointer and does not open it on release', () => {
    const { drag, log } = harness();
    drag.down('a', 0, 0);
    drag.move(3, 4);
    drag.move(6, 8);
    drag.up();
    drag.click('a');
    expect(log).toEqual(['pin a 30,40', 'pin a 60,80', 'release a']);
    // The suppression is spent on that one click: the next plain click opens.
    drag.down('b', 1, 1);
    drag.up();
    drag.click('b');
    expect(log.slice(-2)).toEqual(['release b', 'open b']);
  });

  // A touch drag left the press set, so the next mouse move on a hybrid device dragged that node.
  it('ends the press on release, so a later move is not a drag', () => {
    const { drag, log } = harness();
    drag.down('a', 0, 0);
    drag.up();
    expect(drag.move(50, 50)).toBe(false);
    expect(log).toEqual(['release a']);
  });

  it('a move with no press is left to the camera', () => {
    const { drag, log } = harness();
    expect(drag.move(1, 1)).toBe(false);
    expect(log).toEqual([]);
  });

  it('keeps the pointer but pins nothing once a poll drops the held node', () => {
    const { drag, log, nodes } = harness();
    drag.down('a', 0, 0);
    nodes.delete('a');
    expect(drag.move(20, 20)).toBe(true);
    drag.up();
    drag.click('a');
    expect(log).toEqual(['release a']);
  });
});
