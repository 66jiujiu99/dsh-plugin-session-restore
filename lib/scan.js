/**
 * Component: finding sessions on disk.
 *
 * DSH stores sessions under `$DSH_HOME/sessions/<project-dir>/session-<uuid>/`,
 * one directory per session, each holding a `session.v4.jsonl.zstd`. The
 * project directory name is the workspace path mangled into a folder name
 * (`--C-Data-deepseek--`), so the real cwd is read from the session header
 * instead of being decoded back out of the folder name.
 *
 * Listing a session reads its header and counts events, which means decoding
 * the whole log. That is the honest cost of showing "how much is in here";
 * a cheaper listing would have to guess, and guessing is what makes a recovery
 * tool useless at the moment it is needed.
 *
 * @module dsh-plugin-session-restore/lib/scan
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readSession, sessionHeader, collectCalls } from "./session.js";

/** Files inside a session directory that hold the log. */
const LOG_SUFFIX = ".zstd";

/**
 * Where sessions live.
 *
 * @param {string} dshHome - resolved `$DSH_HOME`.
 * @returns {string} absolute path to the sessions root.
 */
export function sessionsRoot(dshHome) {
	return join(dshHome, "sessions");
}

/**
 * Find every session directory under a sessions root.
 *
 * @param {string} root - sessions root.
 * @returns {Promise<Array<{project:string, dir:string, logPath:string, mtime:number, bytes:number}>>}
 */
export async function findSessionDirs(root) {
	const found = [];
	let projects;
	try {
		projects = await readdir(root, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const projectDir = join(root, project.name);
		let entries;
		try {
			entries = await readdir(projectDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
			const dir = join(projectDir, entry.name);
			let files;
			try {
				files = await readdir(dir);
			} catch {
				continue;
			}
			const log = files.find((f) => f.endsWith(LOG_SUFFIX));
			if (log === undefined) continue;
			const logPath = join(dir, log);
			let info;
			try {
				info = await stat(logPath);
			} catch {
				continue;
			}
			found.push({
				project: project.name,
				dir,
				logPath,
				mtime: info.mtimeMs,
				bytes: info.size,
			});
		}
	}
	return found;
}

/**
 * Summarise one session without rebuilding it.
 *
 * @param {object} entry - from {@link findSessionDirs}.
 * @returns {Promise<object>} a row for the list UI.
 */
export async function summarizeSession(entry) {
	const base = {
		id: entry.dir.replace(/[\\/]session-/, ""),
		dir: entry.dir,
		project: entry.project,
		mtime: entry.mtime,
		bytes: entry.bytes,
		cwd: null,
		createdAt: null,
		events: 0,
		writes: 0,
		edits: 0,
		files: 0,
		error: null,
	};
	let decoded;
	try {
		decoded = await readSession(entry.logPath);
	} catch (error) {
		return { ...base, error: error instanceof Error ? error.message : String(error) };
	}
	const header = sessionHeader(decoded.events);
	const calls = collectCalls(decoded.events);
	const paths = new Set();
	let writes = 0;
	let edits = 0;
	for (const call of calls) {
		if (call.name === "write") writes += 1;
		if (call.name === "edit") edits += 1;
		const fp = call.args?.file_path ?? call.args?.path;
		if ((call.name === "write" || call.name === "edit") && typeof fp === "string") {
			paths.add(fp.replace(/\\/g, "/"));
		}
	}
	return {
		...base,
		id: header?.id ?? base.id,
		cwd: header?.cwd ?? null,
		createdAt: header?.createdAt ?? null,
		events: decoded.events.length,
		writes,
		edits,
		files: paths.size,
	};
}

/**
 * List every session, newest first.
 *
 * @param {string} root - sessions root.
 * @returns {Promise<object[]>} summary rows.
 */
export async function listSessions(root) {
	const dirs = await findSessionDirs(root);
	const rows = [];
	for (const entry of dirs) rows.push(await summarizeSession(entry));
	rows.sort((a, b) => b.mtime - a.mtime);
	return rows;
}

/**
 * Find one session by id (the `session-<uuid>` directory name, with or without
 * the `session-` prefix).
 *
 * @param {string} root - sessions root.
 * @param {string} id - session id.
 * @returns {Promise<object|null>} the entry, or null.
 */
export async function findSession(root, id) {
	const wanted = String(id).replace(/^session-/, "").toLowerCase();
	const dirs = await findSessionDirs(root);
	return dirs.find((entry) => entry.dir.toLowerCase().endsWith(`session-${wanted}`)) ?? null;
}
