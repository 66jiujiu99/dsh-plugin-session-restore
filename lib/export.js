/**
 * Component: writing a rebuilt tree somewhere safe.
 *
 * Two rules, both learned the hard way:
 *
 * 1. **Never write into the workspace being recovered.** The whole reason this
 *    plugin exists is that a mistake destroyed a directory; a tool that writes
 *    by default would be the same mistake with a nicer button.
 * 2. **Never overwrite silently.** If the target already has a file, the caller
 *    is told, and only an explicit `overwrite` replaces it.
 *
 * Path traversal is refused outright: a session log records absolute paths from
 * whatever machine produced it, and one `../` in a hand-written call must not
 * escape the chosen directory.
 *
 * @module dsh-plugin-session-restore/lib/export
 */
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Whether `child` is inside `parent` (or equal to it).
 *
 * @param {string} parent - absolute directory.
 * @param {string} child - absolute path.
 * @returns {boolean}
 */
export function isInside(parent, child) {
	const base = resolve(parent);
	const target = resolve(child);
	if (target === base) return true;
	// Compare with a trailing separator so `C:/a-b` is not treated as inside `C:/a`.
	return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/**
 * Resolve one entry's destination, refusing anything that escapes the target.
 *
 * @param {string} targetDir - absolute export root.
 * @param {string} relativePath - path inside the rebuilt tree.
 * @returns {{ok:true, path:string}|{ok:false, reason:string}}
 */
export function destinationOf(targetDir, relativePath) {
	const rel = String(relativePath ?? "").replace(/\\/g, "/");
	if (rel === "" || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) {
		return { ok: false, reason: "absolute-path" };
	}
	const segments = rel.split("/");
	if (segments.some((s) => s === ".." || s === "")) return { ok: false, reason: "path-traversal" };
	const full = join(targetDir, ...segments);
	if (!isInside(targetDir, full)) return { ok: false, reason: "path-traversal" };
	return { ok: true, path: full };
}

/**
 * Write a rebuilt tree to a directory.
 *
 * @param {object} options
 * @param {string} options.targetDir - absolute destination directory.
 * @param {Array<{path:string, content:string}>} options.files - rebuilt entries.
 * @param {boolean} [options.overwrite] - replace files that already exist.
 * @param {boolean} [options.dryRun] - report what would happen, write nothing.
 * @returns {Promise<{written:string[], skipped:Array<{path:string,reason:string}>, refused:Array<{path:string,reason:string}>, bytes:number}>}
 */
export async function exportTree({ targetDir, files, overwrite = false, dryRun = false }) {
	const written = [];
	const skipped = [];
	const refused = [];
	let bytes = 0;

	for (const file of files) {
		const dest = destinationOf(targetDir, file.path);
		if (!dest.ok) {
			refused.push({ path: file.path, reason: dest.reason });
			continue;
		}
		if (dest.path === undefined) continue;

		if (!overwrite && !dryRun) {
			try {
				await stat(dest.path);
				skipped.push({ path: file.path, reason: "exists" });
				continue;
			} catch {
				// Not there: fine to write.
			}
		} else if (!overwrite && dryRun) {
			try {
				await stat(dest.path);
				skipped.push({ path: file.path, reason: "exists" });
				continue;
			} catch {
				// fall through
			}
		}

		if (!dryRun) {
			await mkdir(dirname(dest.path), { recursive: true });
			await writeFile(dest.path, file.content, "utf8");
			bytes += Buffer.byteLength(file.content, "utf8");
		}
		written.push(file.path);
	}

	return { written, skipped, refused, bytes };
}

/**
 * Reject a target directory that is clearly the wrong place to write.
 *
 * This is a guardrail, not a policy engine: it refuses the two cases that would
 * be actively destructive — exporting over the workspace the session came from,
 * and exporting into a directory that does not exist yet and whose parent looks
 * like a live profile.
 *
 * @param {string} targetDir - requested destination.
 * @param {string|null} sessionCwd - the session's workspace root.
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function checkTarget(targetDir, sessionCwd) {
	if (typeof targetDir !== "string" || targetDir.trim() === "") {
		return { ok: false, reason: "empty-target" };
	}
	const target = resolve(targetDir);
	if (sessionCwd !== null && sessionCwd !== undefined && sessionCwd !== "") {
		if (resolve(sessionCwd) === target) return { ok: false, reason: "target-is-workspace" };
	}
	if (target === resolve(sep)) return { ok: false, reason: "target-is-root" };
	return { ok: true };
}
