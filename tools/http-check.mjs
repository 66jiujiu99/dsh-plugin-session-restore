/**
 * 不起 DSH，直接喂一个假的 webServer，验证路由行为。
 *
 * 重启 DSH 才能看到真实界面，但路由逻辑可以先在这里验一遍：如果连这条都不过，
 * 重启就是在赌。
 *
 * Run: node tools/http-check.mjs
 */
import { apply } from '../index.js';

let passed = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed += 1; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};

// ── 造一个最小的 webServer / ctx 假件 ───────────────────────
// 必须模拟真实的 `register({kind:'prefix', path, handler})`：第一版插件用的是
// `webServer.use()`，而宿主只认 register，结果界面出来了、每个接口都返回纯文本
// `not found`。这个假件就是为了让那种错在测试里立刻暴露，而不是等重启之后。
let registered = null;
const ctx = {
	inject(deps, fn) {
		// 真实的 ctx.inject 会等依赖就绪再回调；这里直接调用并给一个 scope。
		const scope = {
			webServer: {
				register(spec) {
					registered = spec;
					return () => { registered = null; };
				},
			},
			effect(fn) { return fn(); },
		};
		fn(scope);
	},
	get() { return undefined; },
};
apply(ctx);
check('注册了 prefix 路由', registered !== null && registered.kind === 'prefix', JSON.stringify(registered?.kind));
check('路由前缀正确', registered?.path === '/api/session-restore', String(registered?.path));

/** 发一个假请求：按 prefix 语义把路径交给 handler。 */
async function request(method, path, body, { stripPrefix = false } = {}) {
	const handler = registered?.handler;
	if (typeof handler !== 'function') throw new Error('没有注册 handler');
	// 宿主对 prefix 路由有两种可能的约定：传完整 pathname，或传已剥掉前缀的。
	// 插件必须两种都吃得下——否则「已经剥过又剥一次」会把 `/sessions` 变成
	// `ons`，每个接口都 404，看起来就像插件没加载。这里两种都测。
	const url = new URL(path, 'http://localhost');
	const pathname = stripPrefix && url.pathname.startsWith('/api/session-restore')
		? url.pathname.slice('/api/session-restore'.length) || '/'
		: url.pathname;
	const reqPath = `${pathname}${url.search}`;

	return new Promise((resolve) => {
		const listeners = {};
		const req = {
			method,
			url: reqPath,
			on(event, cb) { listeners[event] = cb; },
			destroy() {},
		};
		let status = 0;
		let payload = '';
		const res = {
			writeHead(code) { status = code; },
			end(text) { payload = text ?? ''; },
		};
		Promise.resolve(handler(req, res)).then(() => {
			let json = null;
			try { json = JSON.parse(payload); } catch { json = null; }
			resolve({ status, json, raw: payload });
		});
		if (body !== undefined) {
			listeners.data?.(Buffer.from(JSON.stringify(body), 'utf8'));
		}
		listeners.end?.();
	});
}

// ── 1. 前缀语义的两种约定都要吃得下 ─────────────────────────
{
	const r = await request('GET', '/api/session-restore/status');
	check('带前缀的路径能进 handler', r.status === 200, String(r.status));

	// 宿主若已剥掉前缀，插件不能再剥一次——那是「看起来没加载」的经典成因
	const stripped = await request('GET', '/api/session-restore/status', undefined, { stripPrefix: true });
	check('已剥前缀时也能进 handler', stripped.status === 200, `${stripped.status} ${stripped.raw.slice(0, 80)}`);

	// 尾部斜杠不应变成未知路由
	const trailing = await request('GET', '/api/session-restore/status/');
	check('尾部斜杠不影响路由', trailing.status === 200, String(trailing.status));
}

// ── 2. /status ─────────────────────────────────────────────
{
	const r = await request('GET', '/api/session-restore/status');
	check('/status 返回 200', r.status === 200, String(r.status));
	check('/status 报告会话根目录', typeof r.json?.root === 'string' && r.json.root.includes('sessions'), String(r.json?.root));
	check('/status 报告目录是否存在', typeof r.json?.exists === 'boolean', String(r.json?.exists));
}

// ── 3. /sessions ───────────────────────────────────────────
let first = null;
{
	const r = await request('GET', '/api/session-restore/sessions');
	check('/sessions 返回 200', r.status === 200, String(r.status));
	check('/sessions 列出会话', Array.isArray(r.json?.sessions) && r.json.sessions.length > 0,
		String(r.json?.sessions?.length));
	if (Array.isArray(r.json?.sessions) && r.json.sessions.length > 0) {
		first = r.json.sessions.find((s) => s.writes > 0) ?? r.json.sessions[0];
		check('会话行有 id', typeof first.id === 'string' && first.id.length > 0);
		check('会话行有 cwd', typeof first.cwd === 'string', String(first.cwd));
		check('会话行有统计', typeof first.writes === 'number' && typeof first.edits === 'number');
	}
}

// ── 4. /preview ────────────────────────────────────────────
{
	const r = await request('POST', '/api/session-restore/preview', { id: first?.id });
	check('/preview 返回 200', r.status === 200, `${r.status} ${r.raw.slice(0, 120)}`);
	check('/preview 带文件列表', Array.isArray(r.json?.files), String(typeof r.json?.files));
	check('/preview 不回传文件内容', r.json?.files?.every((f) => f.content === undefined) === true);
	check('/preview 带统计', typeof r.json?.stats === 'object');
	check('/preview 区分「日志里没有」', Array.isArray(r.json?.editedWithoutWrite));
	check('/preview 区分「真的丢了」', Array.isArray(r.json?.lostEdits));

	// 保存一个文件路径给下一步
	if (Array.isArray(r.json?.files) && r.json.files.length > 0) {
		globalThis.__firstPath = r.json.files[0].path;
	}
}

// ── 5. 缺 id 的错误 ────────────────────────────────────────
{
	const r = await request('POST', '/api/session-restore/preview', {});
	check('缺 id 返回 400', r.status === 400, String(r.status));
	check('缺 id 的错误码可翻译', r.json?.error === 'missing-session-id', String(r.json?.error));
}

// ── 6. 不存在的会话 ────────────────────────────────────────
{
	const r = await request('POST', '/api/session-restore/preview', { id: 'definitely-not-real' });
	check('不存在的会话返回 404', r.status === 404, String(r.status));
	check('错误码是 session-not-found', r.json?.error === 'session-not-found', String(r.json?.error));
}

// ── 7. 未预览就查看文件 ────────────────────────────────────
{
	const r = await request('GET', '/api/session-restore/file?id=nope&path=a.js');
	check('未预览时 409', r.status === 409, String(r.status));
	check('错误码是 preview-required', r.json?.error === 'preview-required', String(r.json?.error));
}

// ── 8. 导出到工作区必须被拒 ────────────────────────────────
{
	const r = await request('POST', '/api/session-restore/export', {
		id: first?.id,
		target: first?.cwd,
	});
	check('导出到工作区被拒', r.status === 400, String(r.status));
	check('错误码是 target-is-workspace', r.json?.error === 'target-is-workspace', String(r.json?.error));
}

// ── 9. 未知路由 ────────────────────────────────────────────
{
	const r = await request('GET', '/api/session-restore/nonsense');
	check('未知路由 404', r.status === 404, String(r.status));
	check('未知路由的码可翻译', r.json?.error === 'not-found', String(r.json?.error));
}

console.log(`\n${passed} checks passed`);
