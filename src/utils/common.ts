import { WS_READY_STATE } from '../const';

export function decodeUuid(chunk: ArrayBuffer) {
	const hexString = new Uint8Array(chunk).reduce((acc, cur) => acc + cur.toString(16).padStart(2, '0'), '');
	const s = hexString.match(/.{1,4}/g) || [];
	return `${s[0]}${s[1]}-${s[2]}-${s[3]}-${s[4]}-${s[5]}${s[6]}${s[7]}`;
}

// https://developer.mozilla.org/zh-CN/docs/Web/API/WebSocket/close
// 根据 mdn 文档：
//     1. 仅调用 close 方法是传入了错误的 code 或 reason 时才可能会抛出异常
//     2. 调用 close 方法前不需要进行状态判断
export function safeCloseWebSocket(socket: WebSocket) {
	try {
		if (socket.readyState === WS_READY_STATE.OPEN || socket.readyState === WS_READY_STATE.CLOSING) {
			socket.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}
