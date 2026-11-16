import { describe, expect, it } from 'vitest';
import { fillDays } from './pages/admin/home';

describe('概览的 14 天柱状图', () => {
  it('补齐没有评分的日子，保持日期连续', () => {
    const now = Date.parse('2026-11-14T12:00:00Z');
    const rows = [
      { day: '2026-11-01', done: 3, failed: 1, users: 1 },
      { day: '2026-11-14', done: 2, failed: 0, users: 2 },
    ];
    const out = fillDays(rows, 14, now);
    expect(out).toHaveLength(14);
    expect(out[0]).toEqual(rows[0]);
    expect(out[13]).toEqual(rows[1]);
    expect(out.slice(1, 13).every((d) => d.done === 0 && d.failed === 0)).toBe(true);
    expect(out[1].day).toBe('2026-11-02');
  });
});
