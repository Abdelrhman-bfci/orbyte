(function () {
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('app');
	const icon = root.dataset.icon;
	let state;
	let selectedId;

	const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
	const glyph = id => ({ java: 'J', node: 'JS', python: 'Py', cpp: 'C++', dotnet: '.N', go: 'Go', rust: 'Rs', php: 'PHP', ruby: 'Rb' })[id] || '&lt;/&gt;';
	const selectedEnvironment = () => state.environments.find(environment => environment.id === selectedId) || state.environments[0];

	function render() {
		if (!state) { return; }
		const environment = selectedEnvironment();
		const configuredPath = state.runtimePaths[environment.id] || '';
		const detectedPath = state.detectedPaths[environment.id] || '';
		const effectivePath = configuredPath || detectedPath;
		const detectedVersion = state.detectedVersions[environment.id] || '';
		const preferredVersion = state.preferredVersions[environment.id] || environment.recommendedVersion;
		const heap = state.heapMb[environment.id];
		const heapAuto = !heap;
		const isJava = environment.id === 'java';
		const ready = isJava ? state.javaJdkReady : Boolean(effectivePath);

		root.innerHTML = `
		<div class="shell">
			<header class="topbar">
				<div class="brand"><img src="${icon}" alt="Orbyte"><div><h1>Environment Setup</h1><p>One place for SDKs, runtimes, compilers, paths, and memory.</p></div></div>
				<div class="machine"><span class="chip">${escapeHtml(state.platform)} · ${escapeHtml(state.architecture)}</span><span class="chip">${escapeHtml(state.totalMemoryGb)} GB RAM</span><span class="chip">Heap recommendation ${escapeHtml(state.recommendedHeapMb)} MB</span></div>
			</header>
			<div class="workspace">
				<aside class="languages"><h2>Languages</h2><div class="language-list">${state.environments.map(item => `
					<button class="language ${item.id === environment.id ? 'active' : ''}" data-language="${item.id}">
						<span class="glyph">${glyph(item.id)}</span><span class="copy"><strong>${escapeHtml(item.label)}</strong><small>${item.id === state.detectedId ? 'Detected project' : 'Environment'}</small></span>${item.id === state.detectedId ? '<span class="detected-dot"></span>' : ''}
					</button>`).join('')}</div></aside>
				<main class="content">
					<div class="content-header"><div><h2>${escapeHtml(environment.label)}</h2><p>Configure everything required by this language without leaving this window.</p></div><span class="status ${ready ? 'ready' : 'missing'}">${ready ? '● Runtime detected' : '○ Setup required'}</span></div>
					<div class="grid">
						${isJava ? javaCards(environment, preferredVersion, detectedPath) : runtimeCard(environment, preferredVersion, effectivePath, detectedVersion)}
						${memoryCard(environment, heapAuto, heap)}
						${behaviorCard(environment)}
					</div>
				</main>
			</div>
			<footer class="footer"><div class="footer-inner"><span class="footer-note">Settings are stored locally. Project scope keeps configuration with this workspace.</span><div class="footer-actions"><button class="button ghost" id="reload">Reload IDE</button><button class="button" id="apply">Apply configuration</button></div></div></footer>
		</div>`;
		wireEvents(environment);
	}

	function versionOptions(environment, selected, versions = environment.versions) {
		return versions.map(version => `<option value="${escapeHtml(version)}" ${String(version) === String(selected) ? 'selected' : ''}>${escapeHtml(version)}${version === environment.recommendedVersion ? ' — Recommended' : ''}</option>`).join('');
	}

	function pathBox(value, emptyLabel) {
		return `<div class="path ${value ? '' : 'empty'}" title="${escapeHtml(value)}">${escapeHtml(value || emptyLabel)}</div>`;
	}

	function javaCards(environment, preferredVersion, detectedPath) {
		const jdkPath = state.javaJdkPath || detectedPath;
		const detectedSelection = String(state.javaJdkMajor || '');
		const jdkVersion = environment.versions.includes(String(preferredVersion))
			? String(preferredVersion)
			: environment.versions.includes(detectedSelection) ? detectedSelection : environment.recommendedVersion;
		const jdkHint = state.javaJdkReady
			? state.javaJdkMajor < 25
				? `Project JDK ${escapeHtml(state.javaJdkMajor)} is ready. Orbyte automatically keeps JDK ${escapeHtml(state.javaIdeJdkMajor)} for compatible IDE tooling.`
				: `JDK ${escapeHtml(state.javaJdkMajor)} is configured for both Orbyte tooling and this project.`
			: state.javaJdkMajor
				? `Project JDK ${escapeHtml(state.javaJdkMajor)} was detected. Finish setup so Orbyte can provide JDK 25+ for the Java extensions.`
				: 'Choose Java 8 or newer for the project. Orbyte automatically keeps JDK 25+ for its Java extensions.';
		return `
		<section class="card full"><div class="card-head"><h3>Java Development Kit</h3><p>One setup controls the project JDK and keeps Orbyte's Java tooling on a compatible JDK automatically.</p></div><div class="card-body">
			<div class="field"><label>JDK version</label><div class="row"><select id="version">${versionOptions(environment, jdkVersion)}</select><button class="button secondary" data-download data-role="unified">Download selected</button></div></div>
			<div class="field"><label>Project JDK home</label><div class="row">${pathBox(jdkPath, 'No project JDK selected')}<button class="button ghost" data-local data-role="unified">Select local…</button></div></div>
			<div class="hint ${state.javaJdkReady ? '' : 'warning'}">${jdkHint}</div>
		</div></section>`;
	}

	function runtimeCard(environment, preferredVersion, effectivePath, detectedVersion) {
		return `<section class="card full"><div class="card-head"><h3>${escapeHtml(environment.shortLabel)} SDK / runtime</h3><p>Select a version, use an installed SDK path, or open the official installer.</p></div><div class="card-body">
			<div class="field"><label>Preferred version</label><div class="row"><select id="version">${versionOptions(environment, preferredVersion)}</select><button class="button secondary" data-download>Download selected</button></div></div>
			<div class="field"><label>Local SDK, runtime, interpreter, or compiler</label><div class="row">${pathBox(effectivePath, 'Not configured or detected on PATH')}<button class="button ghost" data-local>Select local…</button></div></div>
			${detectedVersion ? `<div class="hint">Detected: ${escapeHtml(detectedVersion)}</div>` : '<div class="hint warning">No compatible executable was detected. Select its local path or download it.</div>'}
			${environment.hasSelector ? '<div><button class="button ghost" id="selector">Open language-specific selector</button></div>' : ''}
		</div></section>`;
	}

	function memoryCard(environment, heapAuto, heap) {
		return `<section class="card"><div class="card-head"><h3>Memory & heap</h3><p>${environment.memorySupported ? 'Tune the language server for large projects, or let Orbyte use automatic sizing.' : 'This language server manages memory automatically.'}</p></div><div class="card-body">
			<div class="toggle-line"><div class="toggle-copy"><strong>Automatic memory</strong><span>Recommended for most machines and projects</span></div><label class="switch"><input id="heapAuto" type="checkbox" ${heapAuto ? 'checked' : ''} ${environment.memorySupported ? '' : 'disabled'}><span class="slider"></span></label></div>
			<div class="field memory-input ${heapAuto || !environment.memorySupported ? 'disabled' : ''}"><label>Maximum heap (MB)</label><input id="heapMb" type="number" min="512" max="131072" step="256" value="${escapeHtml(heap || state.recommendedHeapMb)}"></div>
			<div class="hint">Machine recommendation: ${escapeHtml(state.recommendedHeapMb)} MB from ${escapeHtml(state.totalMemoryGb)} GB system RAM.</div>
		</div></section>`;
	}

	function behaviorCard(environment) {
		return `<section class="card"><div class="card-head"><h3>Project behavior</h3><p>Control how Orbyte detects and stores environment settings.</p></div><div class="card-body">
			<div class="toggle-line"><div class="toggle-copy"><strong>Auto-detect requirements</strong><span>Prompt when a required tool is missing</span></div><label class="switch"><input id="autoDetect" type="checkbox" ${state.autoDetect ? 'checked' : ''}><span class="slider"></span></label></div>
			<div class="field"><label>Configuration scope</label><select id="scope"><option value="workspace">This project / workspace</option><option value="global">All projects on this machine</option></select></div>
			<div><button class="button ghost" id="settings">Open advanced ${escapeHtml(environment.shortLabel)} settings</button></div>
		</div></section>`;
	}

	function wireEvents(environment) {
		document.querySelectorAll('[data-language]').forEach(button => button.addEventListener('click', () => { selectedId = button.dataset.language; render(); }));
		document.querySelectorAll('[data-local]').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'selectLocal', languageId: environment.id, role: button.dataset.role, scope: document.getElementById('scope').value })));
		document.querySelectorAll('[data-download]').forEach(button => button.addEventListener('click', () => {
			const field = document.getElementById('version');
			vscode.postMessage({ type: 'download', languageId: environment.id, role: button.dataset.role, version: field.value });
		}));
		const heapAuto = document.getElementById('heapAuto');
		if (heapAuto) { heapAuto.addEventListener('change', () => document.querySelector('.memory-input').classList.toggle('disabled', heapAuto.checked)); }
		document.getElementById('selector')?.addEventListener('click', () => vscode.postMessage({ type: 'openSelector', languageId: environment.id }));
		document.getElementById('settings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings', languageId: environment.id }));
		document.getElementById('reload').addEventListener('click', () => vscode.postMessage({ type: 'reload', languageId: environment.id }));
		document.getElementById('apply').addEventListener('click', () => {
			const version = document.getElementById('version')?.value || environment.recommendedVersion;
			vscode.postMessage({ type: 'apply', languageId: environment.id, version, heapAuto: document.getElementById('heapAuto')?.checked !== false, heapMb: document.getElementById('heapMb')?.value, autoDetect: document.getElementById('autoDetect').checked, scope: document.getElementById('scope').value });
		});
	}

	window.addEventListener('message', event => {
		if (event.data?.type !== 'state') { return; }
		state = event.data.state;
		selectedId = state.selectedId;
		render();
	});
	vscode.postMessage({ type: 'ready' });
}());
