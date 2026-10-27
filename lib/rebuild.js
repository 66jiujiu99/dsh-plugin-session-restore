/**
 * Component: rebuilding a file tree from a session's edit log.
 *
 * The replay is a small state machine over the calls in `seq` order:
 *
 *   write  → set the file to the given content (full text, always authoritative)
 *   edit   → replace `old_string` with `new_string` in the current content
 *   read   → *checkpoint*: the tool result contains the file as it was on disk,
 *            so a complete read can be used to resynchronise
 *
 * The `read` step is what makes this work at all. Some changes are made by bash
 * scripts, which never produce `edit` events; after such a change every
 * subsequent `edit` fails to find its `old_string`, and a naive replay silently
 * loses them. A read result is ground truth, so it is used to re-anchor.
 *
 * A read is only a *complete* snapshot when it starts at line 1 and reaches the
 * file's last line. The result text says so explicitly:
 *
 *   `(Showing lines 96-135 of 278. Use offset=136 to continue.)`
 *
 * Using a partial read as the full file truncates it — that mistake turned a
 * 686-line `index.js` into 69 lines during the original recovery.
 *
 * Everything this module cannot account for is reported, never papered over:
 * an unapplied edit, a file with no baseline, a file that bash wrote directly.
 *
 * @module dsh-plugin-session-restore/lib/rebuild
 */

/** Tools whose `file_path` names a file this module can rebuild. */
const WRITE_TOOLS = new Set(["write", "edit"]);

/** Shell tools: their contents are opaque, but their targets can be flagged. */
const SHELL_TOOLS = new Set(["ops_bash", "pwsh", "bash", "run_code"]);

/**
 * Normalise a path for use as a map key, keeping it relative to a root.
 *
 * Session logs contain absolute paths from whichever machine ran them. A path
 * outside `root` is kept absolute (and flagged) instead of being silently
 * rewritten, because moving an unrelated file into the recovered tree would be
 * worse than leaving it out.
 *
 * @param {string} filePath - path as recorded in the call.
 * @param {string|null} root - workspace root to make paths relative to.
 * @returns {{key:string, inside:boolean}}
 */
export function normalizePath(filePath, root) {
	const norm = String(filePath ?? "").replace(/\\/g, "/");
	if (root === null || root === undefined || root === "") return { key: norm, inside: true };
	const base = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
	const lower = norm.toLowerCase();
	const baseLower = base.toLowerCase();
	if (lower === baseLower) return { key: "", inside: true };
	if (!lower.startsWith(`${baseLower}/`)) return { key: norm, inside: false };
	return { key: norm.slice(base.length + 1), inside: true };
}

/**
 * Parse a `read` tool result into content plus its line range.
 *
 * The shape is:
 *
 *   `<path>…</path><type>file</type><content>\n1: line\n2: line\n…</content>`
 *
 * with a truncation note appended inside `<content>` when the read stopped
 * early. `total` comes from that note; without a note the output is the whole
 * file.
 *
 * @param {string} text - raw tool result.
 * @returns {{text:string, first:number, last:number, total:number}|null}
 */
export function parseReadResult(text) {
	if (typeof text !== "string") return null;
	const open = text.indexOf("<content>");
	if (open < 0) return null;
	const close = text.indexOf("</content>", open);
	if (close < 0) return null;
	const body = text.slice(open + "<content>".length, close);
	const lines = [];
	let first = null;
	let last = null;
	for (const line of body.split("\n")) {
		const m = line.match(/^(\d+): ?(.*)$/);
		if (!m) continue;
		const n = Number(m[1]);
		if (first === null) first = n;
		last = n;
		lines.push(m[2]);
	}
	if (lines.length === 0) return null;
	const shown = body.match(/\(Showing lines (\d+)-(\d+) of (\d+)\./);
	return {
		text: lines.join("\n"),
		first,
		last,
		total: shown === null ? last : Number(shown[3]),
	};
}

/**
 * Replay a linearised call list into a file tree.
 *
 * @param {object[]} calls - from {@link import("./session.js").collectCalls}.
 * @param {object} options
 * @param {string|null} options.root - workspace root; paths are reported relative to it.
 * @param {boolean} [options.useReads] - re-anchor on complete `read` results (default true).
 * @returns {object} `{files, stats, failures, shellTouched}`
 */
export function rebuild(calls, { root = null, useReads = true } = {}) {
	/** @type {Map<string, string>} */
	const files = new Map();
	const stats = {
		writes: 0,
		edits: 0,
		editsApplied: 0,
		editsFailed: 0,
		resyncs: 0,
		outsideRoot: 0,
	};
	const failures = [];
	const shellTouched = new Set();
	const resyncedFiles = new Set();

	for (const call of calls) {
		const name = String(call?.name ?? "");

		if (SHELL_TOOLS.has(name)) {
			// Shell commands are opaque, but naming a file in one is worth
			// flagging: its content may not be reconstructible from the log.
			const command = String(call?.args?.command ?? "");
			for (const m of command.matchAll(/[A-Za-z]:[\\/][^\s"'`;|&<>]*|\/[^\s"'`;|&<>]{6,}/g)) {
				const { key, inside } = normalizePath(m[0], root);
				if (inside && key !== "") shellTouched.add(key);
			}
			continue;
		}
		if (!WRITE_TOOLS.has(name) && name !== "read") continue;

		const filePath = call?.args?.file_path ?? call?.args?.path;
		if (typeof filePath !== "string") continue;
		const { key, inside } = normalizePath(filePath, root);
		if (key === "") continue;
		if (!inside) {
			stats.outsideRoot += 1;
			continue;
		}

		if (name === "read") {
			if (!useReads) continue;
			const parsed = parseReadResult(call.result);
			if (parsed === null) continue;
			// Only a read that covers the whole file may overwrite what we have.
			if (parsed.first !== 1 || parsed.last !== parsed.total) continue;
			files.set(key, parsed.text);
			stats.resyncs += 1;
			resyncedFiles.add(key);
			continue;
		}

		if (name === "write") {
			if (typeof call.args.content !== "string") continue;
			files.set(key, call.args.content);
			stats.writes += 1;
			continue;
		}

		// edit
		const oldStr = call.args.old_string;
		const newStr = call.args.new_string;
		if (typeof oldStr !== "string" || typeof newStr !== "string") continue;
		stats.edits += 1;
		// An empty old_string is a create, not a search: refusing it here keeps
		// `String.replace("")` from splicing text at position 0.
		if (oldStr === "") {
			stats.editsFailed += 1;
			failures.push({ path: key, seq: call.seq, reason: "empty-old-string" });
			continue;
		}
		const current = files.get(key);
		if (current === undefined) {
			stats.editsFailed += 1;
			failures.push({ path: key, seq: call.seq, reason: "no-baseline" });
			continue;
		}
		if (!current.includes(oldStr)) {
			stats.editsFailed += 1;
			failures.push({ path: key, seq: call.seq, reason: "old-string-not-found" });
			continue;
		}
		const next = call.args.replace_all === true
			? current.replaceAll(oldStr, newStr)
			: current.replace(oldStr, newStr);
		files.set(key, next);
		stats.editsApplied += 1;
	}

	const rows = [...files.entries()]
		.map(([path, content]) => ({
			path,
			content,
			bytes: Buffer.byteLength(content, "utf8"),
			lines: content.split("\n").length,
			resynced: resyncedFiles.has(path),
			shellTouched: shellTouched.has(path),
		}))
		.sort((a, b) => a.path.localeCompare(b.path));

	// Split the failures into the two cases a user actually cares about.
	//
	// `no-baseline` means the session *edited* a file it never *wrote*: the file
	// existed before this session started, so its full text was never in the
	// log. That is not a bug and not a partial recovery — it is a file this log
	// simply cannot contain. Reporting it in the same bucket as a genuinely
	// lost edit would overstate the damage and, worse, hide the real losses.
	const editedWithoutWrite = new Set(
		failures.filter((f) => f.reason === "no-baseline").map((f) => f.path),
	);
	const lostEdits = failures.filter((f) => f.reason !== "no-baseline");

	return {
		files: rows,
		stats: { ...stats, notInLog: editedWithoutWrite.size, lostEdits: lostEdits.length },
		failures,
		lostEdits,
		editedWithoutWrite: [...editedWithoutWrite].sort(),
		shellTouched: [...shellTouched].sort(),
	};
}
