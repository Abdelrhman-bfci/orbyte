/*---------------------------------------------------------------------------------------------
 * Copyright (c) Orbyte. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();
const get = id => document.getElementById(id);
const editor = get('editor');
const optionsByApp = new Map();
let state;
let previousName;
let busy = false;

function element(tag, text, className) {
	const node = document.createElement(tag);
	node.textContent = text;
	if (className) {
		node.className = className;
	}
	return node;
}

function field(container, label, value, onInput, type = 'text') {
	const input = element('input', '');
	input.type = type;
	input.value = value ?? '';
	input.addEventListener('input', () => onInput(input.value));
	const wrapper = element('label', label);
	wrapper.append(input);
	container.append(wrapper);
	return input;
}

function renderConfiguration(configuration) {
	previousName = configuration?.name;
	optionsByApp.clear();
	get('name').value = configuration?.name ?? '';
	const selected = new Set(configuration?.applications ?? [state.contextual]);
	const applications = get('applications');
	applications.replaceChildren();
	for (const app of state.applications) {
		const input = element('input', '');
		input.type = 'checkbox';
		input.checked = selected.has(app.id);
		const controls = {
			selected: input.checked,
			args: configuration?.programArgs?.[app.id] ?? '',
			command: configuration?.commandOverrides?.[app.id] ?? '',
			server: configuration?.servers?.[app.id],
			deploy: app.enterprise || Boolean(configuration?.servers?.[app.id]),
		};
		optionsByApp.set(app.id, controls);
		input.addEventListener('change', () => {
			controls.selected = input.checked;
			renderDetails();
		});
		const label = element('label', '', 'check');
		label.append(input, element('span', app.name), element('small', app.framework, 'muted'));
		applications.append(label);
	}
	renderDetails();
	renderActions();
}

function renderActions() {
	const saved = get('saved');
	saved.replaceChildren();
	for (const configuration of state.configurations) {
		const button = element('button', configuration.name);
		button.type = 'button';
		button.setAttribute('aria-pressed', String(configuration.name === previousName));
		button.disabled = busy;
		button.addEventListener('click', () => renderConfiguration(configuration));
		saved.append(button);
	}
	get('new').disabled = busy;
	for (const button of editor.querySelectorAll('.editor-actions button')) {
		button.disabled = busy || !state.trusted || (button.id === 'delete' && !previousName);
	}
}

function defaultServer(kind) {
	return { ...state.servers.find(server => server.kind === kind) };
}

function renderDetails() {
	const details = get('details');
	details.replaceChildren();
	for (const app of state.applications) {
		const controls = optionsByApp.get(app.id);
		if (!controls.selected) {
			continue;
		}
		const card = element('fieldset', '');
		card.append(element('legend', app.name), element('p', app.root, 'muted'));
		field(card, 'Program arguments', controls.args, value => { controls.args = value; });
		const command = field(card, app.language === 'Custom' ? 'Local launch command' : 'Custom launch command (optional)', controls.command, value => { controls.command = value; });
		command.placeholder = app.command ? [app.command.executable, ...app.command.args].join(' ') : 'Use the project’s detected launch command';
		if (app.language === 'Java') {
			const setup = element('button', 'Project JDK…', 'secondary');
			setup.type = 'button';
			setup.addEventListener('click', () => vscode.postMessage({ type: 'environment', id: app.id }));
			card.append(setup);
		}
		if (!app.enterprise && app.serverDeployable) {
			const deploy = element('input', '');
			deploy.type = 'checkbox';
			deploy.checked = controls.deploy;
			deploy.addEventListener('change', () => {
				controls.deploy = deploy.checked;
				renderDetails();
			});
			const label = element('label', '', 'check');
			label.append(deploy, element('span', 'Deploy to an application server'));
			card.append(label);
		}
		if (controls.deploy) {
			const key = state.platform === 'win32' ? app.root.toLowerCase() : app.root;
			controls.server ??= defaultServer(state.projectServers[key] ?? state.servers.find(server => server.home)?.kind ?? 'wildfly');
			renderServer(card, app, controls);
		}
		details.append(card);
	}
}

function renderServer(card, app, controls) {
	const server = controls.server;
	const group = element('fieldset', '', 'server');
	group.append(element('legend', 'Application server'));
	const select = element('select', '');
	for (const [kind, label] of [['wildfly', 'JBoss EAP / WildFly'], ['websphere', 'IBM WebSphere']]) {
		const option = element('option', label);
		option.value = kind;
		select.append(option);
	}
	select.value = server.kind;
	select.addEventListener('change', () => {
		controls.server = { ...defaultServer(select.value), artifact: server.artifact };
		renderDetails();
	});
	const serverType = element('label', 'Server type');
	serverType.append(select);
	group.append(serverType);
	const browseRow = element('div', '', 'browse');
	const home = field(browseRow, server.kind === 'websphere' ? 'Local profile directory' : 'Local server directory', server.home, value => { server.home = value; });
	const browse = element('button', 'Browse…');
	browse.type = 'button';
	browse.addEventListener('click', () => vscode.postMessage({ type: 'browse', id: app.id, home: home.value }));
	browseRow.append(browse);
	group.append(browseRow);
	if (server.kind === 'websphere') {
		field(group, 'Server name', server.serverName, value => { server.serverName = value; });
	}
	const port = field(group, 'Debug port', server.debugPort, value => { server.debugPort = Number(value); }, 'number');
	port.min = '1';
	port.max = '65535';
	if (server.kind === 'wildfly') {
		const managementPort = field(group, 'Management port', server.managementPort ?? 9990, value => { server.managementPort = Number(value); }, 'number');
		managementPort.min = '1';
		managementPort.max = '65535';
	}
	const artifact = field(group, 'Deployment artifact (optional)', server.artifact, value => { server.artifact = value.trim(); });
	artifact.placeholder = 'Auto-detect after build, or enter target/my-app.ear';
	card.append(group);
}

function send(action) {
	if (!state || busy) {
		return;
	}
	const selected = [...optionsByApp].filter(([, options]) => options.selected);
	const configuration = {
		name: get('name').value,
		applications: selected.map(([id]) => id),
		programArgs: Object.fromEntries(selected.map(([id, options]) => [id, options.args])),
		commandOverrides: Object.fromEntries(selected.map(([id, options]) => [id, options.command])),
		servers: Object.fromEntries(selected.filter(([, options]) => options.deploy && options.server).map(([id, options]) => [id, options.server])),
	};
	busy = true;
	get('status').textContent = '';
	renderActions();
	vscode.postMessage({ type: action, configuration, previousName, offline: get('offline').checked });
}

editor.addEventListener('submit', event => {
	event.preventDefault();
	send(event.submitter?.dataset.action ?? 'save');
});
get('delete').addEventListener('click', () => send('delete'));
get('new').addEventListener('click', () => {
	renderConfiguration();
	get('name').focus();
});
window.addEventListener('message', ({ data }) => {
	if (data.type === 'state') {
		state = data.state;
		get('offline').checked = state.offline;
		renderConfiguration(state.configurations.find(config => config.name === state.selected));
		if (!state.trusted) {
			get('status').textContent = 'Trust this workspace to save or run a configuration.';
		}
	} else if (data.type === 'serverHome') {
		const controls = optionsByApp.get(data.id);
		if (controls?.server) {
			controls.server.home = data.home;
			renderDetails();
		}
	} else if (data.type === 'saved') {
		state.configurations = data.configurations;
		busy = false;
		renderConfiguration(state.configurations.find(config => config.name === data.name));
		get('status').textContent = data.action === 'delete' ? 'Configuration deleted.' : 'Configuration saved.';
	} else if (data.type === 'error' || data.type === 'cancelled') {
		busy = false;
		get('status').textContent = data.message ?? '';
		renderActions();
	}
});
vscode.postMessage({ type: 'ready' });
