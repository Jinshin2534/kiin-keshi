import { describe, it, expect } from 'vitest';
import { makeReport, formatWhen } from '../src/lib/report.js';

describe('報告メモ', () => {
  const when = new Date(2026, 10, 9, 10, 5);
  it('測った周波数・目立ち具合・日時が入る', () => {
    const t = makeReport({ freq: 15734.3, prominence: 23.4, when, place: '2年3組' });
    expect(t).toContain('15.73kHz');
    expect(t).toContain('23dB');
    expect(t).toContain('2026/11/09 10:05');
    expect(t).toContain('2年3組');
  });
  it('打ち消しを試した結果は「席では効かない」と正直に添える', () => {
    expect(makeReport({ freq: 16000, prominence: 20, when, cancelDb: 31.6 })).toMatch(/マイクの位置だけで 32dB.*耳の位置では効きません/);
    expect(makeReport({ freq: 16000, prominence: 20, when })).not.toContain('打ち消し');
  });
  it('日時の書式', () => expect(formatWhen(when)).toBe('2026/11/09 10:05'));
});
