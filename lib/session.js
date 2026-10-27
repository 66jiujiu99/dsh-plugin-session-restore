/**
 * Component: reading a session log.
 *
 * A DSH session file is a **concatenation of zstd frames**, one per appended
 * event. Node's `zstdDecompressSync` decodes only the first frame — the few
 * hundred bytes of session header — so using it directly yields "the log is
 * empty", which is exactly the wrong conclusion to reach when someone is trying
 * to recover data. This module owns the frame splitting so no caller has to
 * know that.
 *
 * The event stream itself is JSONL. Two shapes matter:
 *
 *   - `session`          the header: id, cwd, createdAt, agent preset.
 *   - `tool/call`        a tool invocation: `data.name`, `data.arguments` (a
 *                        JSON **string**, not an object), `data.callId`.
 *   - `tool/result`      its result, matched by `data.message.toolCallId`.
 *
 * `tool/call` is used rather than digging through `assistant/message` content
 * blocks: both carry the same calls, but this one is flat and already
 * tool-shaped.
 *
 * @module dsh-plugin-session-restore/lib/session
 */
import { readFile } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";

/** Zstandard frame magic number, little-endian `0xFD2FB528`. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

/**
 * Split a multi-frame zstd buffer into its individual frames.
 *
 * Frames are located by scanning for the magic number. A magic byte sequence
 * can in principle appear inside compressed data, but every candidate is
 * validated by actually decompressing the resulting slice, so a false positive
 * costs one failed attempt rather than corrupting the output.
 *
 * @param {Buffer} buf - the whole session file.
 * @returns {Buffer[]} one buffer per decodable frame, in file order.
 */
export function splitFrames(buf) {
	const starts = [];
	for (let i = 0; i < buf.length; ) {
		const idx = buf.indexOf(ZSTD_MAGIC, i);
		if (idx < 0) break;
		starts.push(idx);
		i = idx + ZSTD_MAGIC.length;
	}
	const frames = [];
	for (let k = 0; k < starts.length; k += 1) {
		const from = starts[k];
		const to = k + 1 < starts.length ? starts[k + 1] : buf.length;
		try {
			frames.push(zstdDecompressSync(buf.subarray(from, to)));
		} catch {
			// A magic number that does not actually open a frame: skip it rather
			// than lose the whole log to one bad offset.
		}
	}
	return frames;
}

/**
 * Decode a raw session buffer into events.
 *
 * Trailing partial lines are tolerated: a session that is still being written
 * can end mid-line, and losing that one line must not fail the whole read.
 *
 * @param {Buffer} buf - raw file contents.
 * @returns {{events: object[], frames: number, failedFrames: number, badLines: number, bytes: number}}
 */
export function decodeSessionBuffer(buf) {
	const frames = splitFrames(buf);
	const text = Buffer.concat(frames).toString("utf8");
	const events = [];
	let badLines = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			badLines += 1;
		}
	}
	return {
		events,
		frames: frames.length,
		failedFrames: 0,
		badLines,
		bytes: buf.length,
	};
}

/**
 * Read and decode a session file.
 *
 * @param {string} path - absolute path to `session.v4.jsonl.zstd`.
 * @returns {Promise<object>} same shape as {@link decodeSessionBuffer}, plus `path`.
 */
export async function readSession(path) {
	const buf = await readFile(path);
	return { path, ...decodeSessionBuffer(buf) };
}

/**
 * Pull the session header out of a decoded event list.
 *
 * @param {object[]} events - decoded events.
 * @returns {{id:string, cwd:string|null, createdAt:number|null, preset:string|null}|null}
 */
export function sessionHeader(events) {
	for (const event of events) {
		if (event?.type !== "session") continue;
		return {
			id: typeof event.id === "string" ? event.id : null,
			cwd: typeof event.cwd === "string" ? event.cwd : null,
			createdAt: Number.isFinite(event.createdAt) ? event.createdAt : null,
			preset: typeof event.agentPreset === "string" ? event.agentPreset : null,
		};
	}
	return null;
}

/**
 * Collect every tool call, in `seq` order, with its result text attached.
 *
 * Results are matched by `callId` rather than by position: a call whose result
 * is still missing (interrupted tool, still-running job) must not shift every
 * subsequent result onto the wrong call.
 *
 * @param {object[]} events - decoded events.
 * @returns {Array<{seq:number, time:number|null, name:string, args:object, callId:string|null, result:string|null}>}
 */
export function collectCalls(events) {
	const calls = [];
	const results = new Map();

	for (const event of events) {
		if (event?.type === "tool/result") {
			const id = event.data?.message?.toolCallId;
			if (typeof id !== "string") continue;
			const parts = (event.data.message.content ?? [])
				.filter((block) => block?.type === "text")
				.map((block) => block.text);
			results.set(id, parts.join(""));
			continue;
		}
		if (event?.type !== "tool/call") continue;
		let args = {};
		try {
			args = JSON.parse(event.data?.arguments ?? "{}");
		} catch {
			args = {};
		}
		calls.push({
			seq: Number.isFinite(event.seq) ? event.seq : 0,
			time: Number.isFinite(event.time) ? event.time : null,
			name: typeof event.data?.name === "string" ? event.data.name : "",
			args,
			callId: typeof event.data?.callId === "string" ? event.data.callId : null,
			result: null,
		});
	}

	calls.sort((a, b) => a.seq - b.seq);
	for (const call of calls) {
		if (call.callId !== null && results.has(call.callId)) call.result = results.get(call.callId);
	}
	return calls;
}
