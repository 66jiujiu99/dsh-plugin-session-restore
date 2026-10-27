/**
 * 以 client.js 里的 ZH / EN 字典为准，重写 locale/zh.json 与 locale/en.json。
 *
 * 两个地方都要有文案是 DSH 的约定：内嵌字典给已加载的界面用，locale/*.json
 * 供宿主扫描和外部工具读取。两处不一致时，以 client.js 为准——那是界面真正
 * 渲染时用的东西。
 *
 * Run: node tools/sync-locale.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const src = await readFile(join(ROOT, 'client.js'), 'utf8');

/** 抠出某个字典字面量的键值对。 */
function dictOf(marker) {
	const start = src.indexOf(marker);
	if (start < 0) throw new Error(`找不到 ${marker}`);
	const open = src.indexOf('{', start);
	let depth = 0;
	let end = -1;
	for (let i = open; i < src.length; i += 1) {
		if (src[i] === '{') depth += 1;
		else if (src[i] === '}') {
			depth -= 1;
			if (depth === 0) { end = i; break; }
		}
	}
	if (end < 0) throw new Error(`${marker} 没有闭合`);
	const body = src.slice(open + 1, end);
	const out = {};
	// 只取单层 `key: 'value'`，值里的转义按 JS 字符串处理
	for (const m of body.matchAll(/^\s{2,}([A-Za-z_][\w]*)\s*:\s*('(?:[^'\\]|\\.)*')\s*,?\s*$/gm)) {
		const raw = m[2];
		// 用 JSON 语义解 JS 单引号字符串：先转成双引号形式
		const inner = raw.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"');
		out[m[1]] = JSON.parse(`"${inner}"`);
	}
	return out;
}

const zh = dictOf('const ZH = {');
const en = dictOf('const EN = {');

const zhKeys = Object.keys(zh);
const enKeys = Object.keys(en);
console.log(`从 client.js 抠出 ZH ${zhKeys.length} 个键，EN ${enKeys.length} 个键`);

const onlyZh = zhKeys.filter((k) => !(k in en));
const onlyEn = enKeys.filter((k) => !(k in zh));
if (onlyZh.length > 0 || onlyEn.length > 0) {
	console.error(`键不一致，拒绝写入。只在 ZH: ${onlyZh.join(',')} 只在 EN: ${onlyEn.join(',')}`);
	process.exit(1);
}

// 保持 ZH 的键顺序，两个文件一致
const orderedZh = {};
const orderedEn = {};
for (const key of zhKeys) {
	orderedZh[key] = zh[key];
	orderedEn[key] = en[key];
}

await writeFile(join(ROOT, 'locale', 'zh.json'), `${JSON.stringify(orderedZh, undefined, 2)}\n`, 'utf8');
await writeFile(join(ROOT, 'locale', 'en.json'), `${JSON.stringify(orderedEn, undefined, 2)}\n`, 'utf8');
console.log(`已写入 locale/zh.json 与 locale/en.json（各 ${zhKeys.length} 个键）`);
