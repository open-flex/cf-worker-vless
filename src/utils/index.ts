import { WS_READY_STATE } from '../const';

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

function decodeUuid(chunk: ArrayBuffer) {
	const hexString = new Uint8Array(chunk).reduce((acc, cur) => acc + cur.toString(16).padStart(2, '0'), '');
	const s = hexString.match(/.{1,4}/g) || [];
	return `${s[0]}${s[1]}-${s[2]}-${s[3]}-${s[4]}-${s[5]}${s[6]}${s[7]}`;
}

/**
 * Vless 请求包结构 https://xtls.github.io/development/protocols/vless.html
 * -----------------------------------------------------------------------------------------------------------
 * |  1 字节  | 16 字节 |    1 字节    |       M 字节      | 1 字节  | 2 字节 |  1 字节  | S 字节 |  X 字节  |
 * | 协议版本 |	 UUID   | 附加信息长度 | 附加信息 ProtoBuf |  指令   |	端口  | 地址类型 |  地址  | 请求数据 |
 * -----------------------------------------------------------------------------------------------------------
 */
export function decodeVlessPacket(vlessBuffer: ArrayBuffer, uuidValidator?: (uuid: string) => boolean) {
	// 最小包结构：1（协议） + 16（UUID） + 1（附加信息长度） + 0（附加信息长度为0） + 1（指令） + 2（端口） + 1（地址类型） + 4（IPv4 地址） + 0
	if (vlessBuffer.byteLength < 26) {
		return {
			hasError: true,
			message: 'invalid data',
		};
	}
	const version = new Uint8Array(vlessBuffer.slice(0, 1))[0];
	const uuid = decodeUuid(vlessBuffer.slice(1, 17));
	if (uuidValidator && !uuidValidator(uuid)) {
		return {
			hasError: true,
			message: `invalid user: uuidBuffer: ${new Uint8Array(vlessBuffer.slice(1, 17))}, uuid: ${uuid}`,
		};
	}

	// 附加信息暂时没用
	const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];

	// 0x01 TCP, 0x02 UDP, 0x03 MUX
	const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

	const portIndex = 18 + optLength + 1;
	// port is big-Endian in raw data etc 80 == 0x005d
	const port = new DataView(vlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);

	const addressTypeIndex = portIndex + 2;
	// 1 --> ipv4  addressLength =4
	// 2 --> domain name addressLength=addressBuffer[1]
	// 3 --> ipv6  addressLength =16
	const addressType = new Uint8Array(vlessBuffer.slice(addressTypeIndex, addressTypeIndex + 1))[0];

	let addressLength = 0;
	let addressValueIndex = addressTypeIndex + 1;
	let addressValue = '';
	switch (addressType) {
		case 1:
			addressLength = 4;
			addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
			break;
		case 2:
			addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			break;
		case 3:
			addressLength = 16;
			const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			// 2001:0db8:85a3:0000:0000:8a2e:0370:7334
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(i * 2).toString(16));
			}
			addressValue = ipv6.join(':');
			break;
		default:
			return {
				hasError: true,
				message: `invild  addressType is ${addressType}`,
			};
	}
	if (!addressValue) {
		return {
			hasError: true,
			message: `addressValue is empty, addressType is ${addressType}`,
		};
	}

	const rawData = vlessBuffer.slice(addressValueIndex + addressLength);

	return {
		hasError: false,
		version,
		command,
		addressType,
		addressValue,
		port,
		rawData,
	};
}
