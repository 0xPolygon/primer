import { describe, expect, it } from 'vitest';
import { matchPids } from './match.ts';
import { stampPage } from './stamp.ts';

describe('matchPids', () => {
  const v1 = stampPage(`<body>
    <h1>Roadmap</h1>
    <p>We will ship the editor in the spring and the widgets after it.</p>
    <p>Old closing note.</p>
  </body>`).pids;

  it('kept pid wins', () => {
    const next = stampPage('<body><p data-pid="p1">Something else entirely</p></body>', v1);
    expect(next.pids.map((p) => p.pid)).toEqual(['p1']);
    expect(next.uncertain).toEqual([]);
  });

  it('reworded paragraph at the same path keeps its pid', () => {
    const next = stampPage(`<body>
      <h1>Roadmap</h1>
      <p>We will ship the editor in spring and the widgets soon after it.</p>
    </body>`, v1);
    expect(next.pids.map((p) => p.pid)).toEqual(['p1', 'p2']);
    expect(next.uncertain).toEqual([]);
  });

  it('moved heading matches by tag and text', () => {
    const next = stampPage(`<body>
      <section><p>Intro first now.</p></section>
      <div><h1>Roadmap</h1></div>
    </body>`, v1);
    expect(next.pids.find((p) => p.text === 'Roadmap')!.pid).toBe('p1');
  });

  it('new element gets a fresh pid; removed pid is dropped', () => {
    const next = stampPage(`<body>
      <h1>Roadmap</h1>
      <p>We will ship the editor in the spring and the widgets after it.</p>
      <h2>A brand new section</h2>
    </body>`, v1);
    expect(next.pids.map((p) => p.pid)).toEqual(['p1', 'p2', 'p4']);
  });

  it('repeated labels are uncertain', () => {
    const page = '<body><div><button>Learn more</button></div><div><button>Learn more</button></div><div><button>Learn more</button></div></body>';
    const prev = stampPage(page).pids;
    const next = stampPage(page, prev);
    expect(next.pids.map((p) => p.pid)).toEqual(['p1', 'p2', 'p3']);
    expect(next.uncertain).toEqual(['p1', 'p2', 'p3']);
    // Kept pids make them certain.
    expect(stampPage(next.stamped, prev).uncertain).toEqual([]);
  });

  it('a close runner-up is uncertain', () => {
    const prev = stampPage('<body><p>Status: green today</p><p>Status: green toda</p></body>').pids;
    const result = matchPids(prev, [{ tag: 'p', path: 'section[0]/p[0]', span: [0, 0], text: 'Status: green today!' }]);
    expect(result).toEqual([{ pid: 'p1', uncertain: true }]);
  });
});

describe('matchPids on hostile pages', () => {
  it('a 20,000-element page of identical labels finishes within its budget', () => {
    const page = `<body>${'<div><button>Learn more</button></div>'.repeat(20_000)}</body>`;
    const prev = stampPage(page).pids;
    const started = Date.now();
    const next = stampPage(page, prev);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(next.pids).toHaveLength(20_000);
    expect(new Set(next.pids.map((p) => p.pid)).size).toBe(20_000);
    // Every match there is uncertain (repeated labels); the rest are fresh.
    expect(next.uncertain.length).toBeLessThanOrEqual(3000);
  });
});
