/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { IEnv } from '../typing';
import { setupWebSocketProxy } from './utils/proxy';

const DEFAULT_USER_ID = '7fa0c01f-eca2-45de-a885-6078ce26fcbe';
const DEFAULT_PROXY_IP = 'cdn.anycast.eu.org';

let userID = DEFAULT_USER_ID;

let proxyIP = DEFAULT_PROXY_IP;

if (!isValidUUID(userID)) {
	throw new Error('uuid is not valid');
}

function base64ToArrayBuffer(base64Str: string) {
	if (!base64Str) {
		return { error: null };
	}
	try {
		// go use modified Base64 for URL rfc4648 which js atob not support
		base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return { earlyData: arryBuffer.buffer, error: null };
	} catch (error) {
		return { error };
	}
}

async function httpRequestHandler(request: Request) {
	const url = new URL(request.url);
	switch (url.pathname) {
		case '/':
			return new Response(JSON.stringify(request.cf), { status: 200 });
		case `/${userID}`: {
			const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
			return new Response(`${vlessConfig}`, {
				status: 200,
				headers: {
					'Content-Type': 'text/plain;charset=utf-8',
				},
			});
		}
		default:
			return new Response('Not found', { status: 404 });
	}
}

async function vlessOverWebSocketHandler(request: Request) {
	// sec-websocket-protocol 通常用于协商 websocket 通信子协议，vless 使用 sec-websocket-protocol 前置部分数据的传输
	// https://www.v2fly.org/config/transport/websocket.html#websocketobject
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

	const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
	if (error) {
		console.error('early data header parse error', earlyDataHeader, error);
		return new Response('Sec-WebSocket-Protocol header is not valid', { status: 400 });
	}

	const webSocketPair = new WebSocketPair();
	const [client, server] = Object.values(webSocketPair);

	server.accept();

	setupWebSocketProxy(server, earlyData as ArrayBuffer, userID, proxyIP);

	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}

function isValidUUID(uuid: string) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

/**
 *
 * @param {string} userID
 * @param {string | null} hostName
 * @returns {string}
 */
function getVLESSConfig(userID: string, hostName: string | null) {
	const vlessMain = `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`;
	return `
################################################################
v2ray
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
################################################################
clash-meta
---------------------------------------------------------------
- type: vless
  name: ${hostName}
  server: ${hostName}
  port: 443
  uuid: ${userID}
  network: ws
  tls: true
  udp: false
  sni: ${hostName}
  client-fingerprint: chrome
  ws-opts:
    path: "/?ed=2048"
    headers:
      host: ${hostName}
---------------------------------------------------------------
################################################################
`;
}

const exportedHandler: ExportedHandler<IEnv> = {
	fetch: async function (request, env) {
		try {
			userID = env.UUID || DEFAULT_USER_ID;
			proxyIP = env.PROXYIP || DEFAULT_PROXY_IP;
			const upgradeHeader = request.headers.get('upgrade');
			if (upgradeHeader === 'websocket') {
				return await vlessOverWebSocketHandler(request);
			} else {
				return await httpRequestHandler(request);
			}
		} catch (err: any) {
			let e: Error = err;
			console.log('handle fetch error', e.toString());
			return new Response(e.toString());
		}
	},
};

export default exportedHandler;
