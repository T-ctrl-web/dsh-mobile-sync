import { useCallback, useEffect, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/client/RemoteEntry.tsx
const RemoteEntry = ({ wide }) => {
	const [open, setOpen] = useState(false);
	const [snapshot, setSnapshot] = useState(null);
	const [loading, setLoading] = useState(false);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState(null);
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
	const onlineDevices = snapshot?.devices?.filter((d) => d.online) || [];
	const offlineDevices = snapshot?.devices?.filter((d) => !d.online) || [];
	const stateLabel = onlineDevices.length ? `${onlineDevices.length} 台在线` : offlineDevices.length ? `${offlineDevices.length} 台离线` : "等待手机连接";
	const stateColor = onlineDevices.length ? "#4caf50" : offlineDevices.length ? "#888" : "#f0a020";
	return /* @__PURE__ */ jsxs("div", {
		style: { position: "relative" },
		children: [/* @__PURE__ */ jsx("button", {
			onClick: () => setOpen(!open),
			title: "移动端远程控制",
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
				transition: "background 120ms"
			},
			children: /* @__PURE__ */ jsxs("svg", {
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
			})
		}), open && /* @__PURE__ */ jsxs("div", {
			style: {
				position: "absolute",
				bottom: "100%",
				right: 0,
				marginBottom: 8,
				width: wide ? 360 : 300,
				background: "var(--surface, #1a1a1f)",
				border: "1px solid var(--border, #333)",
				borderRadius: 12,
				padding: 16,
				boxShadow: "0 8px 32px rgba(0,0,0,.4)",
				zIndex: 100,
				fontSize: 14,
				color: "var(--text, #ececec)"
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
							background: stateColor
						} }),
						/* @__PURE__ */ jsx("span", {
							style: { fontSize: 13 },
							children: stateLabel
						}),
						snapshot?.devices?.length ? /* @__PURE__ */ jsxs("span", {
							style: {
								fontSize: 11,
								color: "var(--text-muted)"
							},
							children: [
								"共 ",
								snapshot.devices.length,
								" 台（",
								onlineDevices.length,
								" 在线 / ",
								offlineDevices.length,
								" 离线）"
							]
						}) : null
					]
				}),
				snapshot?.devices?.length ? /* @__PURE__ */ jsx("div", {
					style: {
						marginBottom: 12,
						display: "flex",
						flexDirection: "column",
						gap: 4
					},
					children: snapshot.devices.map((d) => /* @__PURE__ */ jsxs("div", {
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
					}, d.cookie))
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
//#region src/client/FooterRemoteEntry.tsx
const FooterRemoteEntry = ({ open: openProp, onToggle }) => {
	const [internal, setInternal] = useState(false);
	const open = openProp ?? internal;
	const toggle = () => {
		const next = !open;
		if (onToggle) onToggle(next);
		else setInternal(next);
	};
	return /* @__PURE__ */ jsx("button", {
		onClick: toggle,
		title: "手机远程控制",
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
			transition: "background 120ms"
		},
		children: /* @__PURE__ */ jsxs("svg", {
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
		})
	});
};
//#endregion
//#region src/client/index.ts
const NS = "mobile-sync";
const inject = [
	"slots",
	"locale",
	"connection",
	"settingsScope"
];
function apply(ctx) {
	ctx.slots.inject("sidebar.remote", () => {
		const disposeEntry = ctx.slots.register({
			name: "sidebar.remote",
			locale: "sidebar"
		}, RemoteEntry);
		return () => {
			disposeEntry();
		};
	});
	ctx.slots.inject("sidebar.footer.action", () => {
		const disposeFooter = ctx.slots.register({
			name: "sidebar.footer.action",
			id: "mobile-sync",
			locale: "sidebar"
		}, FooterRemoteEntry);
		return () => {
			disposeFooter();
		};
	});
}
//#endregion
export { NS, apply, inject };

//# sourceMappingURL=client.js.map