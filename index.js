/**
 * dsh-plugin-session-restore — Host half.
 *
 * Components:
 *
 *   lib/session.js  read a session log (multi-frame zstd → events → tool calls)
 *   lib/scan.js     find sessions on disk, summarise them
 *   lib/rebuild.js  replay write/edit/read into a file tree
 *   lib/export.js   write that tree somewhere safe
 *
 * Design boundary: this plugin **never writes into the workspace it is
 * recovering from**. Export writes to a directory the user names, and refuses
 * the session's own cwd. A tool built to undo a destructive action must not be
 * able to perform one.
 *
 * @module dsh-plugin-session-restore
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { stat, readFile } from "node:fs/promises";

import { readSession, sessionHeader, collectCalls } from "./lib/session.js";
import { listSessions, findSession, sessionsRoot } from "./lib/scan.js";
import { rebuild } from "./lib/rebuild.js";
import { exportTree, checkTarget } from "./lib/export.js";

export const name = "session-restore";
export const inject = ["webServer"];

const PREFIX = "/api/session-restore";

/** How long a rebuilt tree is kept in memory for a second "export" call. */
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const PREVIEW_MAX = 8;

/** The DSH home this Host is running under. */
function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

const writeJson = (res, status, body) => {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(JSON.stringify(body));
};

/**
 * Read a request body with a hard size cap.
 *
 * @param {import("node:http").IncomingMessage} req - the request.
 * @param {number} [limit] - maximum bytes.
 * @returns {Promise<string>} body text.
 */
function readBody(req, limit = 1 << 20) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(Object.assign(new Error("body-too-large"), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/**
 * Rebuild a session's tree, in memory.
 *
 * @param {object} entry - session entry from {@link findSession}.
 * @returns {Promise<{session:object, tree:object, header:object|null}>}
 */
async function rebuildSession(entry) {
	const decoded = await readSession(entry.logPath);
	const header = sessionHeader(decoded.events);
	const calls = collectCalls(decoded.events);
	const tree = rebuild(calls, { root: header?.cwd ?? null, useReads: true });
	return {
		session: {
			id: header?.id ?? entry.dir.replace(/[\\/]session-/, ""),
			dir: entry.dir,
			cwd: header?.cwd ?? null,
			createdAt: header?.createdAt ?? null,
			preset: header?.preset ?? null,
			events: decoded.events.length,
			frames: decoded.frames,
			badLines: decoded.badLines,
			calls: calls.length,
		},
		tree,
		header,
	};
}

/**
 * Keep only the most recent previews so a long-running Host does not accumulate
 * rebuilt trees indefinitely.
 *
 * @param {Map<string, object>} cache - preview cache.
 * @param {string} key - new key.
 * @param {object} value - preview payload.
 */
function rememberPreview(cache, key, value) {
	cache.set(key, { ...value, at: Date.now() });
	if (cache.size <= PREVIEW_MAX) return;
	const entries = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
	for (const [k] of entries.slice(0, cache.size - PREVIEW_MAX)) cache.delete(k);
}

export function apply(ctx) {
	/** Preview cache: rebuilding is deterministic, but not free. */
	const previews = new Map();

	// Register as a prefix route rather than a `use()` middleware.
	//
	// The web server exposes `register({kind: 'prefix', path, handler})`; a plugin
	// that calls `use()` instead attaches nothing and every request falls through
	// to the host's 404 — which is what happened on the first load: the tab and
	// its dictionary appeared (that is client.js) while every API call returned
	// the string `not found`, and the UI reported
	// `Unexpected token 'o', "not found" is not valid JSON`.
	//
	// `scope.effect` ties the registration to this plugin's lifetime, so a reload
	// or uninstall drops the route instead of leaving a handler pointing at a
	// disposed module.
	ctx.inject(["webServer"], (scope) => {
		scope.effect(() => scope.webServer.register({
			kind: "prefix",
			path: PREFIX,
			handler: async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		// Strip the prefix only when it is still there.
		//
		// A prefix route may hand over either the full pathname or one with the
		// prefix already removed, depending on the host version. Unconditionally
		// slicing `PREFIX.length` would silently truncate an already-stripped
		// `/sessions` into `ons` and 404 every route — a failure that looks like
		// "the plugin did not load". Tolerating both costs one comparison and
		// removes the whole class of mistake.
		const pathname = url.pathname.replace(/\/+$/, "");
		const route = (pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : pathname) || "/";
		try {
			// ---- list sessions -----------------------------------------------
			if (req.method === "GET" && route === "/sessions") {
				const root = sessionsRoot(dshHome());
				const rows = await listSessions(root);
				writeJson(res, 200, {
					root,
					sessions: rows,
					generatedAt: new Date().toISOString(),
				});
				return;
			}

			// ---- rebuild one session in memory (preview) ----------------------
			if (req.method === "POST" && route === "/preview") {
				const body = JSON.parse((await readBody(req)) || "{}");
				const id = typeof body.id === "string" ? body.id : "";
				if (id === "") {
					writeJson(res, 400, { error: "missing-session-id" });
					return;
				}
				const entry = await findSession(sessionsRoot(dshHome()), id);
				if (entry === null) {
					writeJson(res, 404, { error: "session-not-found" });
					return;
				}
				const built = await rebuildSession(entry);
				rememberPreview(previews, built.session.id, built);
				writeJson(res, 200, {
					session: built.session,
					// Content is not sent to the browser: a preview only needs the
					// shape. The full text stays server-side for the export call.
					files: built.tree.files.map((f) => ({
						path: f.path,
						bytes: f.bytes,
						lines: f.lines,
						resynced: f.resynced,
						shellTouched: f.shellTouched,
					})),
					stats: built.tree.stats,
					failureCount: built.tree.failures.length,
					// Two different things, deliberately kept apart:
					//   lostEdits         — a real loss: the session had the file,
					//                       an edit could not be replayed.
					//   editedWithoutWrite — the file predates this session, so the
					//                       log never held its text. Not recoverable
					//                       from here at all, and saying so is more
					//                       useful than calling it a failure.
					lostEdits: built.tree.lostEdits.slice(0, 50),
					editedWithoutWrite: built.tree.editedWithoutWrite,
					shellTouched: built.tree.shellTouched,
				});
				return;
			}

			// ---- read one rebuilt file ---------------------------------------
			if (req.method === "GET" && route === "/file") {
				const id = url.searchParams.get("id") ?? "";
				const path = url.searchParams.get("path") ?? "";
				const cached = previews.get(id);
				if (cached === undefined) {
					writeJson(res, 409, { error: "preview-required" });
					return;
				}
				const file = cached.tree.files.find((f) => f.path === path);
				if (file === undefined) {
					writeJson(res, 404, { error: "file-not-in-preview" });
					return;
				}
				// Cap what goes to the browser: one 50 MB generated file should not
				// hang the panel.
				const LIMIT = 256 * 1024;
				const text = file.content.length > LIMIT
					? `${file.content.slice(0, LIMIT)}\n\n…（已截断，共 ${file.bytes} 字节）`
					: file.content;
				writeJson(res, 200, { path, text, bytes: file.bytes, truncated: file.content.length > LIMIT });
				return;
			}

			// ---- export to a directory ---------------------------------------
			if (req.method === "POST" && route === "/export") {
				const body = JSON.parse((await readBody(req)) || "{}");
				const id = typeof body.id === "string" ? body.id : "";
				const target = typeof body.target === "string" ? body.target : "";
				const overwrite = body.overwrite === true;
				if (id === "") {
					writeJson(res, 400, { error: "missing-session-id" });
					return;
				}
				const cached = previews.get(id);
				if (cached === undefined) {
					writeJson(res, 409, { error: "preview-required" });
					return;
				}
				const check = checkTarget(target, cached.session.cwd);
				if (!check.ok) {
					writeJson(res, 400, { error: check.reason });
					return;
				}
				let info;
				try {
					info = await stat(target);
				} catch {
					writeJson(res, 400, { error: "target-missing" });
					return;
				}
				if (!info.isDirectory()) {
					writeJson(res, 400, { error: "target-not-a-directory" });
					return;
				}
				const result = await exportTree({
					targetDir: target,
					files: cached.tree.files,
					overwrite,
				});
				writeJson(res, 200, {
					ok: true,
					written: result.written.length,
					skipped: result.skipped,
					refused: result.refused,
					bytes: result.bytes,
				});
				return;
			}

			// ---- settings / capability probe ---------------------------------
			if (req.method === "GET" && route === "/status") {
				const root = sessionsRoot(dshHome());
				let exists = false;
				try {
					exists = (await stat(root)).isDirectory();
				} catch {
					exists = false;
				}
				writeJson(res, 200, {
					root,
					exists,
					previews: previews.size,
				});
				return;
			}

			writeJson(res, 404, { error: "not-found", route });
		} catch (error) {
			const status = Number.isInteger(error?.status) ? error.status : 500;
			writeJson(res, status, { error: String(error?.message ?? error).slice(0, 400) });
		}
			},
		}), "session-restore: routes");
	});
}
