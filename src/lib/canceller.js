// 狭帯域(純音1本)の適応打ち消し。AudioWorklet とテストの両方から使う純粋な処理。
//
// 考え方:
//   スピーカーから A·cos(θ+φ) を出す。これを複素数 W = A·e^{iφ} で表す(θ は自前の発振器の位相)。
//   マイクで聞こえる音を同じ θ で検波すると、ブロックごとの複素振幅 R が得られる:
//       R = N + G·W
//   N = 騒音(キーン)の複素振幅、G = スピーカー→マイクの伝わり方(遅れ・音量・部屋の反射をまとめた1つの複素数)。
//   G を先に測っておけば、W ← W − μ·R/G で R → 0 に近づけられる(ニュートン型の複素LMS)。
//   ブラウザの音の遅れ(数十ms)は一定なら G の位相に吸収されるので、純音なら打ち消せる。
//   ただし「消える」のはマイクの位置だけ。

export const C = (re = 0, im = 0) => ({ re, im });
export const cadd = (a, b) => C(a.re + b.re, a.im + b.im);
export const csub = (a, b) => C(a.re - b.re, a.im - b.im);
export const cmul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
export const cscale = (a, s) => C(a.re * s, a.im * s);
export const cabs = (a) => Math.hypot(a.re, a.im);
export const carg = (a) => Math.atan2(a.im, a.re);
export function cdiv(a, b) {
  const d = b.re * b.re + b.im * b.im;
  return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
}
const TAU = Math.PI * 2;
const wrap = (x) => ((((x + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
export const toDb = (amp) => 20 * Math.log10(Math.max(amp, 1e-12));

const DEFAULTS = {
  blockSize: 2048, // 検波1回ぶんのサンプル数(48kHzで約43ms)
  listenBlocks: 36, // 最初に騒音だけを聞くブロック数(周波数の微調整用)
  settleBlocks: 3, // 出力を変えた後、遅れが落ち着くまで捨てるブロック数
  measureBlocks: 6, // G を測るとき平均するブロック数
  probeAmp: 0.04, // G を測るテスト音の振幅
  maxAmp: 0.3, // 出力の上限(スピーカー・耳を守る)
  mu: 0.5,
};

/**
 * 打ち消しの状態機械。ブロックごとに step(R) を呼ぶと、次のブロックで出す W と周波数を返す。
 * phase: 'listen' → 'probe' → 'adapt' (失敗時 'fail')
 */
export function createCanceller(opts) {
  const o = { ...DEFAULTS, ...opts };
  const blockSec = o.blockSize / o.sampleRate;
  const st = {
    phase: 'listen',
    freq: o.freq,
    W: C(),
    G: null,
    n0: 0, // 打ち消し前の騒音の大きさ(|N|)
    residual: 0,
    reductionDb: 0,
    message: '',
    blocks: 0,
  };
  const listenPh = [];
  let probeStep = 0;
  let wait = 0;
  let acc = C();
  let accN = 0;
  const probeR = [];
  let prevN = null;
  let freqDrift = 0;
  let badCount = 0;
  let wUsed = C();

  const setW = (w) => {
    const a = cabs(w);
    st.W = a > o.maxAmp ? cscale(w, o.maxAmp / a) : w;
  };

  function finishListen() {
    // 位相の傾き → 周波数のずれ(Δf = dφ/dt / 2π)
    const ph = listenPh.map(carg);
    let un = [ph[0]];
    for (let i = 1; i < ph.length; i++) un.push(un[i - 1] + wrap(ph[i] - ph[i - 1]));
    const n = un.length;
    const tMean = ((n - 1) / 2) * blockSec;
    const pMean = un.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const t = i * blockSec - tMean;
      num += t * (un[i] - pMean);
      den += t * t;
    }
    const slope = num / den; // rad/s
    st.freq += slope / TAU;
    st.n0 = listenPh.reduce((s, r) => s + cabs(r), 0) / n;
    st.phase = 'probe';
    probeStep = 0;
    wait = o.settleBlocks;
  }

  // probe: [0]=W0 基準, [1]=W=p, [2]=W=i·p を各 measureBlocks 平均
  const probeWs = () => [C(), C(o.probeAmp, 0), C(0, o.probeAmp)];

  function finishProbe() {
    const [r0, r1, r2] = probeR;
    const g1 = cdiv(csub(r1, r0), probeWs()[1]);
    const g2 = cdiv(csub(r2, r0), probeWs()[2]);
    const G = cscale(cadd(g1, g2), 0.5);
    // 2つの測定がそろわない = スピーカーの音がマイクに届いていない/雑音に埋もれている
    const agree = cabs(csub(g1, g2)) / Math.max(cabs(G), 1e-12);
    if (cabs(G) * o.probeAmp < 1e-5 || agree > 0.6) {
      st.phase = 'fail';
      st.message = 'スピーカーの音がマイクにうまく届いていません。音量を上げるか、まわりを静かにしてやり直してください';
      setW(C());
      return;
    }
    st.G = G;
    st.phase = 'adapt';
    setW(C());
    wait = o.settleBlocks;
  }

  function step(R) {
    st.blocks++;
    if (st.phase === 'fail' || st.phase === 'stopped') return st;

    if (st.phase === 'listen') {
      listenPh.push(R);
      if (listenPh.length >= o.listenBlocks) finishListen();
      return st;
    }

    if (wait > 0) {
      wait--;
      return st;
    }

    if (st.phase === 'probe') {
      acc = cadd(acc, R);
      accN++;
      if (accN >= o.measureBlocks) {
        probeR[probeStep] = cscale(acc, 1 / accN);
        acc = C();
        accN = 0;
        probeStep++;
        if (probeStep >= 3) finishProbe();
        else {
          setW(probeWs()[probeStep]);
          wait = o.settleBlocks;
        }
      }
      return st;
    }

    // adapt
    st.residual = cabs(R);
    st.reductionDb = toDb(st.n0) - toDb(st.residual);
    // 騒音の推定 N̂ = R − G·W から、周波数のゆっくりしたずれも追いかける
    const nHat = csub(R, cmul(st.G, wUsed));
    if (prevN && cabs(nHat) > 1e-9 && cabs(prevN) > 1e-9) {
      const dphi = wrap(carg(nHat) - carg(prevN));
      const dt = (o.settleBlocks + 1) * blockSec;
      freqDrift = freqDrift * 0.8 + (dphi / dt / TAU) * 0.2;
      st.freq += freqDrift * 0.3;
    }
    prevN = nHat;
    // 発散の見張り: 打ち消す前より大きくなり続けたら止める
    if (st.residual > st.n0 * 2 && st.n0 > 0) {
      if (++badCount >= 4) {
        st.phase = 'fail';
        st.message = '打ち消しが不安定になったので止めました(部屋の反射やマイクの位置が変わった可能性)。もう一度スタートしてください';
        setW(C());
        return st;
      }
    } else badCount = 0;
    setW(csub(st.W, cscale(cdiv(R, st.G), o.mu)));
    wUsed = st.W;
    wait = o.settleBlocks;
    return st;
  }

  return {
    state: st,
    step,
    stop() {
      st.phase = 'stopped';
      setW(C());
    },
  };
}

/**
 * サンプル単位のエンジン。入力(マイク)を検波し、出力(スピーカー)に打ち消し音を書く。
 * AudioWorklet の process から 128 サンプルずつ呼ばれる想定だが、長さは自由。
 */
export function createEngine(opts) {
  const o = { ...DEFAULTS, ...opts };
  const canc = createCanceller(o);
  let theta = 0;
  let sumRe = 0;
  let sumIm = 0;
  let count = 0;
  let wCur = C(); // 実際に出している W (なめらかに目標へ寄せる)
  const rampPerSample = 1 / 1024;

  function process(input, output) {
    const st = canc.state;
    const w = TAU * st.freq / o.sampleRate;
    for (let i = 0; i < output.length; i++) {
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      // 出力 = Re(W·e^{iθ}) = W.re·cos θ − W.im·sin θ
      wCur.re += (st.W.re - wCur.re) * rampPerSample * 8;
      wCur.im += (st.W.im - wCur.im) * rampPerSample * 8;
      output[i] = wCur.re * c - wCur.im * s;
      // 検波: X = (2/N) Σ x·e^{−iθ}
      const x = input ? input[i] || 0 : 0;
      sumRe += x * c;
      sumIm -= x * s;
      count++;
      theta += w;
      if (theta > TAU) theta -= TAU;
      if (count >= o.blockSize) {
        canc.step(C((2 * sumRe) / count, (2 * sumIm) / count));
        sumRe = sumIm = 0;
        count = 0;
      }
    }
    return st;
  }

  return { process, canceller: canc, get state() { return canc.state; } };
}
