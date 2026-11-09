// スペクトル(dB配列)から「キーン」系の純音ピークを探す。純関数のみ。

export const binToFreq = (i, sampleRate, fftSize) => (i * sampleRate) / fftSize;
export const freqToBin = (f, sampleRate, fftSize) => (f * fftSize) / sampleRate;

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 純音ピークを探す。
 * prominence = ピーク値 − 周囲(ピーク近傍を除く)の中央値。広帯域の「サー」は prominence が出ない。
 * 周波数は放物線補間で bin 幅より細かく求める。
 * @param {Float32Array|number[]} db AnalyserNode.getFloatFrequencyData の結果(長さ fftSize/2)
 */
export function findTonalPeaks(db, { sampleRate, fftSize, minFreq = 2000, maxFreq = sampleRate / 2 - 200, prominenceDb = 12, maxPeaks = 5, floorDb = -140 } = {}) {
  const n = db.length;
  const lo = Math.max(3, Math.ceil(freqToBin(minFreq, sampleRate, fftSize)));
  const hi = Math.min(n - 4, Math.floor(freqToBin(maxFreq, sampleRate, fftSize)));
  const ctxHalf = Math.max(20, Math.round(freqToBin(300, sampleRate, fftSize))); // 周囲 ±300Hz
  const guard = 4;
  const peaks = [];
  for (let i = lo; i <= hi; i++) {
    const v = db[i];
    if (!(v > floorDb)) continue;
    if (!(v > db[i - 1] && v >= db[i + 1] && v > db[i - 2] && v >= db[i + 2])) continue;
    const around = [];
    for (let j = Math.max(0, i - ctxHalf); j <= Math.min(n - 1, i + ctxHalf); j++) {
      if (Math.abs(j - i) > guard && Number.isFinite(db[j])) around.push(db[j]);
    }
    if (around.length < 8) continue;
    const prominence = v - median(around);
    if (prominence < prominenceDb) continue;
    const a = db[i - 1], b = v, c = db[i + 1];
    const den = a - 2 * b + c;
    const delta = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    peaks.push({
      freq: binToFreq(i + delta, sampleRate, fftSize),
      db: b - 0.25 * (a - c) * delta,
      prominence,
      bin: i,
    });
  }
  peaks.sort((p, q) => q.prominence - p.prominence);
  // 近すぎるピーク(同じ音の裾)をまとめる
  const out = [];
  for (const p of peaks) {
    if (out.every((q) => Math.abs(q.freq - p.freq) > 40)) out.push(p);
    if (out.length >= maxPeaks) break;
  }
  return out;
}

/** 帯域の平均パワー(dB)。広帯域の「サー」がどれくらい出ているかの目安 */
export function bandLevelDb(db, { sampleRate, fftSize, from, to }) {
  const lo = Math.max(0, Math.floor(freqToBin(from, sampleRate, fftSize)));
  const hi = Math.min(db.length - 1, Math.ceil(freqToBin(to, sampleRate, fftSize)));
  let sum = 0;
  let k = 0;
  for (let i = lo; i <= hi; i++) {
    if (!Number.isFinite(db[i])) continue;
    sum += Math.pow(10, db[i] / 10);
    k++;
  }
  return k ? 10 * Math.log10(sum / k) : -Infinity;
}

const SPEED_OF_SOUND = 343; // m/s (20℃)

export const wavelengthMm = (freq) => (SPEED_OF_SOUND / freq) * 1000;

/**
 * 打ち消しで 10dB 静かになる範囲の直径の目安 = 波長の 1/10。
 * (Elliott & Nelson, "Active Noise Control", IEEE SP Magazine 1993 の目安)
 */
export const quietZoneMm = (freq) => wavelengthMm(freq) / 10;

/** 年齢とともに聞こえにくくなる帯域の目安(説明用) */
export function hearingNote(freq) {
  if (freq >= 17000) return '17kHz以上。10代〜20代前半には聞こえ、大人には聞こえにくい高さです';
  if (freq >= 14000) return '14kHz以上。若い人ほどよく聞こえる高さです';
  if (freq >= 8000) return 'かなり高い音。多くの人に聞こえます';
  return 'ふつうに聞こえる高さです';
}

/**
 * 複数フレームの dB スペクトルをパワーで平均する。
 * 1枚だけだと白色雑音にも 12dB 級のとげがランダムに立つ(ピリオドグラムの性質)ので、
 * 必ず数フレーム平均してからピークを探す。純音は平均しても残る。
 */
export function averageDb(frames) {
  const n = frames[0].length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const f of frames) s += Math.pow(10, f[i] / 10);
    out[i] = 10 * Math.log10(s / frames.length);
  }
  return out;
}
