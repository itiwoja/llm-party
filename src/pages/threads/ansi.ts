/** 端末の出力から制御文字を取り除く。色などは付けず、文字だけにする（HTML としては解釈しない） */
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const OTHER_ESC = /\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripAnsi(text: string): string {
  return text.replace(OSC, "").replace(CSI, "").replace(OTHER_ESC, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(CONTROL, "");
}
