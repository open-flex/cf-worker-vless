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

import { connect } from 'cloudflare:sockets';
import { IEnv } from '../typing';
import { WS_READY_STATE } from './const';
import { decodeVlessPacket, safeCloseWebSocket } from './utils';

const DEFAULT_USER_ID = '7fa0c01f-eca2-45de-a885-6078ce26fcbe';
const DEFAULT_PROXY_IP = 'cdn.anycast.eu.org';

let userID = DEFAULT_USER_ID;

let proxyIP = DEFAULT_PROXY_IP;

if (!isValidUUID(userID)) {
	throw new Error('uuid is not valid');
}

export default {
	async fetch(request: Request, env: IEnv): Promise<Response> {
		try {
			userID = env.UUID || DEFAULT_USER_ID;
			proxyIP = env.PROXYIP || DEFAULT_PROXY_IP;
			const upgradeHeader = request.headers.get('upgrade');
			if (upgradeHeader === 'websocket') {
				return await vlessOverWSHandler(request);
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

async function vlessOverWSHandler(request: Request) {
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);

	webSocket.accept();

	let address = '';
	let portWithRandomLog = '';
	const log = (info: string, event?: string) => {
		console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
	};
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

	let remoteSocketWapper: { value: Socket | null } = {
		value: null,
	};
	let udpStreamWrite: ((chunk: any) => void) | null = null;
	let isDns = false;

	// ws --> remote
	readableWebSocketStream
		.pipeTo(
			new WritableStream({
				async write(chunk) {
					if (isDns && udpStreamWrite) {
						return udpStreamWrite(chunk);
					}
					if (remoteSocketWapper.value) {
						const writer = remoteSocketWapper.value.writable.getWriter();
						await writer.write(chunk);
						writer.releaseLock();
						return;
					}

					const {
						hasError,
						message,
						command,
						port = 443,
						addressValue: addressRemote = '',
						rawData,
						version,
					} = decodeVlessPacket(chunk, (uuid: string) => uuid === userID);
					if (hasError) {
						throw new Error(message); // cf seems has bug, controller.error will not end stream
					}
					address = addressRemote;
					const isUDP = command === 2;
					portWithRandomLog = `${port}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '} `;
					// if UDP but port not DNS port, close it
					if (isUDP) {
						if (port === 53) {
							isDns = true;
						} else {
							// controller.error('UDP proxy only enable for DNS which is port 53');
							throw new Error('UDP proxy only enable for DNS which is port 53'); // cf seems has bug, controller.error will not end stream
						}
					}
					// ["version", "附加信息长度 N"]
					const vlessResponseHeader = new Uint8Array([version!, 0]);

					// TODO: support udp here when cf runtime has udp support
					if (isDns) {
						const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader, log);
						udpStreamWrite = write;
						udpStreamWrite(rawData);
						return;
					}
					handleTCPOutBound(remoteSocketWapper, addressRemote, port, rawData!, webSocket, vlessResponseHeader, log);
				},
				close() {
					log(`readableWebSocketStream is close`);
				},
				abort(reason) {
					log(`readableWebSocketStream is abort`, JSON.stringify(reason));
				},
			})
		)
		.catch((err) => {
			log('readableWebSocketStream pipeTo error', err);
		});

	return new Response(null, {
		status: 101,
		// @ts-ignore
		webSocket: client,
	});
}

/**
 * Handles outbound TCP connections.
 */
async function handleTCPOutBound(
	remoteSocket: any,
	addressRemote: string,
	portRemote: number,
	rawClientData: ArrayBuffer,
	webSocket: WebSocket,
	vlessResponseHeader: Uint8Array,
	log: (info: string) => void
): Promise<void> {
	async function connectAndWrite(address: string, port: number) {
		const tcpSocket = connect({
			hostname: address,
			port: port,
		});
		remoteSocket.value = tcpSocket;
		log(`connected to ${address}:${port}`);
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData); // first write, nomal is tls client hello
		writer.releaseLock();
		return tcpSocket;
	}

	// if the cf connect tcp socket have no incoming data, we retry to redirect ip
	async function retry() {
		const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
		// no matter retry success or not, close websocket
		tcpSocket.closed
			.catch((error) => {
				console.log('retry tcpSocket closed error', error);
			})
			.finally(() => {
				safeCloseWebSocket(webSocket);
			});
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
	}

	const tcpSocket = await connectAndWrite(addressRemote, portRemote);

	// when remoteSocket is ready, pass to websocket
	// remote--> ws
	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

function makeReadableWebSocketStream(webSocketServer: WebSocket, earlyDataHeader: string, log: (info: string) => void) {
	let readableStreamCancel = false;
	const stream = new ReadableStream<ArrayBuffer>({
		start(controller) {
			webSocketServer.addEventListener('message', (event) => {
				if (readableStreamCancel) {
					return;
				}
				const message = event.data;
				controller.enqueue(message as ArrayBuffer);
			});

			// The event means that the client closed the client -> server stream.
			// However, the server -> client stream is still open until you call close() on the server side.
			// The WebSocket protocol says that a separate close message must be sent in each direction to fully close the socket.
			webSocketServer.addEventListener('close', () => {
				// client send close, need close server
				// if stream is cancel, skip controller.close
				safeCloseWebSocket(webSocketServer);
				if (readableStreamCancel) {
					return;
				}
				controller.close();
			});
			webSocketServer.addEventListener('error', (err) => {
				log('webSocketServer has error');
				controller.error(err);
			});
			// for ws 0rtt
			const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
			if (error) {
				controller.error(error);
			} else if (earlyData) {
				controller.enqueue(earlyData);
			}
		},

		pull(controller) {
			// if ws can stop read if stream is full, we can implement backpressure
			// https://streams.spec.whatwg.org/#example-rs-push-backpressure
		},
		cancel(reason) {
			// 1. pipe WritableStream has error, this cancel will called, so ws handle server close into here
			// 2. if readableStream is cancel, all controller.close/enqueue need skip,
			// 3. but from testing controller.error still work even if readableStream is cancel
			if (readableStreamCancel) {
				return;
			}
			log(`ReadableStream was canceled, due to ${reason}`);
			readableStreamCancel = true;
			safeCloseWebSocket(webSocketServer);
		},
	});

	return stream;
}

async function remoteSocketToWS(
	remoteSocket: Socket,
	webSocket: WebSocket,
	vlessResponseHeader: ArrayBuffer,
	retry: (() => Promise<void>) | null,
	log: (info: string) => void
) {
	// remote--> ws
	let vlessHeader: ArrayBuffer | null = vlessResponseHeader;
	let hasIncomingData = false; // check if remoteSocket has incoming data
	await remoteSocket.readable
		.pipeTo(
			new WritableStream({
				start() {},
				async write(chunk: Uint8Array, controller) {
					hasIncomingData = true;
					// remoteChunkCount++;
					if (webSocket.readyState !== WS_READY_STATE.OPEN) {
						controller.error('webSocket.readyState is not open, maybe close');
					}
					if (vlessHeader) {
						webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
						vlessHeader = null;
					} else {
						// seems no need rate limit this, CF seems fix this??..
						// if (remoteChunkCount > 20000) {
						// 	// cf one package is 4096 byte(4kb),  4096 * 20000 = 80M
						// 	await delay(1);
						// }
						webSocket.send(chunk);
					}
				},
				close() {
					log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
					// safeCloseWebSocket(webSocket); // no need server close websocket frist for some case will casue HTTP ERR_CONTENT_LENGTH_MISMATCH issue, client will send close event anyway.
				},
				abort(reason) {
					console.error(`remoteConnection!.readable abort`, reason);
				},
			})
		)
		.catch((error) => {
			console.error(`remoteSocketToWS has exception `, error.stack || error);
			safeCloseWebSocket(webSocket);
		});

	// seems is cf connect socket have error,
	// 1. Socket.closed will have error
	// 2. Socket.readable will be close without any data coming
	if (hasIncomingData === false && retry) {
		log(`retry`);
		retry();
	}
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

function isValidUUID(uuid: string) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

async function handleUDPOutBound(webSocket: WebSocket, vlessResponseHeader: ArrayBuffer, log: (info: string) => void) {
	let isVlessHeaderSent = false;
	const transformStream = new TransformStream({
		start(controller) {},
		transform(chunk, controller) {
			// udp message 2 byte is the the length of udp data
			// TODO: this should have bug, beacsue maybe udp chunk can be in two websocket message
			for (let index = 0; index < chunk.byteLength; ) {
				const lengthBuffer = chunk.slice(index, index + 2);
				const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
				const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
				index = index + 2 + udpPakcetLength;
				controller.enqueue(udpData);
			}
		},
		flush(controller) {},
	});

	// only handle dns udp for now
	transformStream.readable
		.pipeTo(
			new WritableStream({
				async write(chunk) {
					const resp = await fetch('https://1.1.1.1/dns-query', {
						method: 'POST',
						headers: {
							'content-type': 'application/dns-message',
						},
						body: chunk,
					});
					const dnsQueryResult = await resp.arrayBuffer();
					const udpSize = dnsQueryResult.byteLength;
					// console.log([...new Uint8Array(dnsQueryResult)].map((x) => x.toString(16)));
					const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
					if (webSocket.readyState === WS_READY_STATE.OPEN) {
						log(`doh success and dns message length is ${udpSize}`);
						if (isVlessHeaderSent) {
							webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
						} else {
							webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
							isVlessHeaderSent = true;
						}
					}
				},
			})
		)
		.catch((error) => {
			log('dns udp has error' + error);
		});

	const writer = transformStream.writable.getWriter();

	return {
		/**
		 *
		 * @param {Uint8Array} chunk
		 */
		write(chunk: any) {
			writer.write(chunk);
		},
	};
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
