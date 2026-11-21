/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbyte. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';

const SUPPORTED_EXTENSIONS = new Set([
	'.java', '.kt', '.kts', '.groovy', '.xml', '.properties', '.yml', '.yaml',
	'.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.go', '.rs', '.php', '.rb',
	'.cs', '.fs', '.cpp', '.cc', '.c', '.h', '.hpp', '.html', '.css', '.scss', '.vue', '.svelte',
	'.jsp', '.jspx', '.xhtml', '.ftl', '.mustache',
]);

export function registerHotReload(context: vscode.ExtensionContext): void {
	context.subscriptions.push(new HotReloadController());
}

class HotReloadController implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pendingResource: vscode.Uri | undefined;
	private running = false;

	constructor() {
		this.statusBar.name = 'Orbyte Hot Reload';
		this.disposables.push(
			this.statusBar,
			vscode.commands.registerCommand('orbyte.hotReload.toggle', () => this.setEnabled(!this.enabled)),
			vscode.commands.registerCommand('orbyte.hotReload.enable', () => this.setEnabled(true)),
			vscode.commands.registerCommand('orbyte.hotReload.disable', () => this.setEnabled(false)),
			vscode.commands.registerCommand('orbyte.hotReload.now', (resource?: vscode.Uri) => this.reload(resource ?? vscode.window.activeTextEditor?.document.uri)),
			vscode.workspace.onDidSaveTextDocument(document => this.schedule(document.uri)),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('orbyte.hotReload')) {
					this.updateUi();
				}
			}),
		);
		this.updateUi();
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private get enabled(): boolean {
		return vscode.workspace.getConfiguration('orbyte.hotReload').get('enabled', true);
	}

	private async setEnabled(enabled: boolean): Promise<void> {
		await vscode.workspace.getConfiguration('orbyte.hotReload').update('enabled', enabled, vscode.ConfigurationTarget.Global);
		this.updateUi();
		void vscode.window.setStatusBarMessage(enabled ? '$(flame) Hot Reload enabled' : '$(circle-slash) Hot Reload paused', 2500);
	}

	private updateUi(): void {
		const enabled = this.enabled;
		this.statusBar.text = enabled ? '$(flame) Hot Reload: On' : '$(circle-slash) Hot Reload: Off';
		this.statusBar.tooltip = enabled
			? 'Hot Reload on save is enabled. Spring DevTools compiles changed classes; enterprise archives are rebuilt and redeployed; framework watchers, configured reload commands, and active debug sessions are supported.'
			: 'Hot Reload on save is paused. Click to enable it.';
		this.statusBar.command = 'orbyte.hotReload.toggle';
		this.statusBar.show();
		void vscode.commands.executeCommand('setContext', 'orbyte.hotReload.enabled', enabled);
	}

	private schedule(resource: vscode.Uri): void {
		if (!this.enabled || resource.scheme !== 'file' || !SUPPORTED_EXTENSIONS.has(path.extname(resource.fsPath).toLowerCase()) || /[/\\](?:target|build|out|dist|node_modules)[/\\]/.test(resource.fsPath)) {
			return;
		}
		this.pendingResource = resource;
		if (this.timer) {
			clearTimeout(this.timer);
		}
		const delay = vscode.workspace.getConfiguration('orbyte.hotReload').get('delay', 900);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.reload(this.pendingResource);
		}, delay);
	}

	private async reload(resource: vscode.Uri | undefined): Promise<void> {
		if (!resource || this.running) {
			return;
		}
		this.pendingResource = undefined;
		this.running = true;
		this.statusBar.text = '$(sync~spin) Hot Reloading…';
		try {
			const enterpriseHandled = await vscode.commands.executeCommand<boolean>('orbyte.enterprise.hotReload', resource);
			if (enterpriseHandled) {
				return;
			}
			const javaHandled = await vscode.commands.executeCommand<boolean>('orbyte.spring.hotReload', resource);
			if (javaHandled) {
				return;
			}
			const folder = vscode.workspace.getWorkspaceFolder(resource);
			const command = vscode.workspace.getConfiguration('orbyte.hotReload', resource).get<string>('command', '').trim();
			if (command) {
				const task = new vscode.Task(
					{ type: 'orbyte-hot-reload', command },
					folder ?? vscode.TaskScope.Workspace,
					`Hot Reload ${folder?.name ?? 'Workspace'}`,
					'Orbyte Hot Reload',
					new vscode.ShellExecution(command, { cwd: folder?.uri.fsPath }),
					[],
				);
				task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Dedicated, clear: false };
				await vscode.tasks.executeTask(task);
				return;
			}
			if (vscode.debug.activeDebugSession) {
				await vscode.commands.executeCommand('workbench.action.debug.restart');
			}
		} catch (error) {
			void vscode.window.showWarningMessage(`Hot reload failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.running = false;
			this.updateUi();
			if (this.pendingResource) {
				this.schedule(this.pendingResource);
			}
		}
	}
}
