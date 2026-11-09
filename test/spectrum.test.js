import { describe, it, expect } from 'vitest';
import { findTonalPeaks, quietZoneMm, wavelengthMm, bandLevelDb, averageDb } from '../src/lib/spectrum.js';

// AnalyserNode と同じ形の dB スペクトルを作る(ブラックマン窓 + 基数2 FFT)
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2], ai = im[i + k + len / 2];
        const tr = ar * wr - ai * wi, ti = ar * wi + ai * wr;
        re[i + k + len / 2] = re[i + k] - tr;
        im[i + k + len / 2] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
      }
    }
  }
}
let seed = 3;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
function spectrumDb(signalFn, n = 16384, sr = 48000) {
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / n) + 0.08 * Math.cos((4 * Math.PI * i) / n);
    re[i] = signalFn(i / sr) * w;
  }
  fft(re, im);
  const db = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) db[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) / n + 1e-12);
  return db;
}
const hiss = () => (rnd() - 0.5) * 0.01;
// アプリと同じく 8 フレーム平均したスペクトル
const avgSpectrum = (fn) => averageDb(Array.from({ length: 8 }, (_, k) => spectrumDb((t) => fn(t + k * 0.35))));
const P = { sampleRate: 48000, fftSize: 16384 };

describe('キーン(純音)ピークの検出', () => {
  it('サーの中に埋もれた 15.7kHz の純音を 1Hz 以内で見つける', () => {
    const db = spectrumDb((t) => 0.003 * Math.sin(2 * Math.PI * 15734.3 * t) + hiss());
    const peaks = findTonalPeaks(db, P);
    expect(peaks.length).toBeGreaterThan(0);
    expect(Math.abs(peaks[0].freq - 15734.3)).toBeLessThan(1);
    expect(peaks[0].prominence).toBeGreaterThan(12);
  });

  it('2本あるときは目立つ順に返し、裾を別ピークとして数えない', () => {
    const db = spectrumDb((t) => 0.01 * Math.sin(2 * Math.PI * 12000 * t) + 0.002 * Math.sin(2 * Math.PI * 17500 * t) + hiss());
    const peaks = findTonalPeaks(db, P);
    expect(peaks.map((p) => Math.round(p.freq / 100) * 100).slice(0, 2)).toEqual([12000, 17500]);
    expect(peaks.filter((p) => Math.abs(p.freq - 12000) < 200).length).toBe(1);
  });

  it('広帯域の「サー」だけなら(数フレーム平均すれば)純音として報告しない', () => {
    for (let trial = 0; trial < 5; trial++) {
      const db = avgSpectrum(() => hiss() * 5);
      expect(findTonalPeaks(db, P)).toEqual([]);
    }
  });

  it('平均しても純音は残る', () => {
    const db = avgSpectrum((t) => 0.003 * Math.sin(2 * Math.PI * 15734.3 * t) + hiss());
    expect(Math.abs(findTonalPeaks(db, P)[0].freq - 15734.3)).toBeLessThan(1);
  });

  it('minFreq より低い音(人の声・空調の低音)は対象外', () => {
    const db = spectrumDb((t) => 0.02 * Math.sin(2 * Math.PI * 440 * t) + hiss());
    expect(findTonalPeaks(db, { ...P, minFreq: 2000 })).toEqual([]);
  });

  it('帯域レベルは純音を足すと上がる', () => {
    const quiet = bandLevelDb(spectrumDb(() => hiss()), { ...P, from: 15000, to: 16500 });
    const loud = bandLevelDb(spectrumDb((t) => 0.05 * Math.sin(2 * Math.PI * 15734 * t) + hiss()), { ...P, from: 15000, to: 16500 });
    expect(loud).toBeGreaterThan(quiet + 5);
  });
});

describe('静かになる範囲の目安', () => {
  it('波長と λ/10 (15kHz → 約2.3mm、100Hz → 約34cm)', () => {
    expect(wavelengthMm(343)).toBeCloseTo(1000, 5);
    expect(quietZoneMm(15000)).toBeCloseTo(2.29, 1);
    expect(quietZoneMm(100)).toBeCloseTo(343, 0);
  });
});
