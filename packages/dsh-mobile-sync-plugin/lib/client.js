window.__ModuleLoader__.load({
	id: "dsh-mobile-sync",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var __dep_react = require("react");
		var __dep_react_jsx_runtime = require("react/jsx-runtime");
		var useCallback = __dep_react.useCallback;
		var useEffect = __dep_react.useEffect;
		var useState = __dep_react.useState;
		var jsx = __dep_react_jsx_runtime.jsx;
		var jsxs = __dep_react_jsx_runtime.jsxs;
		//#region src/client/bridge.ts
		/** 由 client/index.ts 在 apply() 时注入：打开指定会话（PC 端 DSH 主界面跳转） */
		let openSessionFn = null;
		function setOpenSession(fn) {
			openSessionFn = fn;
		}
		/** 向 host 同步桥上报 PC 端状态（host 再广播给手机） */
		function reportPcState(patch) {
			try {
				fetch("/api/sync/pc-state", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(patch),
					keepalive: true
				}).catch(() => {});
			} catch {}
		}
		//#endregion
		//#region src/client/FooterRemoteEntry.tsx
		const fmtTime = (t) => {
			if (!t) return "";
			const d = new Date(t);
			const now = /* @__PURE__ */ new Date();
			const pad = (n) => String(n).padStart(2, "0");
			if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
			return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		};
		const FooterRemoteEntry = ({ wide }) => {
			const [open, setOpen] = useState(false);
			const [snapshot, setSnapshot] = useState(null);
			const [sync, setSync] = useState(null);
			const [loading, setLoading] = useState(false);
			const [copied, setCopied] = useState(false);
			const [error, setError] = useState(null);
			useEffect(() => {
				const es = new EventSource("/api/sync");
				es.addEventListener("state", (e) => {
					try {
						setSync(JSON.parse(e.data));
					} catch {}
				});
				es.onerror = () => {};
				return () => es.close();
			}, []);
			const issue = useCallback(async () => {
				setLoading(true);
				setError(null);
				try {
					const j = await (await fetch("/api/pair/issue", { method: "POST" })).json();
					if (j.error) setError(j.error);
					else setSnapshot(j);
				} catch (e) {
					setError(String(e));
				} finally {
					setLoading(false);
				}
			}, []);
			const stop = useCallback(async () => {
				try {
					await fetch("/api/pair/stop", { method: "POST" });
					setSnapshot(null);
				} catch (e) {
					setError(String(e));
				}
			}, []);
			const copyLink = useCallback(() => {
				if (!snapshot?.qrUrl) return;
				navigator.clipboard.writeText(snapshot.qrUrl).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 2e3);
				});
			}, [snapshot]);
			useEffect(() => {
				if (!open) return;
				const es = new EventSource("/api/pair/status");
				es.addEventListener("state", (e) => {
					try {
						setSnapshot(JSON.parse(e.data));
					} catch {}
				});
				return () => es.close();
			}, [open]);
			useEffect(() => {
				if (open && !snapshot) issue();
			}, [
				open,
				snapshot,
				issue
			]);
			const onlineCount = sync?.devices?.filter((d) => d.online).length || 0;
			const totalDevices = sync?.devices?.length || 0;
			const dotColor = onlineCount > 0 ? "#4caf50" : totalDevices > 0 ? "#888" : "#f0a020";
			const dotTitle = onlineCount > 0 ? `${onlineCount} 台手机在线` : totalDevices > 0 ? "手机已配对但离线" : "等待手机连接";
			const mobile = sync?.mobile;
			const pc = sync?.pc;
			const hasMobileSession = !!mobile?.activeSessionId;
			return /* @__PURE__ */ jsxs("div", {
				style: { position: "relative" },
				children: [/* @__PURE__ */ jsxs("button", {
					onClick: () => setOpen(!open),
					title: dotTitle,
					style: {
						width: 36,
						height: 36,
						border: "none",
						borderRadius: 8,
						background: open ? "var(--accent, #4a90d9)" : "transparent",
						color: open ? "#fff" : "var(--text-secondary, #9a9a9a)",
						cursor: "pointer",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						fontSize: 18,
						transition: "background 120ms",
						position: "relative"
					},
					children: [/* @__PURE__ */ jsxs("svg", {
						width: "18",
						height: "18",
						viewBox: "0 0 24 24",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "2",
						strokeLinecap: "round",
						strokeLinejoin: "round",
						children: [/* @__PURE__ */ jsx("rect", {
							x: "5",
							y: "2",
							width: "14",
							height: "20",
							rx: "2"
						}), /* @__PURE__ */ jsx("path", { d: "M12 18h.01" })]
					}), /* @__PURE__ */ jsx("span", { style: {
						position: "absolute",
						right: 3,
						bottom: 3,
						width: 8,
						height: 8,
						borderRadius: "50%",
						background: dotColor,
						border: "1.5px solid var(--surface, #1a1a1f)"
					} })]
				}), open && /* @__PURE__ */ jsxs("div", {
					style: {
						position: "absolute",
						bottom: "100%",
						right: 0,
						marginBottom: 8,
						width: wide ? 380 : 320,
						background: "var(--surface, #1a1a1f)",
						border: "1px solid var(--border, #333)",
						borderRadius: 12,
						padding: 16,
						boxShadow: "0 8px 32px rgba(0,0,0,.4)",
						zIndex: 100,
						fontSize: 14,
						color: "var(--text, #ececec)",
						maxHeight: "70vh",
						overflowY: "auto"
					},
					children: [
						/* @__PURE__ */ jsx("div", {
							style: {
								fontWeight: 600,
								marginBottom: 4
							},
							children: "移动端远程控制"
						}),
						/* @__PURE__ */ jsx("div", {
							style: {
								fontSize: 12,
								color: "var(--text-muted, #9a9a9a)",
								marginBottom: 12
							},
							children: "扫码或在手机上打开链接，即可远程控制当前工作区"
						}),
						/* @__PURE__ */ jsxs("div", {
							style: {
								border: "1px solid var(--border, #333)",
								borderRadius: 10,
								padding: 10,
								marginBottom: 12,
								background: "var(--bg-muted, #222)"
							},
							children: [
								/* @__PURE__ */ jsxs("div", {
									style: {
										fontSize: 12,
										fontWeight: 600,
										marginBottom: 8,
										display: "flex",
										alignItems: "center",
										gap: 6
									},
									children: [/* @__PURE__ */ jsx("span", { style: {
										width: 7,
										height: 7,
										borderRadius: "50%",
										background: dotColor
									} }), "双向实时同步"]
								}),
								/* @__PURE__ */ jsxs("div", {
									style: {
										fontSize: 12,
										marginBottom: 6
									},
									children: [/* @__PURE__ */ jsx("span", {
										style: { color: "var(--text-muted)" },
										children: "手机端："
									}), hasMobileSession ? /* @__PURE__ */ jsx("span", {
										style: { color: "var(--text)" },
										children: mobile?.activeSessionTitle || (mobile?.activeSessionId || "").slice(0, 8)
									}) : /* @__PURE__ */ jsx("span", {
										style: { color: "var(--text-muted)" },
										children: onlineCount ? "已连接，尚未打开会话" : "未连接"
									})]
								}),
								mobile?.lastAction && onlineCount > 0 && /* @__PURE__ */ jsxs("div", {
									style: {
										fontSize: 11,
										color: "var(--text-muted)",
										marginBottom: 6
									},
									children: [
										/* @__PURE__ */ jsx("span", {
											style: { color: "var(--accent, #4a90d9)" },
											children: mobile.lastAction
										}),
										" · ",
										fmtTime(mobile.lastActionAt)
									]
								}),
								hasMobileSession && (() => {
									const targetId = mobile?.activeSessionId || null;
									return /* @__PURE__ */ jsx("button", {
										onClick: () => {
											if (openSessionFn && targetId) openSessionFn(targetId);
										},
										style: {
											width: "100%",
											padding: "6px 0",
											borderRadius: 8,
											fontSize: 12,
											fontWeight: 600,
											background: "var(--accent, #4a90d9)",
											color: "#fff",
											border: "none",
											cursor: "pointer"
										},
										children: "在电脑上打开该会话"
									});
								})(),
								pc?.activeSessionId && /* @__PURE__ */ jsxs("div", {
									style: {
										fontSize: 12,
										marginTop: 8,
										color: "var(--text-muted)"
									},
									children: ["电脑当前会话：", /* @__PURE__ */ jsx("span", {
										style: { color: "var(--text)" },
										children: pc.activeSessionTitle || pc.activeSessionId.slice(0, 8)
									})]
								})
							]
						}),
						/* @__PURE__ */ jsxs("div", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 6,
								marginBottom: 12
							},
							children: [
								/* @__PURE__ */ jsx("span", { style: {
									width: 8,
									height: 8,
									borderRadius: "50%",
									background: dotColor
								} }),
								/* @__PURE__ */ jsx("span", {
									style: { fontSize: 13 },
									children: onlineCount > 0 ? `${onlineCount} 台在线` : totalDevices > 0 ? `${totalDevices} 台已配对（离线）` : "等待手机连接"
								}),
								totalDevices > 0 && /* @__PURE__ */ jsxs("span", {
									style: {
										fontSize: 11,
										color: "var(--text-muted)"
									},
									children: [
										"共 ",
										totalDevices,
										" 台（",
										onlineCount,
										" 在线 / ",
										totalDevices - onlineCount,
										" 离线）"
									]
								})
							]
						}),
						sync?.devices?.length ? /* @__PURE__ */ jsx("div", {
							style: {
								marginBottom: 12,
								display: "flex",
								flexDirection: "column",
								gap: 4
							},
							children: sync.devices.map((d, i) => /* @__PURE__ */ jsxs("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 6,
									fontSize: 12,
									color: "var(--text-muted)"
								},
								children: [
									/* @__PURE__ */ jsx("span", { style: {
										width: 6,
										height: 6,
										borderRadius: "50%",
										background: d.online ? "#4caf50" : "#888"
									} }),
									/* @__PURE__ */ jsx("span", { children: d.label }),
									/* @__PURE__ */ jsx("span", {
										style: { fontSize: 10 },
										children: d.online ? "在线" : "离线"
									})
								]
							}, i))
						}) : null,
						loading ? /* @__PURE__ */ jsx("div", {
							style: {
								textAlign: "center",
								padding: 40,
								color: "var(--text-muted)"
							},
							children: "生成中…"
						}) : error ? /* @__PURE__ */ jsx("div", {
							style: {
								color: "#e0533d",
								fontSize: 12,
								padding: 8
							},
							children: error
						}) : snapshot?.qrDataUrl ? /* @__PURE__ */ jsx("div", {
							style: {
								textAlign: "center",
								marginBottom: 12
							},
							children: /* @__PURE__ */ jsx("img", {
								src: snapshot.qrDataUrl,
								alt: "扫码连接",
								style: {
									width: "100%",
									maxWidth: 240,
									borderRadius: 8
								}
							})
						}) : null,
						snapshot?.qrUrl && /* @__PURE__ */ jsxs("div", {
							style: { marginBottom: 12 },
							children: [/* @__PURE__ */ jsx("div", {
								style: {
									fontSize: 11,
									color: "var(--text-muted)",
									marginBottom: 4
								},
								children: "无法扫码？可以在手机上打开链接："
							}), /* @__PURE__ */ jsx("div", {
								style: {
									fontSize: 10,
									fontFamily: "monospace",
									wordBreak: "break-all",
									background: "var(--bg-muted, #222)",
									padding: "4px 8px",
									borderRadius: 6,
									color: "var(--text-muted)"
								},
								children: snapshot.qrUrl
							})]
						}),
						/* @__PURE__ */ jsxs("div", {
							style: {
								display: "flex",
								gap: 8
							},
							children: [
								/* @__PURE__ */ jsx("button", {
									onClick: stop,
									style: {
										flex: 1,
										padding: "8px 0",
										borderRadius: 8,
										fontSize: 12,
										fontWeight: 600,
										background: "var(--danger, #e0533d)",
										color: "#fff",
										border: "none",
										cursor: "pointer"
									},
									children: "停止"
								}),
								/* @__PURE__ */ jsx("button", {
									onClick: issue,
									style: {
										flex: 1,
										padding: "8px 0",
										borderRadius: 8,
										fontSize: 12,
										fontWeight: 600,
										background: "var(--bg-muted, #2b2b2b)",
										color: "var(--text)",
										border: "1px solid var(--border)",
										cursor: "pointer"
									},
									children: "刷新二维码"
								}),
								/* @__PURE__ */ jsx("button", {
									onClick: copyLink,
									style: {
										flex: 1,
										padding: "8px 0",
										borderRadius: 8,
										fontSize: 12,
										fontWeight: 600,
										background: "var(--bg-muted, #2b2b2b)",
										color: copied ? "#4caf50" : "var(--text)",
										border: "1px solid var(--border)",
										cursor: "pointer"
									},
									children: copied ? "已复制" : "复制链接"
								})
							]
						}),
						/* @__PURE__ */ jsxs("div", {
							style: {
								marginTop: 10,
								fontSize: 11,
								color: "var(--text-muted)"
							},
							children: [
								"提示：需 ",
								/* @__PURE__ */ jsx("code", {
									style: { fontSize: 10 },
									children: "dsh web --host 0.0.0.0"
								}),
								" 让手机可达； 外网用 ",
								/* @__PURE__ */ jsx("code", {
									style: { fontSize: 10 },
									children: "Tailscale"
								}),
								" 或 ",
								/* @__PURE__ */ jsx("code", {
									style: { fontSize: 10 },
									children: "cloudflared"
								})
							]
						})
					]
				})]
			});
		};
		//#endregion
		//#region src/client/index.ts
		const NS = "mobile-sync";
		const inject = [
			"slots",
			"locale",
			"sessions"
		];
		function apply(ctx) {
			setOpenSession((sessionId) => {
				try {
					ctx.sessions.open(sessionId);
				} catch {}
			});
			ctx.effect(() => {
				let lastReport = "";
				const report = () => {
					try {
						const st = ctx.sessions.list.getSnapshot();
						const current = st?.current;
						const title = current ? st?.byId?.[current]?.displayTitle : null;
						const key = String(current || "") + "|" + String(title || "");
						if (key === lastReport) return;
						lastReport = key;
						reportPcState({
							activeSessionId: current ?? null,
							activeSessionTitle: title ?? null
						});
					} catch {}
				};
				const unsub = ctx.sessions.list.subscribe(report);
				report();
				return unsub;
			});
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "mobile-sync",
				locale: "sidebar"
			}, FooterRemoteEntry));
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
