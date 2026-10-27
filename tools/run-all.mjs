/**
 * 一次跑完全部测试。
 *
 * 三套：
 *   - 重建逻辑（含四个真实踩过的坑）
 *   - 文案一致性
 *   - 真实会话端到端（没有会话记录时 skip，不算失败）
 *
 * Run: node tools/run-all.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const SUITES = [
	{ name: '重建逻辑与导出安全', file: 'tools/rebuild-check.mjs' },
	{ name: '文案一致性与错误码', file: 'tools/locale-check.mjs' },
	{ name: 'HTTP 路由', file: 'tools/http-check.mjs' },
	{ name: '真实会话端到端', file: 'tools/e2e-real-session.mjs' },
];

let failed = 0;
const results = [];

for (const suite of SUITES) {
	await new Promise((resolve) => {
		const child = spawn(process.execPath, [suite.file], {
			cwd: process.cwd(),
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		child.stdout.on('data', (c) => { out += c; });
		child.stderr.on('data', (c) => { out += c; });
		child.on('error', (error) => { out += `\n无法启动: ${error.message}`; });
		child.on('exit', (exitCode) => {
			const passed = Number(out.match(/(\d+) checks passed/)?.[1] ?? 0);
			const skipped = Number(out.match(/(\d+) skipped/)?.[1] ?? 0);
			results.push({ name: suite.name, passed, skipped, ok: exitCode === 0 });
			if (exitCode !== 0) {
				failed += 1;
				console.log(`\n✗ ${suite.name}`);
				console.log(out.trim().split('\n').filter((l) => /FAIL|Error/.test(l)).join('\n'));
			} else {
				console.log(`✓ ${suite.name} — ${passed} 项${skipped > 0 ? ` (${skipped} 跳过)` : ''}`);
			}
			resolve();
		});
	});
	await sleep(50);
}

const total = results.reduce((sum, r) => sum + r.passed, 0);
const skippedTotal = results.reduce((sum, r) => sum + r.skipped, 0);
console.log(`\n合计：${total} 项检查${skippedTotal > 0 ? `，${skippedTotal} 项跳过` : ''}，${SUITES.length - failed}/${SUITES.length} 套通过`);
if (failed > 0) process.exitCode = 1;
