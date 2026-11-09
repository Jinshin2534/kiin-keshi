import './style.css';
import workletUrl from './audio/anc-worklet.js?worker&url';
import { findTonalPeaks, averageDb, quietZoneMm, wavelengthMm, hearingNote } from './lib/spectrum.js';
import { makeReport } from './lib/report.js';

const $ = (id) => document.getElementById(id);
const FFT = 16384;
const F_MIN = 2000;
const DB_LO = -125;
const DB_HI = -45;

const S = {
  ctx: null,
  analyser: null,
  src: null,
  frames: [],
  avg: null,
  peaks: [],
  selected: null, // { freq, prominence, db }
  anc: null, // AudioWorkletNode
  ancPhase: '',
  redHist: [],
  bestRed: null,
};

const fmtHz = (f) => `${Math.round(f).toLocaleString()} Hz`;
const fMax = () => Math.min(S.ctx.sampleRate / 2, 22050);

// ---------- 1. はかる ----------
$('btn-mic').addEventListener('click', async () => {
  const btn = $('btn-mic');
  btn.disabled = true;
  btn.textContent = 'マイクを準備中…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      // 声向けの加工(エコー除去・雑音除去・自動音量)は高い音を消してしまうので全部切る
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    S.ctx = new AudioContext({ latencyHint: 'interactive' });
    S.src = S.ctx.createMediaStreamSource(stream);
    S.analyser = S.ctx.createAnalyser();
    S.analyser.fftSize = FFT;
    S.analyser.smoothingTimeConstant = 0;
    S.src.connect(S.analyser);
    $('scope').hidden = false;
    $('result').hidden = false;
    $('result').innerHTML = '<p class="none">聞いています… (数秒)</p>';
    btn.textContent = 'マイクで聞いています';
    drawAxis();
    startLoops();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'マイクで聞く';
    $('result').hidden = false;
    $('result').innerHTML = `<p class="none">マイクが使えませんでした(${e.name})。ブラウザのマイク許可を確認してください。</p>`;
  }
});

function drawAxis() {
  const ticks = [];
  for (let f = F_MIN; f <= fMax(); f += 4000) ticks.push(`<span>${f / 1000}k</span>`);
  $('axis').innerHTML = ticks.join('');
}

function fitCanvas(cv) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(cv.clientWidth * dpr);
  const h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  return { w, h, dpr };
}

const freqToX = (f, w) => ((f - F_MIN) / (fMax() - F_MIN)) * w;
const binOf = (f) => Math.round((f * FFT) / S.ctx.sampleRate);

// dB → 色(暗い紺 → シアン → 白)
function heat(db) {
  const t = Math.max(0, Math.min(1, (db - DB_LO) / (DB_HI - DB_LO)));
  const r = Math.round(255 * Math.max(0, t * 1.6 - 0.6));
  const g = Math.round(255 * Math.min(1, t * 1.3));
  const b = Math.round(60 + 195 * Math.min(1, t * 2));
  return [r, g, b];
}

function startLoops() {
  const buf = new Float32Array(S.analyser.frequencyBinCount);
  const wf = $('waterfall');
  const wg = wf.getContext('2d');
  let lastFrame = 0;
  let lastList = 0;

  const draw = (now) => {
    S.analyser.getFloatFrequencyData(buf);
    // 滝グラフ: 1行ずつ下へ流す
    const { w, h } = fitCanvas(wf);
    wg.drawImage(wf, 0, 0, w, h - 1, 0, 1, w, h - 1);
    const row = wg.createImageData(w, 1);
    for (let x = 0; x < w; x++) {
      const f0 = F_MIN + (x / w) * (fMax() - F_MIN);
      const f1 = F_MIN + ((x + 1) / w) * (fMax() - F_MIN);
      let m = -Infinity;
      for (let i = binOf(f0); i <= binOf(f1); i++) m = Math.max(m, buf[i]);
      const [r, g, b] = heat(m);
      row.data.set([r, g, b, 255], x * 4);
    }
    wg.putImageData(row, 0, 0);

    if (now - lastFrame > 250) {
      lastFrame = now;
      S.frames.push(Float32Array.from(buf));
      if (S.frames.length > 8) S.frames.shift();
      if (S.frames.length >= 4) {
        S.avg = averageDb(S.frames);
        S.peaks = findTonalPeaks(S.avg, { sampleRate: S.ctx.sampleRate, fftSize: FFT, minFreq: F_MIN, maxFreq: fMax() - 100 });
      }
    }
    drawSpectrum();
    if (now - lastList > 1200 && S.avg) {
      lastList = now;
      renderPeaks();
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

function drawSpectrum() {
  const cv = $('spectrum');
  const { w, h, dpr } = fitCanvas(cv);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!S.avg) return;
  const y = (db) => h - ((Math.max(DB_LO, Math.min(DB_HI, db)) - DB_LO) / (DB_HI - DB_LO)) * (h - 10 * dpr);
  // 横の目盛り
  g.strokeStyle = 'rgba(141,155,189,.15)';
  g.lineWidth = 1;
  for (let db = -120; db <= -50; db += 20) {
    g.beginPath();
    g.moveTo(0, y(db));
    g.lineTo(w, y(db));
    g.stroke();
  }
  g.strokeStyle = '#5ee7ff';
  g.lineWidth = 1.5 * dpr;
  g.beginPath();
  for (let x = 0; x < w; x++) {
    const f0 = F_MIN + (x / w) * (fMax() - F_MIN);
    const f1 = F_MIN + ((x + 1) / w) * (fMax() - F_MIN);
    let m = -Infinity;
    for (let i = binOf(f0); i <= binOf(f1); i++) m = Math.max(m, S.avg[i]);
    x ? g.lineTo(x, y(m)) : g.moveTo(x, y(m));
  }
  g.stroke();
  g.font = `${11 * dpr}px 'JetBrains Mono', monospace`;
  g.textAlign = 'center';
  for (const p of S.peaks) {
    const x = freqToX(p.freq, w);
    const on = S.selected && Math.abs(S.selected.freq - p.freq) < 40;
    g.fillStyle = on ? '#ffb547' : 'rgba(255,181,71,.6)';
    g.beginPath();
    g.arc(x, y(p.db), (on ? 5 : 3.5) * dpr, 0, Math.PI * 2);
    g.fill();
    g.fillText(`${(p.freq / 1000).toFixed(2)}k`, Math.min(w - 30 * dpr, Math.max(30 * dpr, x)), Math.max(14 * dpr, y(p.db) - 10 * dpr));
  }
}

function renderPeaks() {
  const el = $('result');
  // 打ち消し中は選んだ音を差し替えない
  const same = S.selected && S.peaks.find((p) => Math.abs(p.freq - S.selected.freq) < 40);
  if (!S.anc && S.peaks.length && !same) {
    S.selected = { ...S.peaks[0] };
    onSelect();
  } else if (!S.anc && same) {
    // 同じ音なら最新の測定値に更新(報告メモの数字と一覧をそろえる)
    S.selected = { ...same };
    updateReport();
  }
  if (!S.peaks.length) {
    el.innerHTML = `<p class="none">いまは一定の高さの「キーン」は見つかっていません。鳴っている時に、もう少し待ってみてください。<br>「サー」という音(広い帯域の雑音)は、打ち消しでは消せません。</p>`;
    return;
  }
  el.innerHTML = `<div class="peaks">${S.peaks
    .map((p, i) => {
      const on = S.selected && Math.abs(S.selected.freq - p.freq) < 40;
      return `<button class="peak${on ? ' on' : ''}" data-i="${i}">
        <span class="f">${fmtHz(p.freq)}</span><span class="p">周りより +${p.prominence.toFixed(0)} dB</span>
        <span class="n">${hearingNote(p.freq)}。波長 ${wavelengthMm(p.freq).toFixed(1)}mm</span>
      </button>`;
    })
    .join('')}</div>
    <div class="listen-row"><button class="btn" id="btn-hear">選んだ音を鳴らして確かめる(0.6秒)</button></div>`;
  el.querySelectorAll('.peak').forEach((b) =>
    b.addEventListener('click', () => {
      if (S.anc) return;
      S.selected = { ...S.peaks[+b.dataset.i] };
      onSelect();
      renderPeaks();
    }),
  );
  $('btn-hear').addEventListener('click', hearTone);
}

function hearTone() {
  if (!S.selected || S.anc) return;
  const o = S.ctx.createOscillator();
  const g = S.ctx.createGain();
  o.frequency.value = S.selected.freq;
  const t = S.ctx.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.04, t + 0.05);
  g.gain.setValueAtTime(0.04, t + 0.55);
  g.gain.linearRampToValueAtTime(0, t + 0.6);
  o.connect(g).connect(S.ctx.destination);
  o.start(t);
  o.stop(t + 0.65);
}

function onSelect() {
  const f = S.selected.freq;
  $('zone-text').textContent = `いま選んでいる ${(f / 1000).toFixed(1)}kHz ならマイクのまわり約 ${quietZoneMm(f).toFixed(1)}mm`;
  const b = $('btn-cancel');
  b.disabled = false;
  b.className = 'btn primary';
  b.textContent = `${fmtHz(f)} を打ち消してみる`;
  updateReport();
}

// ---------- 2. けしてみる ----------
const PHASE_LABEL = {
  listen: '① 騒音だけを聞いて、高さを0.01Hz単位まで合わせています…',
  probe: '② 小さなテスト音で、スピーカー→マイクの伝わり方を測っています…',
  adapt: '③ 打ち消し中(マイクで聞きながら合わせ続けています)',
  fail: '止まりました',
  stopped: '止めました',
};

$('btn-cancel').addEventListener('click', async () => {
  if (S.anc) return stopCancel();
  if (!S.selected) return;
  await S.ctx.resume();
  await S.ctx.audioWorklet.addModule(workletUrl);
  const node = new AudioWorkletNode(S.ctx, 'kiin-anc', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { freq: S.selected.freq, maxAmp: 0.3 },
  });
  S.src.connect(node);
  node.connect(S.ctx.destination);
  S.anc = node;
  S.redHist = [];
  S.bestRed = null;
  $('red').textContent = '—';
  $('cancel-live').hidden = false;
  const b = $('btn-cancel');
  b.className = 'btn danger';
  b.textContent = '止める';
  node.port.onmessage = (e) => onAncState(e.data);
});

function onAncState(m) {
  S.ancPhase = m.phase;
  const ph = $('phase');
  ph.textContent = m.phase === 'fail' ? `止まりました: ${m.message}` : PHASE_LABEL[m.phase] || m.phase;
  ph.classList.toggle('fail', m.phase === 'fail');
  if (m.phase === 'adapt') {
    S.redHist.push(m.reductionDb);
    if (S.redHist.length > 300) S.redHist.shift();
    const recent = S.redHist.slice(-10);
    const smooth = recent.reduce((s, v) => s + v, 0) / recent.length;
    $('red').textContent = smooth.toFixed(0);
    if (S.redHist.length > 20) S.bestRed = Math.max(S.bestRed ?? -Infinity, smooth);
  }
  $('cancel-meta').textContent = `追従中の周波数 ${m.freq.toFixed(2)} Hz ・ 打ち消し音の大きさ ${(20 * Math.log10(Math.max(m.amp, 1e-6))).toFixed(0)} dBFS`;
  drawRedGraph();
  if (m.phase === 'fail') {
    teardownAnc();
    const b = $('btn-cancel');
    b.className = 'btn primary';
    b.textContent = 'もう一度ためす';
  }
  updateReport();
}

function drawRedGraph() {
  const cv = $('red-graph');
  const { w, h, dpr } = fitCanvas(cv);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  const maxDb = 40;
  const y = (v) => h - (Math.max(0, Math.min(maxDb, v)) / maxDb) * (h - 6 * dpr) - 3 * dpr;
  g.strokeStyle = 'rgba(141,155,189,.2)';
  g.fillStyle = 'rgba(141,155,189,.7)';
  g.font = `${10 * dpr}px 'JetBrains Mono', monospace`;
  for (const v of [10, 20, 30]) {
    g.beginPath();
    g.moveTo(0, y(v));
    g.lineTo(w, y(v));
    g.stroke();
    g.fillText(`-${v}dB`, 4 * dpr, y(v) - 3 * dpr);
  }
  if (S.redHist.length < 2) return;
  g.strokeStyle = '#63f2a1';
  g.lineWidth = 2 * dpr;
  g.beginPath();
  S.redHist.forEach((v, i) => {
    const x = (i / 299) * w;
    i ? g.lineTo(x, y(v)) : g.moveTo(x, y(v));
  });
  g.stroke();
}

function teardownAnc() {
  if (!S.anc) return;
  try {
    S.anc.port.postMessage({ cmd: 'stop' });
    S.src.disconnect(S.anc);
    S.anc.disconnect();
  } catch {}
  S.anc = null;
}

function stopCancel() {
  teardownAnc();
  $('phase').textContent = PHASE_LABEL.stopped;
  const b = $('btn-cancel');
  b.className = 'btn primary';
  b.textContent = `${fmtHz(S.selected.freq)} をもう一度打ち消す`;
}

// ---------- 3. 報告メモ ----------
function updateReport() {
  if (!S.selected) return;
  $('report').value = makeReport({
    freq: S.selected.freq,
    prominence: S.selected.prominence,
    when: new Date(),
    place: $('place').value.trim(),
    cancelDb: S.bestRed != null && S.bestRed > 3 ? S.bestRed : null,
  });
  $('btn-copy').disabled = false;
}
$('place').addEventListener('input', updateReport);
$('btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('report').value);
    $('btn-copy').textContent = 'コピーしました';
  } catch {
    $('report').select();
    $('btn-copy').textContent = '選択しました。⌘C でコピーしてください';
  }
  setTimeout(() => ($('btn-copy').textContent = 'メモをコピー'), 2000);
});

// ヘッドレス検証用(開発時のみ)
if (import.meta.env.DEV) {
  window.__app = {
    get peaks() { return S.peaks; },
    get selected() { return S.selected; },
    get ancPhase() { return S.ancPhase; },
    get report() { return $('report').value; },
  };
}
