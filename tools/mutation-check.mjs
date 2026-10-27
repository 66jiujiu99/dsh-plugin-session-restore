/**
 * 变异测试：故意破坏实现，确认测试真的会变红。
 *
 * 97 项全绿不是证据——如果断言写得空转，破坏实现照样绿。只有「破坏之后必须
 * 红」才能证明测试有牙齿。这个插件是给「数据已经丢了」的人用的，它的正确性
 * 没有第二次机会，所以更值得这样验一遍。
 *
 * Run: node tools/mutation-check.mjs
 */
import { readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const SUITES = ['tools/rebuild-check.mjs', 'tools/locale-check.mjs'];

const MUTATIONS = [
	{
		file: 'lib/session.js',
		// 精确复现那个真坑：只用第一帧，其余全丢。
		// 之前写成「把 to 改成 buf.length」是无效变异——第一帧解压失败被吞掉，
		// 后续帧仍然逐个解开，行为没变，所以测试不红是应该的。
		name: '只解第一帧（真实踩过的坑）',
		from: '\tconst frames = [];\n\tfor (let k = 0; k < starts.length; k += 1) {',
		to: '\tconst frames = [];\n\tfor (let k = 0; k < Math.min(1, starts.length); k += 1) {',
	},
	{
		file: 'lib/session.js',
		name: '不解析 arguments（当它是对象）',
		from: '\t\t\targs = JSON.parse(event.data?.arguments ?? "{}");',
		to: '\t\t\targs = event.data?.arguments ?? {};',
	},
	{
		file: 'lib/session.js',
		name: '结果按位置而非 callId 配对',
		from: '\t\tif (call.callId !== null && results.has(call.callId)) call.result = results.get(call.callId);',
		to: '\t\tfor (const [i, call] of calls.entries()) call.result = [...results.values()][i] ?? null;',
	},
	{
		file: 'lib/rebuild.js',
		name: '部分 read 也当全文（会截断文件）',
		from: '\t\t\tif (parsed.first !== 1 || parsed.last !== parsed.total) continue;',
		to: '\t\t\t// mutated: accept partial reads',
	},
	{
		file: 'lib/rebuild.js',
		name: '完全不用 read 重同步',
		from: '\t\t\tif (!useReads) continue;',
		to: '\t\t\tcontinue;',
	},
	{
		file: 'lib/rebuild.js',
		name: '空的 old_string 不拦（会插到开头）',
		from: '\t\tif (oldStr === "") {',
		to: '\t\tif (false) {',
	},
	{
		file: 'lib/rebuild.js',
		name: '不区分「日志里没有」和「真的丢了」',
		from: '\tconst lostEdits = failures.filter((f) => f.reason !== "no-baseline");',
		to: '\tconst lostEdits = failures;',
	},
	{
		file: 'lib/rebuild.js',
		name: '不检查路径是否越界',
		from: '\t\tif (!inside) {',
		to: '\t\tif (false) {',
	},
	{
		file: 'lib/export.js',
		// 这里有两道防线：先拒绝 `..` 段，再用 isInside 兜底。只拆一道不会红，
		// 那是纵深防御在起作用（第一版变异就是这么漏的）。要验证防线是真的，
		// 得把两道一起拆——拆完必须红。
		name: '同时拆掉两道穿越防线',
		from: '\tif (segments.some((s) => s === ".." || s === "")) return { ok: false, reason: "path-traversal" };\n\tconst full = join(targetDir, ...segments);\n\tif (!isInside(targetDir, full)) return { ok: false, reason: "path-traversal" };',
		to: '\tconst full = join(targetDir, ...segments);',
	},
	{
		file: 'lib/export.js',
		name: '不检查是否在工作区内',
		from: '\treturn target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);',
		to: '\treturn true;',
	},
	{
		file: 'lib/export.js',
		name: '允许导出到会话自己的工作区',
		from: '\t\tif (resolve(sessionCwd) === target) return { ok: false, reason: "target-is-workspace" };',
		to: '\t\t// mutated: writing into the workspace is allowed',
	},
	{
		file: 'lib/export.js',
		name: '总是覆盖已存在文件',
		from: '\t\tif (!overwrite && !dryRun) {',
		to: '\t\tif (false) {',
	},
];

const run = (args) => new Promise((resolve) => {
	const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
	let out = '';
	child.stdout.on('data', (c) => { out += c; });
	child.stderr.on('data', (c) => { out += c; });
	child.on('exit', (code) => resolve({ code, out }));
	child.on('error', () => resolve({ code: 1, out: '' }));
});

const failLines = (out) => out.split('\n').filter((line) => /^\s{2}FAIL/.test(line));
const passedCount = (out) => Number(out.match(/(\d+) checks passed/)?.[1] ?? 0);

// 基线必须全绿
for (const suite of SUITES) {
	const result = await run([suite]);
	console.log(`基线 ${suite}: ${passedCount(result.out)} 项通过, exit=${result.code}`);
	if (result.code !== 0) {
		console.error('基线就是红的，先修实现。');
		process.exit(1);
	}
}

const originals = new Map();
let caught = 0;
let missed = 0;
const missedNames = [];

try {
	for (const mutation of MUTATIONS) {
		const path = join(ROOT, mutation.file);
		if (!originals.has(mutation.file)) originals.set(mutation.file, await readFile(path, 'utf8'));
		const original = originals.get(mutation.file);
		if (!original.includes(mutation.from)) {
			console.log(`  SKIP  ${mutation.name}（锚点不在 ${mutation.file} 里）`);
			missed += 1;
			missedNames.push(`${mutation.name} [锚点缺失]`);
			continue;
		}
		await writeFile(path, original.replace(mutation.from, mutation.to), 'utf8');

		let anyRed = false;
		let detail = 0;
		for (const suite of SUITES) {
			const result = await run([suite]);
			const fails = failLines(result.out);
			if (result.code !== 0 && fails.length > 0) { anyRed = true; detail += fails.length; }
		}
		await writeFile(path, original, 'utf8');

		if (anyRed) {
			caught += 1;
			console.log(`  ok    ${mutation.name} → 被 ${detail} 项抓到`);
		} else {
			missed += 1;
			missedNames.push(mutation.name);
			console.error(`  MISS  ${mutation.name} → 破坏实现后测试仍然全绿`);
		}
	}
} finally {
	for (const [file, content] of originals) await writeFile(join(ROOT, file), content, 'utf8');
}

console.log(`\n变异测试：${caught} 个被抓住，${missed} 个漏网`);
if (missedNames.length > 0) console.log(`漏网: ${missedNames.join(', ')}`);

// 还原后必须回到全绿
for (const suite of SUITES) {
	const result = await run([suite]);
	console.log(`还原后 ${suite}: ${passedCount(result.out)} 项通过, exit=${result.code}`);
	if (result.code !== 0) process.exitCode = 1;
}
if (missed > 0) process.exitCode = 1;
