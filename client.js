window.__ModuleLoader__.load({
	id: 'dsh-plugin-session-restore',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useState, useEffect, useCallback, useMemo, useRef } = React;

		const NS = 'session-restore';

		/**
		 * Resolve API paths against the page's real base URL.
		 *
		 * The Desktop shell serves the UI from `dsh-app://app/`, and the phone-sync
		 * plugin reverse-proxies the same UI under `/m/`. A leading `"/api/…"`
		 * leaves whichever mount served the page, so the Host answers 404.
		 */
		function api(path) {
			try { return new URL(`./api/session-restore${path}`, document.baseURI).href; }
			catch { return `/api/session-restore${path}`; }
		}

		// ───────────────────────────── 文案 ─────────────────────────────
		/** 简体中文字典：本插件的文案源。 */
		const ZH = {
			tab: '会话恢复',
			title: '会话恢复',
			subtitle: '会话日志里有你写过的每一个文件',
			sectionFiles: '文件',
			colTime: '时间',
			colWorkspace: '工作区',
			colEvents: '事件',
			colFiles: '文件数',
			colPath: '路径',
			colLines: '行数',
			colSize: '大小',
			refresh: '刷新',
			preview: '预览',
			export: '导出',
			view: '查看',
			back: '返回',
			scanning: '正在扫描会话…',
			noSessions: '没有找到会话记录',
			noFiles: '这条会话没有可恢复的文件',
			targetDir: '导出目录',
			targetPlaceholder: '例如 D:/recovered（须已存在）',
			overwrite: '覆盖已存在的文件',
			exported: '已导出 {n} 个文件',
			skippedN: '{n} 个已存在，已跳过',
			refusedN: '{n} 个路径被拒绝',
			resyncedTag: '已校正',
			shellTouchedTag: 'bash 改过',
			notInLogN: '{n} 个文件在本条会话开始前就存在，日志里没有它们的全文',
			lostEditsN: '{n} 处编辑没能重放',
			statsLine: '{writes} 次写入 · {edits} 次编辑 · 重建 {files} 个文件',
			statsResync: '{n} 次靠 read 结果校正',
			statsApplied: '有基线的编辑应用率 {pct}%',
			errMissingId: '没有指定会话',
			errSessionNotFound: '找不到这条会话',
			errPreviewRequired: '请先预览这条会话',
			errTargetMissing: '导出目录不存在，请先创建',
			errTargetNotDir: '目标不是目录',
			errTargetIsWorkspace: '不能导出到会话自己的工作区',
			errTargetIsRoot: '不能导出到磁盘根目录',
			errEmptyTarget: '请填写导出目录',
			errBodyTooLarge: '请求内容过大',
			errFileNotInPreview: '这个文件不在当前预览里，请重新预览',
			errNotFound: '接口不存在',
		};

		/** English dictionary. */
		const EN = {
			tab: 'Session Restore',
			title: 'Session Restore',
			subtitle: 'Every file you wrote is in the session log',
			sectionFiles: 'Files',
			colTime: 'Time',
			colWorkspace: 'Workspace',
			colEvents: 'Events',
			colFiles: 'Files',
			colPath: 'Path',
			colLines: 'Lines',
			colSize: 'Size',
			refresh: 'Refresh',
			preview: 'Preview',
			export: 'Export',
			view: 'View',
			back: 'Back',
			scanning: 'Scanning sessions…',
			noSessions: 'No session logs found',
			noFiles: 'This session has no recoverable files',
			targetDir: 'Export directory',
			targetPlaceholder: 'e.g. D:/recovered (must exist)',
			overwrite: 'Overwrite existing files',
			exported: 'Exported {n} files',
			skippedN: '{n} already existed, skipped',
			refusedN: '{n} paths were refused',
			resyncedTag: 'resynced',
			shellTouchedTag: 'bash-touched',
			notInLogN: '{n} files predate this session; the log never held their text',
			lostEditsN: '{n} edits could not be replayed',
			statsLine: '{writes} writes · {edits} edits · {files} files rebuilt',
			statsResync: '{n} resynced from read results',
			statsApplied: '{pct}% of edits with a baseline applied',
			errMissingId: 'No session was named',
			errSessionNotFound: 'That session was not found',
			errPreviewRequired: 'Preview the session first',
			errTargetMissing: 'The export directory does not exist; create it first',
			errTargetNotDir: 'The target is not a directory',
			errTargetIsWorkspace: 'Refusing to export into the session\u2019s own workspace',
			errTargetIsRoot: 'Refusing to export to a filesystem root',
			errEmptyTarget: 'Enter an export directory',
			errBodyTooLarge: 'The request body was too large',
			errFileNotInPreview: 'That file is not in the current preview; preview again',
			errNotFound: 'No such endpoint',
		};

		/** 错误码 → 文案键。 */
		const CODE_KEYS = {
			'missing-session-id': 'errMissingId',
			'session-not-found': 'errSessionNotFound',
			'preview-required': 'errPreviewRequired',
			'file-not-in-preview': 'errFileNotInPreview',
			'target-missing': 'errTargetMissing',
			'target-not-a-directory': 'errTargetNotDir',
			'target-is-workspace': 'errTargetIsWorkspace',
			'target-is-root': 'errTargetIsRoot',
			'empty-target': 'errEmptyTarget',
			'body-too-large': 'errBodyTooLarge',
			'not-found': 'errNotFound',
		};

		/**
		 * Which language is active.
		 *
		 * @param {object} locale - the locale service.
		 * @returns {string} `zh` or `en`.
		 */
		function activeLocaleId(locale) {
			try {
				const id = locale?.get?.() ?? locale?.current?.() ?? locale?.id ?? 'zh';
				return String(id).toLowerCase().startsWith('en') ? 'en' : 'zh';
			} catch { return 'zh'; }
		}

		/**
		 * Build a translator bound to the locale service, with a local fallback.
		 *
		 * @param {Function|undefined} bound - `locale.bind(NS)` if available.
		 * @param {() => string} active - active language getter.
		 * @returns {(key:string, vars?:object)=>string}
		 */
		function makeT(bound, active) {
			return (key, vars) => {
				let text = null;
				if (typeof bound === 'function') {
					try { text = bound(key); } catch { text = null; }
				}
				if (typeof text !== 'string' || text === '' || text === key) {
					const dict = active() === 'en' ? EN : ZH;
					text = dict[key] ?? ZH[key] ?? key;
				}
				if (vars && typeof text === 'string') {
					for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
				}
				return text;
			};
		}

		/**
		 * Turn a server error code into readable text; unknown codes pass through.
		 *
		 * @param {(key:string, vars?:object)=>string} t - translator.
		 * @param {string} code - machine code from the Host.
		 * @returns {string} human text.
		 */
		function errorText(t, code) {
			const key = CODE_KEYS[code];
			return key === undefined ? String(code) : t(key);
		}

		/** Compact byte formatting. */
		function humanBytes(n) {
			if (!Number.isFinite(n)) return '—';
			if (n < 1024) return `${n} B`;
			if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
			return `${(n / 1024 / 1024).toFixed(1)} MB`;
		}

		/** Local time or a dash. */
		function formatTime(ms) {
			if (!Number.isFinite(ms)) return '—';
			try {
				return new Date(ms).toLocaleString();
			} catch { return '—'; }
		}

		// ───────────────────────────── 样式 ─────────────────────────────
		function ensureStyles() {
			if (document.getElementById('sr-styles') !== null) return;
			const style = document.createElement('style');
			style.id = 'sr-styles';
			style.textContent = `
.sr-root { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 24px; }
.sr-hero { display: flex; flex-direction: column; gap: 6px; }
.sr-title { font-size: 17px; font-weight: 600; }
.sr-sub { font-size: 12.5px; opacity: .68; }
.sr-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sr-btn { border: 1px solid rgba(128,128,128,.32); background: transparent; color: inherit;
  border-radius: 7px; padding: 5px 11px; font-size: 12.5px; cursor: pointer; }
.sr-btn:hover:not(:disabled) { background: rgba(128,128,128,.13); }
.sr-btn:disabled { opacity: .45; cursor: default; }
.sr-btn.primary { border-color: rgba(64,132,255,.6); background: rgba(64,132,255,.14); }
.sr-btn.small { padding: 3px 8px; font-size: 11.5px; }
.sr-note { font-size: 12px; opacity: .72; }
.sr-warn { font-size: 12px; color: #d08700; }
.sr-err { font-size: 12.5px; color: #e05555; }
.sr-ok { font-size: 12.5px; color: #2f9e44; }
.sr-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.sr-table th, .sr-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid rgba(128,128,128,.16); }
.sr-table th { font-weight: 600; opacity: .7; font-size: 11.5px; text-transform: none; }
.sr-table tr.on td { background: rgba(64,132,255,.10); }
.sr-table td.num, .sr-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
.sr-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
.sr-tag { display: inline-block; border-radius: 5px; padding: 1px 5px; font-size: 10.5px;
  background: rgba(128,128,128,.18); margin-left: 5px; }
.sr-tag.resync { background: rgba(47,158,68,.20); }
.sr-tag.shell { background: rgba(208,135,0,.20); }
.sr-input { border: 1px solid rgba(128,128,128,.32); background: transparent; color: inherit;
  border-radius: 7px; padding: 5px 9px; font-size: 12.5px; min-width: 260px; }
.sr-scroll { max-height: 340px; overflow: auto; border: 1px solid rgba(128,128,128,.16); border-radius: 8px; }
.sr-pre { margin: 0; padding: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 420px; overflow: auto; }
.sr-empty { padding: 18px; text-align: center; font-size: 12.5px; opacity: .6; }
.sr-chk { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; opacity: .85; }
`;
			document.head.appendChild(style);
		}

		// ───────────────────────────── 组件 ─────────────────────────────
		/**
		 * Session list.
		 *
		 * @param {object} props
		 */
		function SessionList({ t, rows, loading, selected, onPick, onRefresh }) {
			return h('div', { className: 'sr-root' },
				h('div', { className: 'sr-bar' },
					h('button', { className: 'sr-btn', onClick: onRefresh, disabled: loading }, t('refresh')),
					loading ? h('span', { className: 'sr-note' }, t('scanning')) : null),
				rows.length === 0
					? h('div', { className: 'sr-empty' }, loading ? t('scanning') : t('noSessions'))
					: h('div', { className: 'sr-scroll' },
						h('table', { className: 'sr-table' },
							h('thead', null, h('tr', null,
								h('th', null, t('colTime')),
								h('th', null, t('colWorkspace')),
								h('th', { className: 'num' }, t('colEvents')),
								h('th', { className: 'num' }, t('colFiles')),
								h('th', null, ''))),
							h('tbody', null, rows.map((row) => h('tr', {
								key: row.id,
								className: selected !== null && row.id === selected ? 'on' : '',
							},
								h('td', { className: 'sr-mono' }, formatTime(row.createdAt ?? row.mtime)),
								h('td', { className: 'sr-mono' }, row.cwd ?? row.project),
								h('td', { className: 'num' }, String(row.events)),
								h('td', { className: 'num' }, String(row.files)),
								h('td', null, h('button', {
									className: 'sr-btn small primary',
									onClick: () => onPick(row),
								}, t('preview')))))))));
		}

		/**
		 * Rebuilt file list for one session, plus export controls.
		 *
		 * @param {object} props
		 */
		function FileList({ t, preview, onBack, onExport, onView, exporting, exportMsg, err }) {
			const stats = preview.stats ?? {};
			const applicable = (stats.editsApplied ?? 0) + (stats.lostEdits ?? 0);
			const pct = applicable === 0 ? 0 : Math.round(((stats.editsApplied ?? 0) / applicable) * 100);
			return h('div', { className: 'sr-root' },
				h('div', { className: 'sr-bar' },
					h('button', { className: 'sr-btn', onClick: onBack }, t('back')),
					h('span', { className: 'sr-note' }, t('statsLine', {
						writes: stats.writes ?? 0,
						edits: stats.edits ?? 0,
						files: (preview.files ?? []).length,
					})),
					(stats.resyncs ?? 0) > 0
						? h('span', { className: 'sr-note' }, t('statsResync', { n: stats.resyncs }))
						: null,
					applicable > 0 ? h('span', { className: 'sr-note' }, t('statsApplied', { pct })) : null),

				// 两个不同的坏消息，分开说清楚。
				(preview.editedWithoutWrite ?? []).length > 0
					? h('div', { className: 'sr-warn' }, t('notInLogN', { n: preview.editedWithoutWrite.length }))
					: null,
				(preview.lostEdits ?? []).length > 0
					? h('div', { className: 'sr-warn' }, t('lostEditsN', { n: preview.lostEdits.length }))
					: null,
				(preview.shellTouched ?? []).length > 0
					? h('div', { className: 'sr-warn' }, `${t('shellTouchedTag')}: ${preview.shellTouched.length}`)
					: null,

				h('div', { className: 'sr-bar' },
					h('span', { className: 'sr-note' }, t('targetDir')),
					h('input', {
						className: 'sr-input',
						id: 'sr-target',
						placeholder: t('targetPlaceholder'),
					}),
					h('label', { className: 'sr-chk' },
						h('input', { type: 'checkbox', id: 'sr-overwrite' }),
						t('overwrite')),
					h('button', {
						className: 'sr-btn primary',
						disabled: exporting,
						onClick: () => {
							const target = document.getElementById('sr-target')?.value ?? '';
							const overwrite = document.getElementById('sr-overwrite')?.checked === true;
							onExport(target, overwrite);
						},
					}, t('export'))),

				err !== null ? h('div', { className: 'sr-err' }, err) : null,
				exportMsg !== null ? h('div', { className: 'sr-ok' }, exportMsg) : null,

				(preview.files ?? []).length === 0
					? h('div', { className: 'sr-empty' }, t('noFiles'))
					: h('div', { className: 'sr-scroll' },
						h('table', { className: 'sr-table' },
							h('thead', null, h('tr', null,
								h('th', null, t('colPath')),
								h('th', { className: 'num' }, t('colLines')),
								h('th', { className: 'num' }, t('colSize')),
								h('th', null, ''))),
							h('tbody', null, preview.files.map((f) => h('tr', { key: f.path },
								h('td', { className: 'sr-mono' },
									f.path,
									f.resynced ? h('span', { className: 'sr-tag resync' }, t('resyncedTag')) : null,
									f.shellTouched ? h('span', { className: 'sr-tag shell' }, t('shellTouchedTag')) : null),
								h('td', { className: 'num' }, String(f.lines)),
								h('td', { className: 'num' }, humanBytes(f.bytes)),
								h('td', null, h('button', {
									className: 'sr-btn small',
									onClick: () => onView(f.path),
								}, t('view')))))))));
		}

		/**
		 * One file's rebuilt text.
		 *
		 * @param {object} props
		 */
		function FileView({ t, file, onBack }) {
			return h('div', { className: 'sr-root' },
				h('div', { className: 'sr-bar' },
					h('button', { className: 'sr-btn', onClick: onBack }, t('back')),
					h('span', { className: 'sr-mono' }, file.path),
					h('span', { className: 'sr-note' }, humanBytes(file.bytes)),
					file.truncated ? h('span', { className: 'sr-warn' }, '…') : null),
				h('pre', { className: 'sr-pre' }, file.text));
		}

		/**
		 * The panel root: sessions → files → one file.
		 *
		 * @param {object} props
		 */
		function Restore({ t, locale }) {
			const [rows, setRows] = useState([]);
			const [loading, setLoading] = useState(false);
			const [selected, setSelected] = useState(null);
			const [preview, setPreview] = useState(null);
			const [file, setFile] = useState(null);
			const [err, setErr] = useState(null);
			const [exporting, setExporting] = useState(false);
			const [exportMsg, setExportMsg] = useState(null);
			const mounted = useRef(true);

			useEffect(() => () => { mounted.current = false; }, []);

			const loadSessions = useCallback(async () => {
				setLoading(true);
				setErr(null);
				try {
					const res = await fetch(api('/sessions'), { credentials: 'same-origin' });
					const body = await res.json();
					if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
					if (mounted.current) setRows(Array.isArray(body.sessions) ? body.sessions : []);
				} catch (e) {
					if (mounted.current) setErr(errorText(t, e?.message ?? e));
				} finally {
					if (mounted.current) setLoading(false);
				}
			}, [t]);

			useEffect(() => { loadSessions(); }, [loadSessions]);

			const openPreview = useCallback(async (row) => {
				setSelected(row.id);
				setErr(null);
				setExportMsg(null);
				setFile(null);
				try {
					const res = await fetch(api('/preview'), {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						credentials: 'same-origin',
						body: JSON.stringify({ id: row.id }),
					});
					const body = await res.json();
					if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
					if (mounted.current) setPreview(body);
				} catch (e) {
					if (mounted.current) setErr(errorText(t, e?.message ?? e));
				}
			}, [t]);

			const viewFile = useCallback(async (path) => {
				setErr(null);
				try {
					const res = await fetch(
						api(`/file?id=${encodeURIComponent(selected)}&path=${encodeURIComponent(path)}`),
						{ credentials: 'same-origin' },
					);
					const body = await res.json();
					if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
					if (mounted.current) setFile(body);
				} catch (e) {
					if (mounted.current) setErr(errorText(t, e?.message ?? e));
				}
			}, [t, selected]);

			const doExport = useCallback(async (target, overwrite) => {
				setExporting(true);
				setErr(null);
				setExportMsg(null);
				try {
					const res = await fetch(api('/export'), {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						credentials: 'same-origin',
						body: JSON.stringify({ id: selected, target, overwrite }),
					});
					const body = await res.json();
					if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
					const parts = [t('exported', { n: body.written ?? 0 })];
					if ((body.skipped ?? []).length > 0) parts.push(t('skippedN', { n: body.skipped.length }));
					if ((body.refused ?? []).length > 0) parts.push(t('refusedN', { n: body.refused.length }));
					if (mounted.current) setExportMsg(parts.join(' · '));
				} catch (e) {
					if (mounted.current) setErr(errorText(t, e?.message ?? e));
				} finally {
					if (mounted.current) setExporting(false);
				}
			}, [t, selected]);

			if (file !== null) {
				return h('div', { className: 'sr-root' },
					h('div', { className: 'sr-hero' },
						h('div', { className: 'sr-title' }, t('title')),
						h('div', { className: 'sr-sub' }, t('sectionFiles'))),
					err !== null ? h('div', { className: 'sr-err' }, err) : null,
					h(FileView, { t, file, onBack: () => { setFile(null); setErr(null); } }));
			}

			if (preview !== null) {
				return h('div', { className: 'sr-root' },
					h('div', { className: 'sr-hero' },
						h('div', { className: 'sr-title' }, t('title')),
						h('div', { className: 'sr-sub' }, preview.session?.cwd ?? '')),
					h(FileList, {
						t,
						preview,
						onBack: () => { setPreview(null); setSelected(null); setErr(null); setExportMsg(null); },
						onExport: doExport,
						onView: viewFile,
						exporting,
						exportMsg,
						err,
					}));
			}

			return h('div', { className: 'sr-root' },
				h('div', { className: 'sr-hero' },
					h('div', { className: 'sr-title' }, t('title')),
					h('div', { className: 'sr-sub' }, t('subtitle'))),
				err !== null ? h('div', { className: 'sr-err' }, err) : null,
				h(SessionList, {
					t,
					rows,
					loading,
					selected,
					onPick: openPreview,
					onRefresh: loadSessions,
				}));
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				ctx.effect(() => ensureStyles(), 'session-restore: styles');
				const locale = ctx.get('locale', false);
				const active = () => activeLocaleId(locale);
				let bound;
				if (locale !== undefined && locale !== null) {
					try {
						ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'session-restore: locale');
						if (typeof locale.bind === 'function') bound = locale.bind(NS);
					} catch (error) {
						console.warn('[session-restore] locale 服务不可用，回落到本地字典', error);
					}
				}
				const t = makeT(bound, active);

				ctx.slots.inject('plugins.tab', () => ctx.slots.register({
					name: 'plugins.tab',
					id: 'session-restore',
					order: 5,
					label: () => t('tab'),
				}, (props) => h(Restore, { ...props, t, locale })));
			},
		};
	},
});
