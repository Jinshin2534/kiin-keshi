// AudioWorklet: マイクを検波して、打ち消し音をスピーカーへ。中身は src/lib/canceller.js (テスト済み)。
import { createEngine } from '../lib/canceller.js';

class AncProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { freq, maxAmp } = options.processorOptions;
    // sampleRate は AudioWorkletGlobalScope のグローバル
    this.eng = createEngine({ sampleRate, freq, maxAmp });
    this.tick = 0;
    this.port.onmessage = (e) => {
      if (e.data?.cmd === 'stop') this.eng.canceller.stop();
    };
  }

  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0];
    const st = this.eng.process(inp, out[0]);
    for (let c = 1; c < out.length; c++) out[c].set(out[0]);
    if (++this.tick % 32 === 0) {
      this.port.postMessage({
        phase: st.phase,
        freq: st.freq,
        reductionDb: st.reductionDb,
        amp: Math.hypot(st.W.re, st.W.im),
        message: st.message,
      });
    }
    return st.phase !== 'stopped';
  }
}

registerProcessor('kiin-anc', AncProcessor);
