import { describe, it, expect } from 'vitest';
import { createEngine, toDb } from '../src/lib/canceller.js';

// 疑似乱数(再現性のため)
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/**
 * 部屋のシミュレーション。
 * マイク = 騒音の純音 + スピーカー出力(直接音+反射、ブラウザの遅れ込み) + 背景のサー
 */
function simulate({ seconds = 20, sr = 48000, fTrue = 15734.3, fGuess = 15733.8, noiseAmp = 0.02, paths = [[0.4, 1800], [0.15, 2300]], hiss = 0.003, seed = 1 } = {}) {
  const r = rng(seed);
  const eng = createEngine({ sampleRate: sr, freq: fGuess });
  const total = seconds * sr;
  const maxDelay = Math.max(1, ...paths.map((p) => p[1])) + 1;
  const outHist = new Float32Array(total + maxDelay);
  const mic = new Float32Array(total);
  const phase0 = r() * Math.PI * 2;
  const Q = 128;
  const inBuf = new Float32Array(Q);
  const outBuf = new Float32Array(Q);
  for (let n0 = 0; n0 < total; n0 += Q) {
    for (let k = 0; k < Q; k++) {
      const n = n0 + k;
      let x = noiseAmp * Math.cos((2 * Math.PI * fTrue * n) / sr + phase0) + hiss * gauss(r);
      for (const [g, d] of paths) if (n - d >= 0) x += g * outHist[n - d];
      inBuf[k] = x;
      mic[n] = x;
    }
    eng.process(inBuf, outBuf);
    outHist.set(outBuf, n0);
  }
  return { eng, mic, sr, fTrue };
}

/** 指定周波数の振幅(独立した測り方: 区間を窓かけして検波) */
function toneAmp(sig, sr, f, from, to) {
  let re = 0;
  let im = 0;
  let wsum = 0;
  for (let n = from; n < to; n++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (n - from)) / (to - from));
    re += w * sig[n] * Math.cos((2 * Math.PI * f * n) / sr);
    im += w * sig[n] * Math.sin((2 * Math.PI * f * n) / sr);
    wsum += w;
  }
  return (2 * Math.hypot(re, im)) / wsum;
}

describe('狭帯域の適応打ち消し(部屋シミュレーション)', () => {
  it('遅れ・反射・周波数の推定ずれがあっても、マイク位置の純音を20dB以上下げる', () => {
    const { eng, mic, sr, fTrue } = simulate();
    const before = toneAmp(mic, sr, fTrue, 0, sr * 1); // 打ち消し前(listen中)
    const after = toneAmp(mic, sr, fTrue, sr * 18, sr * 20);
    expect(eng.state.phase).toBe('adapt');
    expect(toDb(before) - toDb(after)).toBeGreaterThan(20);
  });

  it('最初の聞き取りで周波数のずれを 0.05Hz 以内まで詰める', () => {
    const { eng } = simulate({ seconds: 6 });
    expect(Math.abs(eng.state.freq - 15734.3)).toBeLessThan(0.05);
  });

  it('騒音の周波数がゆっくり変わっても追いかけ続ける(位相・周波数の両方)', () => {
    // fGuess が 2Hz ずれていても listen 段で補正される
    const { eng, mic, sr, fTrue } = simulate({ fGuess: 15732.3, seed: 7 });
    expect(eng.state.phase).toBe('adapt');
    const before = toneAmp(mic, sr, fTrue, 0, sr);
    const after = toneAmp(mic, sr, fTrue, sr * 18, sr * 20);
    expect(toDb(before) - toDb(after)).toBeGreaterThan(15);
  });

  it('スピーカーの音がマイクに届かないときは打ち消さずに失敗を知らせる', () => {
    const { eng } = simulate({ seconds: 8, paths: [] });
    expect(eng.state.phase).toBe('fail');
    expect(eng.state.message).toMatch(/届いていません/);
  });

  it('出力は上限を超えない(耳とスピーカーを守る)', () => {
    // 騒音が大きくスピーカー経路が弱い → 必要な振幅が上限を超える状況
    const { eng } = simulate({ seconds: 10, noiseAmp: 0.5, paths: [[0.3, 1800]] });
    expect(Math.hypot(eng.state.W.re, eng.state.W.im)).toBeLessThanOrEqual(0.3 + 1e-9);
  });
});
