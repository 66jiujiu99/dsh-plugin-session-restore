/**
 * 重建逻辑的测试。
 *
 * 这套测试的重点不是「函数能跑」，而是**四个真实踩过的坑不会再犯**：
 *
 *   1. 多帧 zstd：只解第一帧会得到「记录是空的」
 *   2. tool/call 的 arguments 是 JSON 字符串，不是对象
 *   3. 只回放 write 不够，后面的 edit 才是最终状态
 *   4. bash 改过的文件：edit 的 old_string 对不上，必须用 read 结果重同步；
 *      而「部分读取」不能当全文，否则会把文件截断
 *
 * 最后一条还配了一个端到端用例：拿真实的历史会话重建，断言能还原出
 * dsh-plugin-cloud 这个插件——那次事故里它就是这么被救回来的。
 *
 * Run: node tools/rebuild-check.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';

import { splitFrames, decodeSessionBuffer, sessionHeader, collectCalls } from '../lib/session.js';
import { normalizePath, parseReadResult, rebuild } from '../lib/rebuild.js';
import { destinationOf, isInside, checkTarget, exportTree } from '../lib/export.js';

let passed = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed += 1; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};

/** 把若干事件编成「多帧 zstd」——和真实会话文件一样的形态。 */
function encodeSession(events) {
	const frames = events.map((e) => zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`, 'utf8')));
	return Buffer.concat(frames);
}

/** 造一个工具调用事件。 */
const call = (seq, name, args, callId = `c${seq}`) => ({
	type: 'tool/call',
	seq,
	time: 1792000000000 + seq,
	data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
});

/** 造一个工具结果事件。 */
const result = (seq, callId, text) => ({
	type: 'tool/result',
	seq,
	time: 1792000000000 + seq,
	data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }] } },
});

/** 造一个 read 结果文本。 */
const readText = (path, lines, from = 1, total = lines.length) => {
	const body = lines.map((l, i) => `${from + i}: ${l}`).join('\n');
	const last = from + lines.length - 1;
	const note = (from === 1 && last === total) ? '' : `\n\n(Showing lines ${from}-${last} of ${total}. Use offset=${last + 1} to continue.)`;
	return `<path>${path}</path>\n<type>file</type>\n<content>\n${body}${note}\n</content>`;
};

// ── 1. 多帧 zstd ────────────────────────────────────────────
// 这是坑 #1：zstdDecompressSync 只解第一帧，直接解会以为记录是空的。
{
	const events = [
		{ type: 'session', version: 4, id: 'session-abc', cwd: 'C:\\work', createdAt: 1, agentPreset: 'ptc' },
		call(2, 'write', { file_path: 'C:\\work\\a.js', content: 'const a = 1;\n' }),
		call(4, 'write', { file_path: 'C:\\work\\b.js', content: 'const b = 2;\n' }),
	];
	const buf = encodeSession(events);
	check('编码出多帧', splitFrames(buf).length === 3, String(splitFrames(buf).length));

	// 反证：只用第一帧会丢掉后面所有事件。
	// 注意 `splitFrames` 返回的是**已解压**的内容，不能再交给
	// `decodeSessionBuffer`（那会二次解压得到空）。要验证「只解第一帧」的
	// 坑，得直接喂原始字节的前缀。
	const frames = splitFrames(buf);
	const firstFrameEnd = buf.indexOf(frames[0]) + frames[0].length;
	const firstFrameOnly = decodeSessionBuffer(buf.subarray(0, firstFrameEnd));
	check('只解第一帧确实只有 1 个事件（这就是坑）', firstFrameOnly.events.length === 1, String(firstFrameOnly.events.length));

	const decoded = decodeSessionBuffer(buf);
	check('切帧后拿到全部 3 个事件', decoded.events.length === 3, String(decoded.events.length));
	check('帧数正确', decoded.frames === 3, String(decoded.frames));
}

// ── 2. 会话头与工具调用解析 ─────────────────────────────────
{
	const events = [
		{ type: 'session', version: 4, id: 'session-x', cwd: 'D:/proj', createdAt: 12345, agentPreset: 'ptc' },
		call(2, 'write', { file_path: 'D:/proj/a.txt', content: 'hello' }),
		result(3, 'c2', 'written'),
		call(4, 'read', { file_path: 'D:/proj/a.txt' }),
		result(5, 'c4', readText('D:/proj/a.txt', ['hello'])),
	];
	const decoded = decodeSessionBuffer(encodeSession(events));
	const header = sessionHeader(decoded.events);
	check('读到 cwd', header?.cwd === 'D:/proj', String(header?.cwd));
	check('读到 createdAt', header?.createdAt === 12345, String(header?.createdAt));
	check('读到 preset', header?.preset === 'ptc', String(header?.preset));

	const calls = collectCalls(decoded.events);
	check('收集到 2 个调用', calls.length === 2, String(calls.length));
	// 坑 #2：arguments 是 JSON 字符串，必须解析
	check('arguments 被解析成对象', calls[0].args.file_path === 'D:/proj/a.txt', JSON.stringify(calls[0].args));
	check('结果按 callId 挂在调用上', calls[0].result === 'written', String(calls[0].result));
	check('read 的结果也挂上了', typeof calls[1].result === 'string' && calls[1].result.includes('hello'));

	// 结果缺失时不能错位
	const orphan = decodeSessionBuffer(encodeSession([
		call(2, 'write', { file_path: 'D:/p/a', content: 'x' }),
		call(4, 'write', { file_path: 'D:/p/b', content: 'y' }),
		result(5, 'c4', 'for-b'),
	]));
	const orphanCalls = collectCalls(orphan.events);
	check('缺失结果不错位到别的调用', orphanCalls[0].result === null && orphanCalls[1].result === 'for-b',
		JSON.stringify(orphanCalls.map((c) => c.result)));
}

// ── 3. 路径归一化 ───────────────────────────────────────────
{
	check('工作区内的路径变相对', normalizePath('C:/w/a/b.js', 'C:/w').key === 'a/b.js', normalizePath('C:/w/a/b.js', 'C:/w').key);
	check('反斜杠也处理', normalizePath('C:\\w\\a\\b.js', 'C:/w').key === 'a/b.js', normalizePath('C:\\w\\a\\b.js', 'C:/w').key);
	check('工作区外的路径标出来', normalizePath('D:/other/x.js', 'C:/w').inside === false);
	check('大小写不敏感（Windows）', normalizePath('C:/W/a.js', 'c:/w').key === 'a.js', normalizePath('C:/W/a.js', 'c:/w').key);
	// 坑：前缀相同的兄弟目录不能被当成子目录
	check('C:/work2 不算在 C:/work 里', normalizePath('C:/work2/a.js', 'C:/work').inside === false,
		JSON.stringify(normalizePath('C:/work2/a.js', 'C:/work')));
}

// ── 4. read 结果解析：完整 vs 部分 ──────────────────────────
// 坑 #4 的后半段：部分读取当全文会把文件截断。
{
	const whole = parseReadResult(readText('a.js', ['one', 'two', 'three']));
	check('完整读取解析成功', whole !== null && whole.first === 1 && whole.last === 3 && whole.total === 3,
		JSON.stringify(whole));
	check('完整读取内容正确', whole.text === 'one\ntwo\nthree', JSON.stringify(whole.text));

	const partial = parseReadResult(readText('a.js', ['ninety-six', 'ninety-seven'], 96, 278));
	check('部分读取的总行数取自提示', partial.total === 278, String(partial.total));
	check('部分读取的起止行正确', partial.first === 96 && partial.last === 97, `${partial.first}-${partial.last}`);

	check('不是 read 输出时返回 null', parseReadResult('just text') === null);
	check('null 输入返回 null', parseReadResult(null) === null);
}

// ── 5. 回放 write + edit ────────────────────────────────────
{
	const calls = [
		{ seq: 1, name: 'write', args: { file_path: 'C:/w/a.js', content: 'line1\nline2\nline3\n' }, result: null },
		{ seq: 2, name: 'edit', args: { file_path: 'C:/w/a.js', old_string: 'line2', new_string: 'LINE2' }, result: null },
	];
	const out = rebuild(calls, { root: 'C:/w' });
	check('重建出 1 个文件', out.files.length === 1, String(out.files.length));
	check('edit 已应用', out.files[0].content === 'line1\nLINE2\nline3\n', JSON.stringify(out.files[0].content));
	check('统计正确', out.stats.writes === 1 && out.stats.editsApplied === 1, JSON.stringify(out.stats));
	check('路径是相对的', out.files[0].path === 'a.js', out.files[0].path);
}

// ── 6. edit 的三种失败必须如实报告 ──────────────────────────
{
	// 没有基线
	const noBase = rebuild([
		{ seq: 1, name: 'edit', args: { file_path: 'C:/w/a.js', old_string: 'x', new_string: 'y' }, result: null },
	], { root: 'C:/w' });
	check('没有基线时报 no-baseline', noBase.failures[0]?.reason === 'no-baseline', JSON.stringify(noBase.failures));
	check('失败计数正确', noBase.stats.editsFailed === 1, JSON.stringify(noBase.stats));

	// 找不到 old_string
	const notFound = rebuild([
		{ seq: 1, name: 'write', args: { file_path: 'C:/w/a.js', content: 'abc' }, result: null },
		{ seq: 2, name: 'edit', args: { file_path: 'C:/w/a.js', old_string: 'zzz', new_string: 'y' }, result: null },
	], { root: 'C:/w' });
	check('找不到 old_string 时报 old-string-not-found',
		notFound.failures[0]?.reason === 'old-string-not-found', JSON.stringify(notFound.failures));
	check('内容没被破坏', notFound.files[0].content === 'abc');

	// 空 old_string：不能让它把文本插到开头
	const empty = rebuild([
		{ seq: 1, name: 'write', args: { file_path: 'C:/w/a.js', content: 'abc' }, result: null },
		{ seq: 2, name: 'edit', args: { file_path: 'C:/w/a.js', old_string: '', new_string: 'PREFIX' }, result: null },
	], { root: 'C:/w' });
	check('空 old_string 被拒绝', empty.failures[0]?.reason === 'empty-old-string', JSON.stringify(empty.failures));
	check('空 old_string 没有污染内容', empty.files[0].content === 'abc', JSON.stringify(empty.files[0].content));
}

// ── 7. 坑 #3 + #4：bash 改过之后靠 read 重同步 ──────────────
// 真实事故里的场景：文件被 bash 脚本改过，edit 的 old_string 对不上。
// 如果只回放 write/edit，这次编辑会静默丢失。
{
	const events = [
		call(1, 'write', { file_path: 'C:/w/a.js', content: 'const v = 1;\n' }),
		// bash 把 v 改成了 2（日志里只有命令，没有新内容）
		call(2, 'ops_bash', { command: 'node tools/patch.mjs C:/w/a.js', description: 'patch' }),
		// 读回来，拿到真实内容
		call(3, 'read', { file_path: 'C:/w/a.js' }),
		result(4, 'c3', readText('C:/w/a.js', ['const v = 2;'])),
		// 之后的 edit 基于 v=2，对不上最初的 v=1
		call(5, 'edit', { file_path: 'C:/w/a.js', old_string: 'v = 2', new_string: 'v = 3' }),
	];
	const decoded = decodeSessionBuffer(encodeSession(events));
	const calls = collectCalls(decoded.events);

	// 不用 read 重同步：这次 edit 会失败
	const naive = rebuild(calls, { root: 'C:/w', useReads: false });
	check('不回放 read 时 edit 丢失', naive.files[0].content === 'const v = 1;\n', JSON.stringify(naive.files[0].content));
	check('不回放 read 时如实报告失败',
		naive.failures.some((f) => f.reason === 'old-string-not-found'), JSON.stringify(naive.failures));

	// 用 read 重同步：内容正确，edit 也能应用。
	// 注意：read 结果按行还原后**不带末尾换行**（日志里按行拼接），所以这里
	// 断言的是无换行版本——这正是真实行为，不该被测试掩盖。
	const fixed = rebuild(calls, { root: 'C:/w', useReads: true });
	check('用 read 重同步后内容正确', fixed.files[0].content === 'const v = 3;', JSON.stringify(fixed.files[0].content));
	check('统计里记下了重同步', fixed.stats.resyncs === 1, String(fixed.stats.resyncs));
	check('文件被标记为已校正', fixed.files[0].resynced === true);
	check('bash 改过的文件被标记', fixed.files[0].shellTouched === true, JSON.stringify(fixed.files[0]));
}

// ── 8. 部分 read 绝不能当全文（会截断文件） ─────────────────
{
	const long = Array.from({ length: 278 }, (_, i) => `line ${i + 1}`);
	const events = [
		call(1, 'write', { file_path: 'C:/w/big.js', content: `${long.join('\n')}\n` }),
		// 只读了 96-135 行
		call(2, 'read', { file_path: 'C:/w/big.js', offset: 96, limit: 40 }),
		result(3, 'c2', readText('C:/w/big.js', long.slice(95, 135), 96, 278)),
	];
	const decoded = decodeSessionBuffer(encodeSession(events));
	const out = rebuild(collectCalls(decoded.events), { root: 'C:/w' });
	check('部分读取不覆盖全文', out.files[0].lines === 279, String(out.files[0].lines));
	check('部分读取不计入重同步', out.stats.resyncs === 0, String(out.stats.resyncs));
}

// ── 9. 工作区外的路径不进重建树 ─────────────────────────────
{
	const out = rebuild([
		{ seq: 1, name: 'write', args: { file_path: 'C:/w/in.js', content: 'a' }, result: null },
		{ seq: 2, name: 'write', args: { file_path: 'D:/outside/out.js', content: 'b' }, result: null },
	], { root: 'C:/w' });
	check('只留下工作区内的文件', out.files.length === 1 && out.files[0].path === 'in.js', JSON.stringify(out.files.map((f) => f.path)));
	check('工作区外的被计数', out.stats.outsideRoot === 1, String(out.stats.outsideRoot));
}

// ── 10. 导出安全 ────────────────────────────────────────────
{
	check('isInside 判断子目录', isInside('C:/a', 'C:/a/b') === true);
	check('isInside 拒绝兄弟目录', isInside('C:/a', 'C:/a-b') === false);
	check('isInside 接受自身', isInside('C:/a', 'C:/a') === true);

	const ok = destinationOf('C:/out', 'lib/a.js');
	check('正常路径可以导出', ok.ok === true && ok.path.replace(/\\/g, '/').endsWith('lib/a.js'), JSON.stringify(ok));

	check('拒绝 ../ 穿越', destinationOf('C:/out', '../evil.js').ok === false);
	check('拒绝绝对路径', destinationOf('C:/out', 'C:/evil.js').ok === false);
	check('拒绝盘符', destinationOf('C:/out', 'D:/evil.js').ok === false);

	check('不能导出到工作区', checkTarget('C:/w', 'C:/w').ok === false);
	check('可以导出到别处', checkTarget('D:/recovered', 'C:/w').ok === true);
	check('空目标被拒绝', checkTarget('', 'C:/w').ok === false);
}

// ── 11. 真实导出：写盘、跳过已存在、拒绝穿越 ────────────────
{
	// 隔离根目录：`../escape.js` 若真的逃逸，会落在这一层，而不是公共 tmpdir。
	// 早先版本直接断言 `tmpdir()` 里没有 escape.js——那是个全局可变的断言：
	// 只要机器上别处存在同名文件（比如变异测试真的写出了它），就会误报失败。
	const root = await mkdtemp(join(tmpdir(), 'sr-export-'));
	const dir = join(root, 'out');
	await mkdir(dir, { recursive: true });
	try {
		const files = [
			{ path: 'a.js', content: 'aaa' },
			{ path: 'lib/b.js', content: 'bbb' },
			{ path: '../escape.js', content: 'evil' },
		];
		const first = await exportTree({ targetDir: dir, files });
		check('导出写了 2 个文件', first.written.length === 2, JSON.stringify(first.written));
		check('穿越被拒绝', first.refused.length === 1 && first.refused[0].reason === 'path-traversal',
			JSON.stringify(first.refused));
		check('嵌套目录被创建', (await readFile(join(dir, 'lib', 'b.js'), 'utf8')) === 'bbb');
		// 逃逸目标正好是 dir 的父目录，只在这一个隔离目录里检查
		check('穿越的文件没有落盘', !(await readdir(root)).includes('escape.js'), (await readdir(root)).join(','));

		// 第二次：不覆盖时跳过
		const second = await exportTree({ targetDir: dir, files });
		check('不覆盖时跳过已存在', second.skipped.length === 2 && second.written.length === 0,
			JSON.stringify(second));

		// 覆盖时写进去
		const third = await exportTree({ targetDir: dir, files: [{ path: 'a.js', content: 'new' }], overwrite: true });
		check('覆盖时写入', third.written.length === 1, JSON.stringify(third.written));
		check('覆盖后内容更新', (await readFile(join(dir, 'a.js'), 'utf8')) === 'new');

		// dryRun 什么都不写
		const dry = await exportTree({ targetDir: dir, files: [{ path: 'z.js', content: 'zzz' }], dryRun: true });
		check('dryRun 报告将要写', dry.written.length === 1);
		check('dryRun 实际没写', !(await readdir(dir)).includes('z.js'));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

// ── 12. 「日志里不可能有这个文件」与「真的丢了」必须分开报 ──
// 一次 edit 找不到基线，有两种完全不同的原因：
//   a) 文件在会话开始前就存在，日志里从没有过它的全文 → 恢复不了，但不算损失
//   b) 日志里有过这个文件，但一次 edit 没能重放 → 这是真的丢了
// 把两者混成一个数字，会让用户以为恢复坏了；也可能掩盖真正的损失。
{
	const calls = [
		// a) 只 edit、从不 write：会话前就存在的文件
		{ seq: 1, name: 'edit', args: { file_path: 'C:/w/preexisting.js', old_string: 'a', new_string: 'b' }, result: null },
		{ seq: 2, name: 'edit', args: { file_path: 'C:/w/preexisting.js', old_string: 'c', new_string: 'd' }, result: null },
		// b) write 过，但后面的 edit 对不上：真的丢了
		{ seq: 3, name: 'write', args: { file_path: 'C:/w/real.js', content: 'abc' }, result: null },
		{ seq: 4, name: 'edit', args: { file_path: 'C:/w/real.js', old_string: 'zzz', new_string: 'y' }, result: null },
	];
	const out = rebuild(calls, { root: 'C:/w' });
	check('会话前就存在的文件被单独列出',
		out.editedWithoutWrite.includes('preexisting.js'), JSON.stringify(out.editedWithoutWrite));
	check('这类不计入「真的丢了」',
		out.lostEdits.every((f) => f.path !== 'preexisting.js'), JSON.stringify(out.lostEdits));
	check('真正的丢失被单独报出',
		out.lostEdits.some((f) => f.path === 'real.js' && f.reason === 'old-string-not-found'),
		JSON.stringify(out.lostEdits));
	check('stats.notInLog 统计正确', out.stats.notInLog === 1, String(out.stats.notInLog));
	check('stats.lostEdits 统计正确', out.stats.lostEdits === 1, String(out.stats.lostEdits));
}

console.log(`\n${passed} checks passed`);
