/*---------------------------------------------------------------------------------------------
 * Copyright (c) Orbyte. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { IApplicationDescriptor, IRunConfiguration } from './applicationRuntime';
import type { IServerLaunchOptions } from './enterpriseRuntime';

interface IRunEditorState {
	readonly applications: readonly IApplicationDescriptor[];
	readonly contextual?: string;
	readonly configurations: readonly IRunConfiguration[];
	readonly selected?: string;
	readonly servers: readonly IServerLaunchOptions[];
	readonly projectServers: Readonly<Record<string, string>>;
	readonly offline: boolean;
	readonly trusted: boolean;
	readonly platform: NodeJS.Platform;
}

type EditAction = 'save' | 'run' | 'debug' | 'delete';

export function showRunConfigurationEditor(
	extensionUri: vscode.Uri,
	state: IRunEditorState,
	save: (configuration: IRunConfiguration, previousName: string | undefined, offline: boolean, action: EditAction) => Promise<readonly IRunConfiguration[]>,
): vscode.WebviewPanel {
	const media = vscode.Uri.joinPath(extensionUri, 'media');
	const panel = vscode.window.createWebviewPanel('orbyteRunConfigurations', 'Edit Run Configurations', vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
	const { webview } = panel;
	panel.iconPath = vscode.Uri.joinPath(media, 'orbyte-brand.svg');
	const nonce = randomBytes(18).toString('base64');
	const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file));
	const subscription = webview.onDidReceiveMessage(async message => {
		try {
			switch (message?.type) {
				case 'ready':
					await webview.postMessage({ type: 'state', state });
					break;
				case 'browse': {
					const application = state.applications.find(candidate => candidate.id === message.id && (candidate.enterprise || candidate.serverDeployable));
					if (!application) {
						return;
					}
					const selected = await vscode.window.showOpenDialog({
						canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
						openLabel: 'Use this directory', title: 'Select the local application server directory',
						defaultUri: typeof message.home === 'string' && message.home ? vscode.Uri.file(message.home) : undefined,
					});
					if (selected?.[0]) {
						await webview.postMessage({ type: 'serverHome', id: application.id, home: selected[0].fsPath });
					}
					break;
				}
				case 'environment': {
					const application = state.applications.find(candidate => candidate.id === message.id);
					if (application?.language === 'Java') {
						await vscode.commands.executeCommand('orbyte.java.configureJdk', vscode.Uri.file(application.root));
					}
					break;
				}
				case 'save':
				case 'run':
				case 'debug':
				case 'delete': {
					if (message.type === 'delete' && typeof message.previousName === 'string') {
						const choice = await vscode.window.showWarningMessage(`Delete run configuration “${message.previousName}”?`, { modal: true }, 'Delete');
						if (choice !== 'Delete') {
							await webview.postMessage({ type: 'cancelled' });
							return;
						}
					}
					const configurations = await save(message.configuration, message.previousName, message.offline === true, message.type);
					await webview.postMessage({ type: 'saved', configurations, name: message.type === 'delete' ? undefined : message.configuration.name.trim(), action: message.type });
					break;
				}
			}
		} catch (error) {
			await webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	});
	panel.onDidDispose(() => subscription.dispose());
	webview.html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'">
	<link rel="stylesheet" href="${uri('runConfigurationEditor.css')}">
	<title>Edit Run Configurations</title>
</head>
<body>
	<header><img src="${uri('orbyte-brand.svg')}" alt=""><h1>Edit Run Configurations</h1></header>
	<main>
		<aside aria-label="Saved configurations">
			<button id="new" type="button">＋ New configuration</button>
			<nav id="saved" aria-label="Configurations"></nav>
		</aside>
		<form id="editor">
			<div class="editor-actions">
				<button type="submit" data-action="save">Save</button>
				<button type="submit" data-action="debug">Debug</button>
				<button type="submit" data-action="run" class="primary">Run</button>
				<button id="delete" type="button" data-action="delete">Delete</button>
			</div>
			<p id="status" role="status" aria-live="polite"></p>
			<label>Configuration name <input id="name" required autocomplete="off"></label>
			<fieldset><legend>Applications</legend><div id="applications"></div></fieldset>
			<div id="details"></div>
			<label class="check"><input id="offline" type="checkbox"> Work offline in this workspace</label>
			<p class="muted">Uses installed tools and cached dependencies. The application itself may still need its services.</p>
		</form>
	</main>
	<script nonce="${nonce}" src="${uri('runConfigurationEditor.js')}"></script>
</body>
</html>`;
	return panel;
}
