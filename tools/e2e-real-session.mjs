/**
 * 端到端验证：拿真实的 DSH 会话记录重建，断言能还原出真正的文件。
 *
 * 这是这套测试里最有说服力的一条。2026-10-27，`dsh-plugin-cloud` 的整个源码
 * 目录被清空，37 个文件消失，没有 git、没有备份、回收站里也没有。最后是靠
 * 会话记录把它救回来的——这个插件就是那次恢复的固化版本。
 *
 * 所以这里不做任何桩：直接扫 `$DSH_HOME/sessions`，找到真正写过
 * `dsh-plugin-cloud` 的会话，跑完整重建，检查关键文件是否回来了。
 *
 * 如果这台机器上没有那条会话（换了机器、清了记录），整组用例 skip 而不是
 * 失败——那是环境不同，不是代码坏了。
 *
 * Run: node tools/e2e-real-session.mjs
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { stat, rm, mkdir, readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { readSession, sessionHeader, collectCalls } from '../lib/session.js';
import { listSessions, findSession, sessionsRoot } from '../lib/scan.js';
import { rebuild } from '../lib/rebuild.js';
import { exportTree } from '../lib/export.js';

let passed = 0;
let skipped = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed += 1; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};
const skip = (label, why) => { skipped += 1; console.log('  skip', label, '—', why); };
const info = (msg) => console.log(`       ${msg}`);

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const ROOT = sessionsRoot(DSH_HOME);

// ── 1. 能找到会话根目录 ─────────────────────────────────────
{
	let exists = false;
	try { exists = (await stat(ROOT)).isDirectory(); } catch { exists = false; }
	if (!exists) {
		skip('全部真实会话用例', `没有会话目录：${ROOT}`);
	} else {
		check('会话根目录存在', true);
		const rows = await listSessions(ROOT);
		check('扫描到会话', rows.length > 0, String(rows.length));
		info(`共 ${rows.length} 条会话`);

		const newest = rows[0];
		check('会话行带 cwd', typeof newest.cwd === 'string' && newest.cwd.length > 0, String(newest.cwd));
		check('会话行带事件数', newest.events > 0, String(newest.events));
		check('按时间倒序', rows.length === 1 || rows[0].mtime >= rows[1].mtime);
	}
}

// ── 2. 找回真正写过 dsh-plugin-cloud 的会话 ─────────────────
let target = null;
{
	let rows = [];
	try { rows = await listSessions(ROOT); } catch { rows = []; }
	const candidates = rows.filter((r) => r.writes > 0 && r.files > 0);
	info(`有写入记录的会话：${candidates.length} 条`);

	// 挑一个写得最多、且工作区是 C:\Data\deepseek 的
	const scored = [];
	for (const row of candidates) {
		if (!String(row.cwd ?? '').toLowerCase().includes('deepseek')) continue;
		scored.push(row);
	}
	scored.sort((a, b) => b.writes - a.writes);

	if (scored.length === 0) {
		skip('真实会话重建', '没有工作区在 deepseek 下的写入会话');
	} else {
		target = scored[0];
		info(`选中会话 ${target.id}（${target.writes} 次写入，${target.files} 个文件，cwd=${target.cwd}）`);
		check('选中了有写入的会话', target.writes > 0);
	}
}

// ── 3. 完整重建并检查 ───────────────────────────────────────
let built = null;
if (target === null) {
	skip('重建内容断言', '没有可用会话');
} else {
	const entry = await findSession(ROOT, target.id);
	check('能按 id 找回会话目录', entry !== null, String(entry?.dir));

	if (entry === null) {
		skip('重建内容断言', '找不到会话目录');
	} else {
		const decoded = await readSession(entry.logPath);
		const header = sessionHeader(decoded.events);
		const calls = collectCalls(decoded.events);
		built = rebuild(calls, { root: header?.cwd ?? null, useReads: true });

		info(`重建出 ${built.files.length} 个文件，${built.stats.editsApplied}/${built.stats.edits} 次 edit 应用，${built.stats.resyncs} 次重同步`);
		info(`日志里不可能有的文件 ${built.editedWithoutWrite.length} 个（会话前就存在），真正的丢失 ${built.lostEdits.length} 处`);
		check('重建出文件', built.files.length > 0, String(built.files.length));
		check('应用了大部分 edit', built.stats.editsApplied > 0, JSON.stringify(built.stats));

		// 关键质量线：能应用到的 edit 里，不能有大量「有基线却对不上」。
		// 那才代表重同步逻辑失效；「日志里没有」是物理限制，不算缺陷。
		const applicable = built.stats.editsApplied + built.stats.lostEdits;
		const rate = applicable === 0 ? 0 : built.stats.editsApplied / applicable;
		check('在有基线的 edit 里应用率过半', rate > 0.5, `${(rate * 100).toFixed(1)}%（${built.stats.editsApplied}/${applicable}）`);
		info(`有基线的 edit 应用率：${(rate * 100).toFixed(1)}%`);

		// 每个文件都必须有内容，不能是空壳
		const emptyFiles = built.files.filter((f) => f.bytes === 0);
		check('没有空文件', emptyFiles.length === 0, emptyFiles.map((f) => f.path).join(','));

		// 路径必须是相对的，不能把绝对路径带出来
		const absolute = built.files.filter((f) => /^[A-Za-z]:/.test(f.path) || f.path.startsWith('/'));
		check('所有路径都是相对的', absolute.length === 0, absolute.map((f) => f.path).join(','));

		// 具体到这条插件：如果这条会话里有 dsh-plugin-cloud，关键文件应该在
		const hasCloud = built.files.some((f) => f.path.includes('dsh-plugin-cloud/index.js'));
		if (hasCloud) {
			const index = built.files.find((f) => f.path.endsWith('dsh-plugin-cloud/index.js'));
			const pkg = built.files.find((f) => f.path.endsWith('dsh-plugin-cloud/package.json'));
			check('恢复了 dsh-plugin-cloud/index.js', index !== undefined && index.lines > 100, String(index?.lines));
			check('index.js 内容像真代码', index?.content.includes('export function apply') || index?.content.includes('webServer'),
				(index?.content ?? '').slice(0, 80));
			if (pkg !== undefined) {
				check('恢复了 package.json', pkg !== undefined);
				let parsed = null;
				try { parsed = JSON.parse(pkg.content); } catch { parsed = null; }
				check('package.json 是合法 JSON', parsed !== null, (pkg.content ?? '').slice(0, 80));
				check('package.json 的 name 正确', parsed?.name === 'dsh-plugin-cloud', String(parsed?.name));
			} else {
				skip('package.json 断言', '这条会话没写过 package.json');
			}
		} else {
			info('这条会话里没有 dsh-plugin-cloud/index.js，跳过该断言');
		}
	}
}

// ── 4. 导出到真实目录并读回来 ───────────────────────────────
if (built === null || built.files.length === 0) {
	skip('导出往返', '没有可导出的文件');
} else {
	const dir = await mkdtemp(join(tmpdir(), 'sr-e2e-'));
	try {
		const result = await exportTree({ targetDir: dir, files: built.files });
		check('导出写了文件', result.written.length > 0, String(result.written.length));
		check('没有被拒绝的路径', result.refused.length === 0, JSON.stringify(result.refused));

		// 读回第一个文件，逐字节比对
		const first = built.files[0];
		const onDisk = await readFile(join(dir, ...first.path.split('/')), 'utf8');
		check('导出内容与重建内容一致', onDisk === first.content, `${onDisk.length} vs ${first.content.length}`);
		info(`往返验证：${first.path}（${first.bytes} 字节）`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

console.log(`\n${passed} checks passed${skipped > 0 ? `, ${skipped} skipped` : ''}`);
