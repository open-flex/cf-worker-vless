import { WS_READY_STATE } from '../const';

export function decodeUuid(chunk: ArrayBuffer) {
  const hexString = new Uint8Array(chunk).reduce((acc, cur) => acc + cur.toString(16).padStart(2, '0'), '');
  const s = hexString.match(/.{1,4}/g) || [];
  return `${s[0]}${s[1]}-${s[2]}-${s[3]}-${s[4]}-${s[5]}${s[6]}${s[7]}`;
}
