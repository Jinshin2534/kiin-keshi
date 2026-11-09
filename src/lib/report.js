// 先生・事務室に渡す「報告メモ」を作る。測った事実だけを書き、原因は「よくある例」として添える。

const pad = (n) => String(n).padStart(2, '0');
export function formatWhen(d) {
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * @param {{freq:number, prominence:number, when:Date, place?:string, cancelDb?:number|null}} m
 */
export function makeReport({ freq, prominence, when, place = '', cancelDb = null }) {
  const khz = (freq / 1000).toFixed(2);
  const lines = [
    `【教室の高い音(キーン)について】`,
    `場所: ${place || '(教室名)'}`,
    `日時: ${formatWhen(when)}`,
    `測定: ノートPCのマイクで、約 ${khz}kHz の一定の高さの音が、周りの雑音より約 ${Math.round(prominence)}dB 目立って出ていました。`,
    `この高さの音は若い人ほどよく聞こえ、大人には聞こえないことがあります。授業中ずっと鳴っていて集中しにくいです。`,
    ``,
    `よくある原因(確認をお願いしたい点):`,
    `・アンプ/スピーカーの電源が入ったまま、何も再生していない`,
    `・ケーブルが半分抜けている、つないでいない入力の音量が上がっている`,
    `・プロジェクターやワイヤレスマイク受信機の音声出力`,
    `使っていない時間にアンプの音量を下げるか電源を切ると、止まることが多いです。`,
  ];
  if (cancelDb != null) {
    lines.push('', `(参考: 打ち消し音で試したところ、マイクの位置だけで ${cancelDb.toFixed(0)}dB 下がりました。ただし静かになるのはマイクのまわり数mmだけで、耳の位置では効きません。音源側で止めるのが確実です)`);
  }
  return lines.join('\n');
}
