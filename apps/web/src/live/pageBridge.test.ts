import { describe, expect, it } from 'vitest';
import { editablePids } from './pageBridge.ts';

describe('editablePids', () => {
  it('script-drawn pid is read-only', () => {
    const stamped = { p1: 'Revenue by quarter', p2: 'Loading…', p3: 'Line one\nLine two', p4: 'Dropped' };
    const reported = [
      { pid: 'p1', text: '  Revenue   by quarter ' },
      // A chart script replaced the placeholder text.
      { pid: 'p2', text: 'Q3: $1.2M' },
      { pid: 'p3', text: 'Line one \n Line two' },
      // A script cloned a stamped node: both copies are read-only.
      { pid: 'p1', text: 'Revenue by quarter' },
    ];
    expect([...editablePids(stamped, reported)]).toEqual(['p3']);
  });
});
