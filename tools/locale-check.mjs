/**
 * 文案一致性检查。
 *
 * 中文是文案源，英文必须逐键对齐；后端发出的每个错误码都必须在
 * `CODE_KEYS` 里有翻译；字典里不能有没人引用的死键。
 *
 * 这三条都是「漏了就悄悄变丑」的那类问题：界面不会报错，只会显示一个原始
 * 机器码或者空白，而没人会注意到直到用户看到。
 *
 * Run: node tools/locale-check.mjs
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

let passed = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed += 1; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};

const ROOT = process.cwd();
const clientSrc = await readFile(join(ROOT, 'client.js'), 'utf8');
const hostSrc = await readFile(join(ROOT, 'index.js'), 'utf8');
const zhJson = JSON.parse(await readFile(join(ROOT, 'locale', 'zh.json'), 'utf8'));
const enJson = JSON.parse(await readFile(join(ROOT, 'locale', 'en.json'), 'utf8'));

/** 从源码里抠出某个字典字面量的键。 */
function dictKeys(src, marker) {
	const start = src.indexOf(marker);
	if (start < 0) return null;
	const open = src.indexOf('{', start);
	if (open < 0) return null;
	// 找到匹配的右花括号
	let depth = 0;
	let end = -1;
	for (let i = open; i < src.length; i += 1) {
		if (src[i] === '{') depth += 1;
		else if (src[i] === '}') {
			depth -= 1;
			if (depth === 0) { end = i; break; }
		}
	}
	if (end < 0) return null;
	const body = src.slice(open + 1, end);
	const keys = [];
	for (const m of body.matchAll(/^\s{2,}([A-Za-z_][\w]*)\s*:/gm)) keys.push(m[1]);
	return keys;
}

// ── 1. 两本字典键集一致 ─────────────────────────────────────
const zhKeys = dictKeys(clientSrc, 'const ZH = {');
const enKeys = dictKeys(clientSrc, 'const EN = {');
check('找到中文字典', zhKeys !== null && zhKeys.length > 20, String(zhKeys?.length));
check('找到英文字典', enKeys !== null && enKeys.length > 20, String(enKeys?.length));

if (zhKeys !== null && enKeys !== null) {
	const zhSet = new Set(zhKeys);
	const enSet = new Set(enKeys);
	const onlyZh = [...zhSet].filter((k) => !enSet.has(k));
	const onlyEn = [...enSet].filter((k) => !zhSet.has(k));
	check('中英文键数量一致', zhSet.size === enSet.size, `${zhSet.size} / ${enSet.size}`);
	check('没有只在中文里的键', onlyZh.length === 0, onlyZh.join(','));
	check('没有只在英文里的键', onlyEn.length === 0, onlyEn.join(','));

	const dupZh = zhKeys.filter((k, i) => zhKeys.indexOf(k) !== i);
	const dupEn = enKeys.filter((k, i) => enKeys.indexOf(k) !== i);
	check('中文字典无重复键', dupZh.length === 0, dupZh.join(','));
	check('英文字典无重复键', dupEn.length === 0, dupEn.join(','));
}

// ── 2. 每个错误码都有翻译 ───────────────────────────────────
// 后端 writeJson(..., { error: "xxx" }) 里的每个码都要能翻译。
const hostCodes = new Set();
for (const m of hostSrc.matchAll(/error:\s*"([a-z][a-z0-9-]+)"/g)) hostCodes.add(m[1]);
// checkTarget 返回的 reason 也是发给浏览器的码
for (const m of hostSrc.matchAll(/return\s*\{\s*ok:\s*false,\s*reason:\s*"([a-z][a-z0-9-]+)"\s*\}/g)) hostCodes.add(m[1]);

const codeKeysStart = clientSrc.indexOf('const CODE_KEYS = {');
const codeKeysEnd = clientSrc.indexOf('};', codeKeysStart);
const codeKeysBody = codeKeysStart < 0 ? '' : clientSrc.slice(codeKeysStart, codeKeysEnd);
const mappedCodes = new Set([...codeKeysBody.matchAll(/'([a-z][a-z0-9-]+)'\s*:/g)].map((m) => m[1]));

const unmapped = [...hostCodes].filter((c) => !mappedCodes.has(c));
check('后端错误码都登记了翻译', unmapped.length === 0, unmapped.join(',') || `共 ${hostCodes.size} 个码`);

// 映射表指向的键必须真实存在
const dict = new Set(zhKeys ?? []);
const dangling = [...codeKeysBody.matchAll(/:\s*'([A-Za-z_][\w]*)'/g)]
	.map((m) => m[1])
	.filter((k) => !dict.has(k));
check('映射表指向的键都存在', dangling.length === 0, [...new Set(dangling)].join(','));

// ── 3. 没有死键 ─────────────────────────────────────────────
// 排除字典定义自身，以及 CODE_KEYS 里的引用。
if (zhKeys !== null) {
	const zhStart = clientSrc.indexOf('const ZH = {');
	const zhEnd = clientSrc.indexOf('const EN = {');
	const enStart = zhEnd;
	const enEnd = clientSrc.indexOf('/** 错误码 → 文案键。 */');
	const bodyOnly =
		clientSrc.slice(0, zhStart) +
		clientSrc.slice(zhEnd, enStart) +
		clientSrc.slice(enEnd < 0 ? clientSrc.length : enEnd);
	const dead = zhKeys.filter((k) => !new RegExp(`\\bt\\(\\s*'${k}'`).test(bodyOnly) && !new RegExp(`'${k}'`).test(codeKeysBody) && !new RegExp(`\\bt\\('${k}'`).test(clientSrc));
	check('字典里没有未被引用的死键', dead.length === 0, dead.join(','));
}

// ── 4. locale/*.json 与内嵌字典同步 ─────────────────────────
// `meta` 是给 DSH 读插件元数据用的（标题、描述），不属于界面文案字典。
// 它必须存在且带 title——缺了它，插件列表里这个插件就没有名字，只显示
// package.json 的描述。这一条是补上一个真实 bug 时加的：早先的 locale 文件
// 只有扁平文案键、没有 meta，于是插件页只看得到描述、看不到名字。
{
	const META_KEYS = new Set(['meta']);
	const zhJsonKeys = Object.keys(zhJson).filter((k) => !META_KEYS.has(k));
	const missingInJson = (zhKeys ?? []).filter((k) => !zhJsonKeys.includes(k));
	check('zh.json 覆盖所有字典键', missingInJson.length === 0, missingInJson.slice(0, 10).join(','));
	const extraInJson = zhJsonKeys.filter((k) => !(zhKeys ?? []).includes(k));
	check('zh.json 没有多余的键', extraInJson.length === 0, extraInJson.slice(0, 10).join(','));

	const enJsonKeys = Object.keys(enJson).filter((k) => !META_KEYS.has(k));
	check('en.json 与 zh.json 键一致',
		enJsonKeys.length === zhJsonKeys.length && enJsonKeys.every((k) => zhJsonKeys.includes(k)),
		`${zhJsonKeys.length} / ${enJsonKeys.length}`);

	// DSH 的 readPluginMeta 从 locale JSON 的 meta.title / meta.description 读元数据。
	check('zh.json 有 meta.title（否则插件列表里没名字）',
		typeof zhJson.meta?.title === 'string' && zhJson.meta.title !== '',
		JSON.stringify(zhJson.meta?.title));
	check('en.json 有 meta.title', typeof enJson.meta?.title === 'string' && enJson.meta.title !== '',
		JSON.stringify(enJson.meta?.title));
	check('meta.title 中英文都有值', zhJson.meta?.title !== enJson.meta?.title,
		`${zhJson.meta?.title} / ${enJson.meta?.title}`);
	check('meta.description 存在',
		typeof zhJson.meta?.description === 'string' && zhJson.meta.description !== '',
		JSON.stringify(zhJson.meta?.description));
}

// ── 5. 占位符一致 ───────────────────────────────────────────
// `{n}` 写错成 `{N}` 会让界面显示原样花括号。
{
	const report = [];
	for (const key of Object.keys(zhJson)) {
		const zhVars = [...String(zhJson[key]).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
		const enVars = [...String(enJson[key] ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
		if (zhVars.join(',') !== enVars.join(',')) report.push(key);
	}
	check('中英文占位符一致', report.length === 0, report.join(','));
}

// ── 6. 英文里不能残留中文 ───────────────────────────────────
{
	const withCjk = Object.entries(enJson)
		.filter(([, v]) => /[\u4e00-\u9fff]/.test(String(v)))
		.map(([k]) => k);
	check('英文文案里没有中文', withCjk.length === 0, withCjk.join(','));
}

console.log(`\n${passed} checks passed`);
