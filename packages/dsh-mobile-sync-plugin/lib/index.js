import QRCode from "qrcode";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
//#region src/http-utils.ts
function requireMethod(req, res, method) {
	if (req.method !== method) {
		writeJson(res, 405, { error: `仅支持 ${method}` });
		return false;
	}
	return true;
}
function readJsonBody(req) {
	return new Promise((resolve) => {
		let buf = "";
		req.on("data", (c) => {
			buf += c.toString();
			if (buf.length > 5e6) req.destroy();
		});
		req.on("end", () => {
			try {
				resolve(buf ? JSON.parse(buf) : {});
			} catch {
				resolve({});
			}
		});
		req.on("error", () => resolve({}));
	});
}
function writeJson(res, code, data) {
	const body = JSON.stringify(data);
	res.writeHead(code, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(body);
}
function writeStatic(res, status, type, body) {
	res.writeHead(status, {
		"content-type": type + "; charset=utf-8",
		"cache-control": "no-cache",
		"referrer-policy": "no-referrer"
	});
	res.end(body);
}
function openSSE(res) {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		"connection": "keep-alive",
		"x-accel-buffering": "no"
	});
	const stream = {
		res,
		closed: false
	};
	res.on("close", () => {
		stream.closed = true;
	});
	return stream;
}
function pushSSE(stream, event, data) {
	if (stream.closed) return;
	try {
		stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	} catch {}
}
//#endregion
//#region src/pairing.ts
const TOKEN_TTL_MS = 3e5;
const PAIRING_TTL_MS = 6048e5;
const HEARTBEAT_TTL_MS = 9e4;
var PairingService = class {
	baseUrl;
	publicBaseUrl;
	currentToken = null;
	tokenExpiry = 0;
	devices = /* @__PURE__ */ new Map();
	statusStreams = /* @__PURE__ */ new Set();
	constructor(baseUrl, publicBaseUrl) {
		this.baseUrl = baseUrl;
		this.publicBaseUrl = publicBaseUrl;
	}
	origin() {
		if (this.publicBaseUrl) return this.publicBaseUrl.replace(/\/+$/, "");
		return this.baseUrl;
	}
	genToken() {
		return "pair-" + cryptoRandom() + "-" + Date.now().toString(36);
	}
	genCookie() {
		return "dsh-msc-" + cryptoRandom() + "-" + Date.now().toString(36);
	}
	/** 生成 QR 数据 URL（含一次性 token 的配对链接） */
	async issueToken(workspaceParam) {
		this.currentToken = this.genToken();
		this.tokenExpiry = Date.now() + TOKEN_TTL_MS;
		const url = new URL(this.origin() + "/m/pair");
		url.searchParams.set("token", this.currentToken);
		if (workspaceParam) url.searchParams.set("workspace", workspaceParam);
		const qrUrl = url.toString();
		return {
			qrUrl,
			qrDataUrl: await QRCode.toDataURL(qrUrl, {
				margin: 2,
				width: 320,
				color: {
					dark: "#1a1a1a",
					light: "#ffffff"
				}
			}),
			tokenExpiry: this.tokenExpiry
		};
	}
	/** 手机端扫码后提交 token → 配对成功则获得 device cookie */
	accept(token, label) {
		if (!this.currentToken || token !== this.currentToken) return {
			ok: false,
			error: "token 无效或已刷新"
		};
		if (Date.now() > this.tokenExpiry) {
			this.currentToken = null;
			return {
				ok: false,
				error: "token 已过期"
			};
		}
		this.currentToken = null;
		const cookie = this.genCookie();
		const now = Date.now();
		this.devices.set(cookie, {
			cookie,
			label: label || "手机设备",
			pairedAt: (/* @__PURE__ */ new Date()).toISOString(),
			lastHeartbeat: now,
			online: true
		});
		this.broadcast();
		return {
			ok: true,
			cookie
		};
	}
	/** 心跳：更新在线状态。配对未过期则自动恢复在线（无需重新扫码） */
	heartbeat(cookie) {
		const dev = this.devices.get(cookie);
		if (!dev) return false;
		if (Date.now() - new Date(dev.pairedAt).getTime() > PAIRING_TTL_MS) {
			this.devices.delete(cookie);
			this.broadcast();
			return false;
		}
		dev.lastHeartbeat = Date.now();
		dev.online = true;
		this.broadcast();
		return true;
	}
	/** 验证设备 cookie 是否已配对（在 7 天配对有效期内） */
	isPaired(cookie) {
		if (!cookie) return false;
		const dev = this.devices.get(cookie);
		if (!dev) return false;
		if (Date.now() - new Date(dev.pairedAt).getTime() > PAIRING_TTL_MS) {
			this.devices.delete(cookie);
			this.broadcast();
			return false;
		}
		return true;
	}
	/** 撤销所有设备 + 当前 token */
	stop() {
		this.currentToken = null;
		this.tokenExpiry = 0;
		this.devices.clear();
		this.broadcast();
	}
	/** 快照供面板显示（更新在线/离线状态，但不删除已配对设备） */
	snapshot() {
		const now = Date.now();
		const activeDevices = [];
		for (const [k, dev] of this.devices) {
			if (now - new Date(dev.pairedAt).getTime() > PAIRING_TTL_MS) {
				this.devices.delete(k);
				continue;
			}
			dev.online = now - dev.lastHeartbeat <= HEARTBEAT_TTL_MS;
			activeDevices.push(dev);
		}
		return {
			state: activeDevices.filter((d) => d.online).length > 0 ? "connected" : activeDevices.length > 0 ? "disconnected" : "waiting",
			devices: activeDevices
		};
	}
	/** 桌面端状态 SSE */
	openStatusStream(res) {
		const stream = openSSE(res);
		this.statusStreams.add(stream);
		pushSSE(stream, "state", this.snapshot());
		stream.res.on("close", () => {
			this.statusStreams.delete(stream);
		});
		const ka = setInterval(() => {
			if (!stream.closed) try {
				stream.res.write(": keepalive\n\n");
			} catch {}
			else clearInterval(ka);
		}, 25e3);
	}
	broadcast() {
		const snap = this.snapshot();
		for (const s of this.statusStreams) if (!s.closed) pushSSE(s, "state", snap);
	}
	/** 更新公网 URL（配置热加载） */
	updatePublicUrl(url) {
		this.publicBaseUrl = url;
	}
};
function cryptoRandom() {
	return Array.from(crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(12))).map((b) => b.toString(16).padStart(2, "0")).join("");
}
//#endregion
//#region src/dsh-client.ts
function isoTime(t) {
	const n = Number(t);
	return new Date(Number.isFinite(n) && n > 0 ? n : Date.now()).toISOString();
}
async function fetchRpc(apiProxy, method, payload = {}) {
	const result = await apiProxy.callRpc(method, payload);
	if (!result?.ok) throw new Error(method + " 失败: " + JSON.stringify(result?.error || {}).slice(0, 200));
	return result.value;
}
const listWorkspaces = (apiProxy) => fetchRpc(apiProxy, "workspace.list", {}).then((v) => v.items || []);
const listSessions = (apiProxy) => fetchRpc(apiProxy, "session.list", {}).then((v) => v.items || []);
function createSession(apiProxy, cwd, agentPreset = "standard") {
	return fetchRpc(apiProxy, "session.create", {
		cwd,
		agentPreset
	}).then((v) => v.sessionId);
}
function getHistory(apiProxy, sessionId) {
	return fetchRpc(apiProxy, "session.history", { sessionId }).then((v) => v.events || []);
}
function promptSession(apiProxy, sessionId, content) {
	return fetchRpc(apiProxy, "session.prompt", {
		sessionId,
		mode: "queue",
		content
	}).then(() => {});
}
function cancelSession(apiProxy, sessionId) {
	return fetchRpc(apiProxy, "session.cancel", { sessionId }).catch(() => {});
}
function selectModel(apiProxy, sessionId, model) {
	return fetchRpc(apiProxy, "session.selectModel", {
		sessionId,
		model
	}).then(() => {});
}
function listModels(apiProxy, sessionId) {
	return fetchRpc(apiProxy, "session.models", { sessionId }).catch(() => ({
		items: [],
		groups: []
	}));
}
function summarizeArgs(argsJson) {
	let obj = null;
	try {
		obj = JSON.parse(argsJson);
	} catch {}
	if (obj && typeof obj === "object") {
		for (const k of [
			"path",
			"file_path",
			"filePath",
			"file",
			"cwd",
			"directory",
			"dir",
			"src",
			"dest",
			"target",
			"command",
			"name",
			"url",
			"text",
			"query"
		]) {
			const v = obj[k];
			if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
			if (typeof v === "number") return String(v);
		}
		return JSON.stringify(obj).slice(0, 120);
	}
	return String(argsJson).slice(0, 120);
}
function eventToStreamItem(ev) {
	if (!ev || typeof ev !== "object") return null;
	const type = ev.type;
	const data = ev.data || {};
	const item = {
		seq: Number(ev.seq) || 0,
		type,
		kind: "other",
		time: isoTime(ev.time)
	};
	if (typeof data.step === "number") item.step = data.step;
	if (typeof data.turn === "number") item.turn = data.turn;
	let text;
	if (type === "assistant/chunk") {
		const c = data.chunk;
		if (c && typeof c === "object") {
			if (c.type === "text-delta" && typeof c.text === "string") {
				text = c.text;
				item.kind = "text";
				item.subtype = "text";
			} else if (c.type === "reasoning-delta" && typeof c.text === "string") {
				text = c.text;
				item.kind = "thinking";
				item.subtype = "reasoning";
			} else if (c.type === "tool-call-delta" && typeof c.name === "string") {
				text = c.name;
				item.kind = "tool";
				item.subtype = "tool";
			} else if (c.type === "usage" && c.usage) {
				item.kind = "usage";
				item.usage = {
					input: c.usage.inputTokens,
					output: c.usage.outputTokens,
					cacheRead: c.usage.cacheReadTokens
				};
			}
		}
	} else if (type === "assistant/message" || type === "user/message") {
		const content = type === "assistant/message" ? data.message?.content : data.content;
		if (Array.isArray(content)) {
			const t = content.filter((c) => c?.type === "text").map((c) => c.text || "").join("");
			if (t) {
				text = t;
				item.kind = "text";
			}
		}
	} else if (type === "tool/call") {
		if (data.name) {
			text = String(data.name);
			item.kind = "tool";
		}
		if (data.callId) item.callId = String(data.callId);
		if (data.arguments) {
			item.arguments = String(data.arguments);
			item.argsSummary = summarizeArgs(data.arguments);
		}
	} else if (type === "tool/result") {
		const msg = data.message;
		if (msg) {
			const texts = [];
			const collect = (arr) => {
				for (const c of arr || []) {
					if (!c || typeof c !== "object") continue;
					if (c.type === "text" && typeof c.text === "string") texts.push(c.text);
					else if (Array.isArray(c.content)) collect(c.content);
				}
			};
			collect(Array.isArray(msg.content) ? msg.content : []);
			const t = texts.join("");
			const callId = msg.callId || msg.source?.callId;
			if (callId) item.callId = String(callId);
			if (msg.isError !== void 0) item.isError = !!msg.isError;
			if (t) {
				text = t;
				item.kind = "tool-result";
				item.result = t;
			}
		}
	} else if (type === "turn/end") item.kind = "done";
	else if (type === "step/start") item.kind = "step-start";
	else if (type === "step/end") item.kind = "step-end";
	if (text !== void 0) item.text = text;
	return item;
}
function historyToMessages(events) {
	const items = [];
	const isNoise = (t) => /^\s*<(system-reminder|runtime-context|compacted-summary)>/.test(String(t || ""));
	for (const ev of events || []) {
		const e = ev?.event;
		if (!e) continue;
		const data = e.data || {};
		if (e.type === "user/message" && Array.isArray(data.content)) {
			const text = data.content.filter((c) => c?.type === "text").map((c) => c.text || "").join("");
			if (text && !isNoise(text)) items.push({
				role: "user",
				text,
				time: isoTime(e.time)
			});
		} else if (e.type === "assistant/message") {
			const content = data.message?.content;
			if (Array.isArray(content)) {
				const entry = {
					role: "assistant",
					text: content.filter((c) => c?.type === "text").map((c) => c.text || "").join(""),
					time: isoTime(e.time)
				};
				if (data.message?.id) entry.messageId = String(data.message.id);
				items.push(entry);
			}
		} else if (e.type === "tool/call" && data.name) {
			const entry = {
				role: "tool",
				text: String(data.name),
				time: isoTime(e.time)
			};
			if (data.callId) entry.callId = String(data.callId);
			if (data.arguments) {
				entry.arguments = String(data.arguments);
				entry.argsSummary = summarizeArgs(data.arguments);
			}
			items.push(entry);
		} else if (e.type === "tool/result") {
			const msg = data.message || {};
			const callId = msg.callId || msg.source?.callId;
			const texts = [];
			const collect = (arr) => {
				for (const c of arr || []) {
					if (!c || typeof c !== "object") continue;
					if (c.type === "text" && typeof c.text === "string") texts.push(c.text);
					else if (Array.isArray(c.content)) collect(c.content);
				}
			};
			collect(Array.isArray(msg.content) ? msg.content : []);
			const result = texts.join("");
			const isError = !!msg.isError;
			if (callId) {
				const target = items.filter((x) => x.role === "tool" && x.callId === callId);
				if (target.length) {
					target[target.length - 1].result = result;
					target[target.length - 1].isError = isError;
					continue;
				}
			}
			if (result) items.push({
				role: "tool-result",
				text: result,
				isError,
				time: isoTime(e.time)
			});
		}
	}
	return items;
}
function normPath(p) {
	return String(p || "").replace(/\\/g, "/").toLowerCase();
}
function baseName(p) {
	const s = String(p || "").replace(/[\\/]+$/, "");
	const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
	return i >= 0 ? s.slice(i + 1) : s || "未命名";
}
//#endregion
//#region src/event-store.ts
const MAX_EVENTS_PER_SESSION = 200;
const MAX_SESSIONS = 200;
const HISTORY_COOLDOWN_MS = 5e3;
const MAX_PENDING = 50;
function createEventStore(opts) {
	const { dshBaseUrl, apiProxy } = opts;
	const eventsBySession = /* @__PURE__ */ new Map();
	const subscribedSeq = /* @__PURE__ */ new Map();
	const lastHistoryFetch = /* @__PURE__ */ new Map();
	const pending = /* @__PURE__ */ new Map();
	const sseClients = /* @__PURE__ */ new Set();
	let state = "stopped";
	let generation = 0;
	let retryMs = 1e3;
	let retryTimer = null;
	let activeWs = null;
	function notify(n) {
		for (const c of sseClients) if (!c.stream.closed) pushSSE(c.stream, "__pending", n);
	}
	function pushEvent(sessionId, item) {
		let arr = eventsBySession.get(sessionId);
		if (!arr) {
			if (eventsBySession.size >= MAX_SESSIONS) {
				const k = eventsBySession.keys().next().value;
				if (k !== void 0) eventsBySession.delete(k);
			}
			arr = [];
			eventsBySession.set(sessionId, arr);
		} else {
			eventsBySession.delete(sessionId);
			eventsBySession.set(sessionId, arr);
		}
		const last = arr.length ? arr[arr.length - 1].seq : -1;
		if (item.seq <= last) return;
		arr.push(item);
		if (arr.length > MAX_EVENTS_PER_SESSION) arr.splice(0, arr.length - MAX_EVENTS_PER_SESSION);
		for (const c of sseClients) if (c.sessionId === sessionId && !c.stream.closed) pushSSE(c.stream, sessionId, item);
	}
	async function getEvents(sessionId, afterSeq = 0) {
		const sid = String(sessionId || "").trim();
		const after = Number(afterSeq) || 0;
		if (!sid) return {
			items: [],
			lastSeq: after
		};
		let arr = eventsBySession.get(sid) || [];
		const last = arr.length ? arr[arr.length - 1].seq : -1;
		const watermark = subscribedSeq.get(sid);
		const nothingNew = watermark !== void 0 && after >= watermark;
		if ((arr.length === 0 || after > last) && !nothingNew && Date.now() - (lastHistoryFetch.get(sid) || 0) >= HISTORY_COOLDOWN_MS) {
			lastHistoryFetch.set(sid, Date.now());
			try {
				const items = (await fetchRpc(apiProxy, "session.history", { sessionId: sid }) || []).map((ev) => eventToStreamItem(ev?.event)).filter((i) => !!i && i.seq > after).slice(-200);
				for (const it of items) pushEvent(sid, it);
				arr = eventsBySession.get(sid) || [];
			} catch {}
		}
		return {
			items: arr.filter((i) => i.seq > after),
			lastSeq: arr.length ? arr[arr.length - 1].seq : after
		};
	}
	function evictOldest() {
		while (pending.size > MAX_PENDING) {
			const k = pending.keys().next().value;
			if (k === void 0) break;
			pending.delete(k);
		}
	}
	function ingest(frame) {
		if (!frame || typeof frame !== "object") return;
		const p = frame.payload;
		if (frame.method === "session/event" && p?.sessionId && p?.event) {
			const item = eventToStreamItem(p.event);
			if (item) pushEvent(String(p.sessionId), item);
			return;
		}
		if (frame.method === "session/subscribed" && p?.sessionId) {
			subscribedSeq.set(String(p.sessionId), Number(p.lastSeq) || 0);
			return;
		}
		if (frame.method === "approval/resolved" || p?.type === "approval/resolved") {
			pending.delete(String(p?.approvalId || ""));
			return;
		}
		if (frame.method === "question/resolved" || p?.type === "question/resolved") {
			pending.delete("q:" + String(p?.questionRpcId || ""));
			return;
		}
		if (frame.method === "question/requested" || p?.type === "question/requested") {
			const rpcId = String(frame.rpcId || p?.rpcId || "");
			if (!rpcId) return;
			pending.set("q:" + rpcId, {
				kind: "question",
				rpcId,
				key: "q:" + rpcId,
				sessionId: String(p?.sessionId || ""),
				questions: Array.isArray(p?.questions) ? p.questions : [],
				receivedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			evictOldest();
			notify({ kind: "question" });
			return;
		}
		if (!(frame.method === "approval/requested" || p?.type === "approval/requested") || !p) return;
		const approvalId = String(p.approvalId || frame.rpcId || "");
		if (!approvalId) return;
		pending.set(approvalId, {
			kind: "approval",
			rpcId: frame.rpcId,
			key: approvalId,
			sessionId: String(p.sessionId || ""),
			approvalId,
			toolName: p.toolName,
			callId: p.callId,
			reason: p.reason,
			receivedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		evictOldest();
		notify({ kind: "approval" });
	}
	function listPending() {
		return [...pending.values()].reverse();
	}
	async function respond({ approvalId, outcome, key, answer }) {
		const rec = key ? pending.get(key) : approvalId ? pending.get(approvalId) : void 0;
		if (!rec) return {
			ok: false,
			error: "未知请求（可能已处理或已过期）"
		};
		let value;
		if (rec.kind === "question") {
			if (!answer || !Array.isArray(answer.answers) || answer.answers.length === 0) return {
				ok: false,
				error: "answer 须为 {answers:[{id,selected,...}]}"
			};
			value = {
				sessionId: rec.sessionId,
				answer
			};
		} else {
			if (outcome !== "allowed-once" && outcome !== "rejected") return {
				ok: false,
				error: "outcome 只允许 allowed-once / rejected"
			};
			value = {
				sessionId: rec.sessionId,
				approvalId: rec.approvalId,
				outcome
			};
		}
		try {
			await fetch(dshBaseUrl + "/api/respond", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					type: "client-response",
					rpcId: rec.rpcId,
					result: {
						ok: true,
						value
					}
				})
			});
		} catch (e) {
			return {
				ok: false,
				error: "respond 请求失败: " + String(e)
			};
		}
		pending.delete(rec.key);
		notify({
			kind: "resolved",
			key: rec.key
		});
		return { ok: true };
	}
	function scheduleReconnect(gen) {
		if (state !== "running" || gen !== generation || retryTimer) return;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			connect(gen).catch(() => {});
		}, retryMs);
		retryMs = Math.min(retryMs * 2, 3e4);
	}
	async function connect(gen) {
		if (state !== "running" || gen !== generation) return;
		try {
			const wsUrl = dshBaseUrl.replace(/^http/, "ws") + "/api/events.mux";
			const ws = new WebSocket(wsUrl);
			const watchdog = setTimeout(() => {
				if (ws.readyState === WebSocket.CONNECTING) try {
					ws.close();
				} catch {}
			}, 1e4);
			ws.onopen = () => {
				clearTimeout(watchdog);
				retryMs = 1e3;
			};
			ws.onmessage = (e) => {
				if (state !== "running" || gen !== generation) return;
				try {
					ingest(JSON.parse(String(e.data)));
				} catch {}
			};
			ws.onclose = () => {
				clearTimeout(watchdog);
				scheduleReconnect(gen);
			};
			ws.onerror = () => {
				clearTimeout(watchdog);
				try {
					ws.close();
				} catch {}
				scheduleReconnect(gen);
			};
			activeWs = ws;
			ws.addEventListener("close", () => {
				if (activeWs === ws) activeWs = null;
			});
		} catch {
			scheduleReconnect(gen);
		}
	}
	function start() {
		if (state === "running") return;
		state = "running";
		generation += 1;
		retryMs = 1e3;
		connect(generation).catch(() => {});
	}
	function stop() {
		state = "stopped";
		generation += 1;
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
		if (activeWs) {
			const s = activeWs;
			activeWs = null;
			try {
				s.onopen = s.onmessage = s.onerror = s.onclose = null;
				s.close();
			} catch {}
		}
		for (const c of sseClients) if (!c.stream.closed) try {
			c.stream.res.end();
		} catch {}
		sseClients.clear();
	}
	function addSseClient(stream, sessionId) {
		const entry = {
			stream,
			sessionId
		};
		sseClients.add(entry);
		stream.res.on("close", () => sseClients.delete(entry));
	}
	return {
		start,
		stop,
		getEvents,
		listPending,
		respond,
		addSseClient
	};
}
//#endregion
//#region src/routes.ts
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE_RPC_ALLOW = /* @__PURE__ */ new Set([
	"workspace.list",
	"session.list",
	"session.create",
	"session.history",
	"session.prompt",
	"session.cancel",
	"session.models",
	"session.selectModel"
]);
function getCookie(req) {
	const match = (req.headers?.cookie || "").match(/dsh-msc-[^;]+/);
	return match ? match[0].trim() : void 0;
}
function isLoopback(req) {
	const addr = req.socket?.remoteAddress || "";
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
function makePairRoutes(pairing, workspaceParam) {
	return [
		{
			kind: "exact",
			path: "/api/pair/issue",
			handler: async (req, res) => {
				if (!isLoopback(req)) return writeJson(res, 403, { error: "配对面板仅限本机使用" });
				if (!requireMethod(req, res, "POST")) return;
				try {
					writeJson(res, 200, await pairing.issueToken(workspaceParam));
				} catch (e) {
					writeJson(res, 500, { error: String(e.message) });
				}
			}
		},
		{
			kind: "exact",
			path: "/api/pair/accept",
			handler: async (req, res) => {
				if (!requireMethod(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const result = pairing.accept(String(body.token || ""), String(body.label || ""));
				if (result.ok && result.cookie) {
					res.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"set-cookie": `dsh-msc=${result.cookie}; HttpOnly; Path=/m; SameSite=Lax; Max-Age=604800`,
						"cache-control": "no-store"
					});
					res.end(JSON.stringify({ ok: true }));
				} else writeJson(res, 403, {
					ok: false,
					error: result.error
				});
			}
		},
		{
			kind: "exact",
			path: "/api/pair/heartbeat",
			handler: async (req, res) => {
				if (!requireMethod(req, res, "POST")) return;
				const ok = pairing.heartbeat(getCookie(req) || "");
				writeJson(res, ok ? 200 : 403, { ok });
			}
		},
		{
			kind: "exact",
			path: "/api/pair/stop",
			handler: async (req, res) => {
				if (!isLoopback(req)) return writeJson(res, 403, { error: "仅限本机" });
				if (!requireMethod(req, res, "POST")) return;
				pairing.stop();
				writeJson(res, 200, { ok: true });
			}
		},
		{
			kind: "exact",
			path: "/api/pair/status",
			handler: (req, res) => {
				if (!isLoopback(req)) return writeJson(res, 403, { error: "仅限本机" });
				if (!requireMethod(req, res, "GET")) return;
				pairing.openStatusStream(res);
			}
		}
	];
}
function makeMobileApiRoutes(pairing, eventStore, apiProxy, defaultCwd) {
	const requireMobile = (req, res) => {
		if (!pairing.isPaired(getCookie(req))) {
			writeJson(res, 403, { error: "设备未配对或已离线" });
			return false;
		}
		return true;
	};
	return [
		{
			kind: "exact",
			path: "/m/api/rpc",
			handler: async (req, res) => {
				if (!requireMethod(req, res, "POST") || !requireMobile(req, res)) return;
				const { method, payload } = await readJsonBody(req);
				const m = String(method || "");
				if (!MOBILE_RPC_ALLOW.has(m)) return writeJson(res, 403, { error: `方法 ${m} 不在手机端白名单` });
				try {
					writeJson(res, 200, {
						ok: true,
						value: await fetchRpc(apiProxy, m, payload || {})
					});
				} catch (e) {
					writeJson(res, 502, {
						ok: false,
						error: e.message
					});
				}
			}
		},
		{
			kind: "exact",
			path: "/m/api/workspaces",
			handler: async (req, res) => {
				if (!requireMethod(req, res, "GET") || !requireMobile(req, res)) return;
				try {
					const [ws, ss] = await Promise.all([listWorkspaces(apiProxy), listSessions(apiProxy)]);
					const matched = /* @__PURE__ */ new Map();
					for (const w of ws) matched.set(w.workspaceId, new Set((w.sessionIds || []).filter(Boolean)));
					const sorted = [...ws].sort((a, b) => normPath(b.path).length - normPath(a.path).length);
					for (const s of ss) {
						const cwd = normPath(s.cwd);
						if (!cwd) continue;
						const w = sorted.find((x) => {
							const p = normPath(x.path);
							return cwd === p || cwd.startsWith(p + "/");
						});
						if (w) {
							const set = matched.get(w.workspaceId);
							if (set) set.add(s.sessionId);
						}
					}
					writeJson(res, 200, { items: ws.map((w) => ({
						workspaceId: w.workspaceId,
						path: w.path,
						title: w.title || null,
						sessionCount: (matched.get(w.workspaceId) || /* @__PURE__ */ new Set()).size
					})).sort((a, b) => b.sessionCount - a.sessionCount) });
				} catch (e) {
					writeJson(res, 502, { error: e.message });
				}
			}
		},
		{
			kind: "exact",
			path: "/m/api/sessions",
			handler: async (req, res) => {
				if (!requireMobile(req, res)) return;
				if (req.method === "GET") try {
					writeJson(res, 200, { items: (await listSessions(apiProxy)).map((s) => {
						const proj = s.projections?.values || {};
						return {
							sessionId: s.sessionId,
							cwd: s.cwd,
							title: proj.title || baseName(s.cwd),
							updatedAt: s.updatedAt,
							running: !!s.running,
							blank: !!s.blank,
							permissions: proj.permissions,
							todos: Array.isArray(proj.todos) ? proj.todos : void 0
						};
					}) });
				} catch (e) {
					writeJson(res, 502, { error: e.message });
				}
				else if (req.method === "POST") {
					const b = await readJsonBody(req);
					try {
						writeJson(res, 200, { sessionId: await createSession(apiProxy, String(b.cwd || defaultCwd), String(b.agentPreset || "standard")) });
					} catch (e) {
						writeJson(res, 502, { error: e.message });
					}
				} else writeJson(res, 405, { error: "Method not allowed" });
			}
		},
		{
			kind: "prefix",
			path: "/m/api/sessions/",
			handler: async (req, res) => {
				if (!requireMobile(req, res)) return;
				const url = new URL(req.url || "", "http://x");
				const parts = url.pathname.split("/").filter(Boolean);
				if (parts.length < 4) return writeJson(res, 404, { error: "路径不完整" });
				const sid = parts[2];
				const action = parts[3];
				if (action === "history" && req.method === "GET") try {
					const events = await getHistory(apiProxy, sid);
					writeJson(res, 200, {
						messages: historyToMessages(events),
						eventCount: events.length
					});
				} catch (e) {
					writeJson(res, 502, { error: e.message });
				}
				else if (action === "prompt" && req.method === "POST") {
					const b = await readJsonBody(req);
					try {
						const content = [{
							type: "text",
							text: String(b.text || "")
						}];
						for (const img of b.images || []) if (img?.data) content.push({
							type: "image",
							mediaType: img.mediaType || "image/jpeg",
							data: img.data,
							...img.name ? { name: img.name } : {}
						});
						if (b.interrupt) await cancelSession(apiProxy, sid);
						await promptSession(apiProxy, sid, content);
						writeJson(res, 200, { ok: true });
					} catch (e) {
						writeJson(res, 502, { error: e.message });
					}
				} else if (action === "cancel" && req.method === "POST") try {
					await cancelSession(apiProxy, sid);
					writeJson(res, 200, { ok: true });
				} catch (e) {
					writeJson(res, 502, { error: e.message });
				}
				else if (action === "model") {
					if (req.method === "GET") try {
						writeJson(res, 200, await listModels(apiProxy, sid));
					} catch (e) {
						writeJson(res, 502, { error: e.message });
					}
					else if (req.method === "POST") {
						const b = await readJsonBody(req);
						try {
							await selectModel(apiProxy, sid, String(b.model || ""));
							writeJson(res, 200, { ok: true });
						} catch (e) {
							writeJson(res, 502, { error: e.message });
						}
					}
				} else if (action === "permission" && req.method === "POST") {
					const b = await readJsonBody(req);
					try {
						await promptSession(apiProxy, sid, [{
							type: "text",
							text: "/permission " + String(b.mode || "")
						}]);
						writeJson(res, 200, { ok: true });
					} catch (e) {
						writeJson(res, 502, { error: e.message });
					}
				} else if (action === "events" && req.method === "GET") {
					const after = Number(url.searchParams.get("afterSeq")) || 0;
					try {
						writeJson(res, 200, await eventStore.getEvents(sid, after));
					} catch (e) {
						writeJson(res, 502, { error: e.message });
					}
				} else if (action === "events.stream" && req.method === "GET") {
					const stream = openSSE(res);
					pushSSE(stream, "__hello", { sessionId: sid });
					eventStore.addSseClient(stream, sid);
					const ka = setInterval(() => {
						if (!stream.closed) try {
							res.write(": keepalive\n\n");
						} catch {}
						else clearInterval(ka);
					}, 25e3);
				} else writeJson(res, 404, { error: `未知操作: ${action}` });
			}
		},
		{
			kind: "exact",
			path: "/m/api/pending",
			handler: (req, res) => {
				if (!requireMethod(req, res, "GET") || !requireMobile(req, res)) return;
				writeJson(res, 200, { items: eventStore.listPending() });
			}
		},
		{
			kind: "prefix",
			path: "/m/api/approvals/",
			handler: async (req, res) => {
				if (!requireMethod(req, res, "POST") || !requireMobile(req, res)) return;
				const parts = new URL(req.url || "", "http://x").pathname.split("/").filter(Boolean);
				const id = parts[parts.length - 1];
				const b = await readJsonBody(req);
				writeJson(res, 200, await eventStore.respond({
					approvalId: id,
					outcome: String(b.outcome)
				}));
			}
		},
		{
			kind: "prefix",
			path: "/m/api/questions/",
			handler: async (req, res) => {
				if (!requireMethod(req, res, "POST") || !requireMobile(req, res)) return;
				const parts = new URL(req.url || "", "http://x").pathname.split("/").filter(Boolean);
				const id = parts[parts.length - 1];
				const b = await readJsonBody(req);
				writeJson(res, 200, await eventStore.respond({
					key: "q:" + id,
					answer: b.answer
				}));
			}
		},
		{
			kind: "exact",
			path: "/m/api/terminal",
			handler: async (req, res) => {
				if (!requireMethod(req, res, "POST") || !requireMobile(req, res)) return;
				const b = await readJsonBody(req);
				writeJson(res, 200, await runTerminal(String(b.command || ""), String(b.cwd || defaultCwd)));
			}
		},
		{
			kind: "exact",
			path: "/m/api/files",
			handler: async (req, res) => {
				if (!requireMethod(req, res, "GET") || !requireMobile(req, res)) return;
				const dir = new URL(req.url || "", "http://x").searchParams.get("path") || defaultCwd;
				try {
					const { readdir, stat } = await import("node:fs/promises");
					const entries = await readdir(dir, { withFileTypes: true });
					writeJson(res, 200, {
						path: dir,
						items: (await Promise.all(entries.map(async (e) => {
							const full = path.join(dir, e.name);
							let size, mtime;
							try {
								const s = await stat(full);
								size = s.size;
								mtime = s.mtimeMs;
							} catch {}
							return {
								name: e.name,
								dir: e.isDirectory(),
								size,
								mtime
							};
						}))).sort((a, b) => b.dir - a.dir || String(a.name).localeCompare(String(b.name)))
					});
				} catch (e) {
					writeJson(res, 502, { error: e.message });
				}
			}
		},
		{
			kind: "exact",
			path: "/m/api/file",
			handler: async (req, res) => {
				if (!requireMethod(req, res, "GET") || !requireMobile(req, res)) return;
				const file = new URL(req.url || "", "http://x").searchParams.get("path") || "";
				try {
					const data = await readFile(file, "utf8");
					writeJson(res, 200, {
						path: file,
						content: data,
						size: data.length
					});
				} catch (e) {
					writeJson(res, 502, { error: e.message });
				}
			}
		},
		{
			kind: "exact",
			path: "/m/api/heartbeat",
			handler: (req, res) => {
				if (!requireMethod(req, res, "POST") || !requireMobile(req, res)) return;
				writeJson(res, 200, { ok: true });
			}
		}
	];
}
function makeMobileRoutes() {
	const relayPath1 = path.join(__dirname, "assets", "relay.html");
	const relayPath2 = path.join(__dirname, "..", "assets", "relay.html");
	const relayPath = existsSync(relayPath1) ? relayPath1 : relayPath2;
	const handlePage = async (_req, res) => {
		if (!existsSync(relayPath)) return writeStatic(res, 503, "text/plain", "relay.html 未构建");
		writeStatic(res, 200, "text/html", await readFile(relayPath, "utf8"));
	};
	const redirectRoot = (req, res) => {
		const url = new URL(req.url ?? "/m", "http://x");
		res.writeHead(308, { location: "/m/" + url.search });
		res.end();
	};
	const handlePair = async (req, res) => {
		const token = new URL(req.url ?? "", "http://x").searchParams.get("token");
		if (!token) {
			writeStatic(res, 400, "text/html", "<h1>配对链接无效</h1><p>缺少 token 参数</p>");
			return;
		}
		writeStatic(res, 200, "text/html", pairRedirectHtml(token));
	};
	return [
		{
			kind: "exact",
			path: "/m",
			handler: redirectRoot
		},
		{
			kind: "exact",
			path: "/m/",
			handler: handlePage
		},
		{
			kind: "exact",
			path: "/m/pair",
			handler: handlePair
		}
	];
}
function pairRedirectHtml(token) {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>配对中…</title><style>body{font-family:system-ui;text-align:center;padding:40px 20px;background:#191919;color:#eee}
.dot{display:inline-block;width:10px;height:10px;background:#4a90d9;border-radius:50%;animation:p 1s infinite}@keyframes p{50%{opacity:0}}</style>
</head><body><p><span class="dot"></span> 正在配对…</p></body>
<script>
fetch('/api/pair/accept',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'${token}'})})
.then(r=>r.json()).then(j=>{ if(j.ok){location.href='/m/';} else { document.body.innerHTML='<h2>配对失败</h2><p>'+j.error+'</p><button onclick="location.reload()">重试</button>'; } })
.catch(e=>{ document.body.innerHTML='<h2>网络错误</h2><p>'+e+'</p>'; });
<\/script></html>`;
}
function runTerminal(command, cwd) {
	return new Promise((resolve) => {
		const started = Date.now();
		const child = spawn(process.platform === "win32" ? "cmd.exe" : "/bin/sh", process.platform === "win32" ? [
			"/d",
			"/c",
			command
		] : ["-c", command], {
			cwd: cwd || process.cwd(),
			env: process.env
		});
		let stdout = "", stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		child.on("close", (code) => resolve({
			ok: code === 0,
			exitCode: code,
			stdout: stdout.trim(),
			stderr: stderr.trim(),
			elapsedMs: Date.now() - started
		}));
		child.on("error", (e) => resolve({
			ok: false,
			exitCode: -1,
			stdout: "",
			stderr: String(e),
			elapsedMs: Date.now() - started
		}));
	});
}
//#endregion
//#region src/config.ts
const DEFAULT_CONFIG = {
	mobileEnterToSend: true,
	requirePairingForLan: true
};
//#endregion
//#region src/index.ts
const name = "dsh-mobile-sync";
const inject = ["webServer", "apiProxy"];
/** 检测本机 LAN IP 地址（用于生成手机可访问的 QR 码） */
function detectLanIp() {
	const ifs = os.networkInterfaces();
	for (const list of Object.values(ifs)) {
		if (!list) continue;
		for (const iface of list) if (iface.family === "IPv4" && !iface.internal && !iface.address.startsWith("169.254")) return iface.address;
	}
	return null;
}
function apply(ctx, config = {}) {
	const cfg = {
		...DEFAULT_CONFIG,
		...config
	};
	const port = ctx.webServer.port || 3080;
	const dshBaseUrl = `http://127.0.0.1:${port}`;
	let qrOrigin;
	if (cfg.publicBaseUrl) qrOrigin = cfg.publicBaseUrl.replace(/\/+$/, "");
	else {
		const lanIp = detectLanIp();
		const webServerHost = ctx.webServer.host;
		qrOrigin = `http://${webServerHost && webServerHost !== "0.0.0.0" ? webServerHost : lanIp || "127.0.0.1"}:${port}`;
	}
	const pairing = new PairingService(qrOrigin, cfg.publicBaseUrl);
	const eventStore = createEventStore({
		dshBaseUrl,
		apiProxy: ctx.apiProxy
	});
	const allRoutes = [
		...makePairRoutes(pairing),
		...makeMobileRoutes(),
		...makeMobileApiRoutes(pairing, eventStore, ctx.apiProxy, process.cwd())
	];
	ctx.effect(() => {
		const disposers = allRoutes.map((route) => ctx.webServer.register(route));
		return () => {
			for (const dispose of disposers) dispose();
		};
	});
	ctx.effect(() => {
		eventStore.start();
		return () => {
			eventStore.stop();
		};
	});
	if (cfg.requirePairingForLan) ctx.on("api/gate", (evt) => {
		const req = evt?.request;
		if (!req) return;
		const addr = req.socket?.remoteAddress || "";
		if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") return;
		const cookie = (req.headers?.cookie || "").match(/dsh-msc-[^;]+/)?.[0]?.trim();
		if (!pairing.isPaired(cookie)) evt.deny = true;
	});
	if (cfg.publicBaseUrl !== void 0) pairing.updatePublicUrl(cfg.publicBaseUrl);
	ctx.provide("mobileSync", {
		pairing,
		eventStore,
		config: cfg
	});
}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=index.js.map