/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbyte. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const DOWNLOAD_JDK_VERSION = 21;
const JDK_HOME_SETTING = 'jdkHome';

interface IJavaRuntimeSetting {
	readonly name: string;
	readonly path: string;
	readonly default?: boolean;
}

export function registerJdkRuntime(context: vscode.ExtensionContext): void {
	const manager = new JdkRuntimeManager();
	context.subscriptions.push(
		vscode.commands.registerCommand('orbyte.java.configureJdk', (resource?: vscode.Uri) => manager.configure(resource)),
	);
	void manager.promptWhenMissing();
}

export function configuredJdkEnvironment(resource?: vscode.Uri): Record<string, string> | undefined {
	const home = vscode.workspace.getConfiguration('orbyte.java', resource).get<string>(JDK_HOME_SETTING)?.trim();
	if (!home || !isJdkHome(home)) {
		return undefined;
	}
	return {
		JAVA_HOME: home,
		PATH: `${path.join(home, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
	};
}

class JdkRuntimeManager {
	private promptStarted = false;

	async promptWhenMissing(): Promise<void> {
		if (this.promptStarted || !vscode.workspace.isTrusted || !(vscode.workspace.workspaceFolders?.length)) {
			return;
		}
		this.promptStarted = true;
		await new Promise(resolve => setTimeout(resolve, 1200));
		if (!(await hasJavaProjectContext()) || await hasUsableJdk()) {
			return;
		}
		const action = await vscode.window.showWarningMessage(
			'Orbyte detected a Java project, but no JDK is configured. Choose an installed JDK or download one to enable code intelligence, build, run, and debug.',
			'Select Local JDK',
			`Download JDK ${DOWNLOAD_JDK_VERSION}`,
			'Not Now',
		);
		if (action === 'Select Local JDK') {
			await this.selectLocalJdk();
		} else if (action === `Download JDK ${DOWNLOAD_JDK_VERSION}`) {
			await this.downloadJdk();
		}
	}

	async configure(resource = configurationResource()): Promise<void> {
		const configured = configuredJdkEnvironment(resource)?.JAVA_HOME;
		const choice = await vscode.window.showQuickPick([
			{
				label: '$(folder-opened) Select JDK from this computer',
				description: configured ? `Current: ${configured}` : 'Choose a JDK installation directory',
				action: 'select' as const,
			},
			{
				label: `$(cloud-download) Download Temurin JDK ${DOWNLOAD_JDK_VERSION}`,
				description: process.platform === 'win32' ? 'Install automatically with Windows Package Manager' : 'Open the Eclipse Adoptium download',
				action: 'download' as const,
			},
			...(vscode.extensions.getExtension('redhat.java') ? [{
				label: '$(settings-gear) Manage all Java runtimes',
				description: 'Open the Java runtime manager',
				action: 'manage' as const,
			}] : []),
		], {
			title: 'Configure Project JDK',
			placeHolder: 'Select how Orbyte should configure Java',
		});
		if (choice?.action === 'select') {
			await this.selectLocalJdk(resource);
		} else if (choice?.action === 'download') {
			await this.downloadJdk(resource);
		} else if (choice?.action === 'manage') {
			await vscode.commands.executeCommand('java.runtimes.add');
		}
	}

	private async selectLocalJdk(resource = configurationResource()): Promise<void> {
		const selection = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Use this JDK',
			title: 'Select a JDK installation directory',
		});
		if (!selection?.[0]) {
			return;
		}
		const home = normalizeJdkHome(selection[0].fsPath);
		if (!isJdkHome(home)) {
			void vscode.window.showErrorMessage(`No complete JDK was found under ${selection[0].fsPath}. Select the JDK home directory that contains bin/java and bin/javac.`);
			return;
		}
		await this.useJdk(home, resource);
	}

	private async downloadJdk(resource = configurationResource()): Promise<void> {
		if (process.platform !== 'win32') {
			await vscode.env.openExternal(vscode.Uri.parse(`https://adoptium.net/temurin/releases/?version=${DOWNLOAD_JDK_VERSION}`));
			void vscode.window.showInformationMessage('After installing the JDK, run “Orbyte: Configure Project JDK” and select its installation directory.');
			return;
		}
		if (!vscode.workspace.isTrusted) {
			void vscode.window.showWarningMessage('Trust this workspace before installing a JDK.');
			return;
		}
		try {
			const installed = await findInstalledWindowsJdk(DOWNLOAD_JDK_VERSION);
			if (installed) {
				await this.useJdk(installed, resource);
				return;
			}
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: `Installing Eclipse Temurin JDK ${DOWNLOAD_JDK_VERSION}`,
				cancellable: false,
			}, () => run('winget', [
				'install',
				'--id', `EclipseAdoptium.Temurin.${DOWNLOAD_JDK_VERSION}.JDK`,
				'-e',
				'--accept-package-agreements',
				'--accept-source-agreements',
			]));
			const home = await findInstalledWindowsJdk(DOWNLOAD_JDK_VERSION);
			if (!home) {
				const action = await vscode.window.showInformationMessage(
					`JDK ${DOWNLOAD_JDK_VERSION} was installed. Reload Orbyte so Java can detect it.`,
					'Reload Window',
					'Select JDK',
				);
				if (action === 'Reload Window') {
					await vscode.commands.executeCommand('workbench.action.reloadWindow');
				} else if (action === 'Select JDK') {
					await this.selectLocalJdk(resource);
				}
				return;
			}
			await this.useJdk(home, resource);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not install JDK ${DOWNLOAD_JDK_VERSION}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async useJdk(home: string, resource = configurationResource()): Promise<void> {
		const version = await readJavaMajor(home);
		if (!version) {
			void vscode.window.showErrorMessage(`The selected directory does not contain a working JDK: ${home}`);
			return;
		}
		const target = vscode.workspace.workspaceFolders?.length && resource
			? vscode.ConfigurationTarget.WorkspaceFolder
			: vscode.workspace.workspaceFolders?.length
				? vscode.ConfigurationTarget.Workspace
				: vscode.ConfigurationTarget.Global;
		await vscode.workspace.getConfiguration('orbyte.java', resource).update(JDK_HOME_SETTING, home, target);

		const javaConfiguration = vscode.workspace.getConfiguration('java.configuration', resource);
		const runtimes = javaConfiguration.get<IJavaRuntimeSetting[]>('runtimes', []);
		const runtimeName = version === 8 ? 'JavaSE-1.8' : `JavaSE-${version}`;
		const next = runtimes
			.filter(runtime => runtime.path !== home && runtime.name !== runtimeName)
			.map(runtime => ({ ...runtime, default: false }));
		next.push({ name: runtimeName, path: home, default: true });
		await javaConfiguration.update('runtimes', next, target);

		const action = await vscode.window.showInformationMessage(
			`JDK ${version} is configured for this workspace.`,
			'Restart Java',
		);
		if (action === 'Restart Java' && vscode.extensions.getExtension('redhat.java')) {
			await vscode.commands.executeCommand('java.server.restart');
		}
	}
}

async function hasUsableJdk(): Promise<boolean> {
	const resource = configurationResource();
	if (configuredJdkEnvironment(resource)) {
		return true;
	}
	const runtimes = vscode.workspace.getConfiguration('java.configuration', resource).get<IJavaRuntimeSetting[]>('runtimes', []);
	if (runtimes.some(runtime => isJdkHome(runtime.path))) {
		return true;
	}
	if (process.env.JAVA_HOME && isJdkHome(process.env.JAVA_HOME)) {
		return true;
	}
	try {
		await run(process.platform === 'win32' ? 'javac.exe' : 'javac', ['-version']);
		return true;
	} catch {
		return false;
	}
}

async function hasJavaProjectContext(): Promise<boolean> {
	if (vscode.window.activeTextEditor?.document.languageId === 'java') {
		return true;
	}
	const matches = await vscode.workspace.findFiles('**/{pom.xml,build.gradle,build.gradle.kts,build.xml,*.java}', '**/{node_modules,target,build,out}/**', 1);
	return matches.length > 0;
}

function configurationResource(): vscode.Uri | undefined {
	const active = vscode.window.activeTextEditor?.document.uri;
	return active && vscode.workspace.getWorkspaceFolder(active) ? active : vscode.workspace.workspaceFolders?.[0]?.uri;
}

function normalizeJdkHome(home: string): string {
	const macHome = path.join(home, 'Contents', 'Home');
	return isJdkHome(macHome) ? macHome : home;
}

function isJdkHome(home: string): boolean {
	const suffix = process.platform === 'win32' ? '.exe' : '';
	return existsSync(path.join(home, 'bin', `java${suffix}`))
		&& existsSync(path.join(home, 'bin', `javac${suffix}`));
}

async function readJavaMajor(home: string): Promise<number | undefined> {
	try {
		const output = await run(path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), ['-version']);
		const value = /version\s+"(?:(1)\.)?(\d+)/.exec(output);
		return value ? Number(value[2]) : undefined;
	} catch {
		return undefined;
	}
}

async function findInstalledWindowsJdk(version: number): Promise<string | undefined> {
	const roots = [
		process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Eclipse Adoptium'),
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium'),
		process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Java'),
	].filter((value): value is string => Boolean(value));
	for (const root of roots) {
		try {
			const entries = await fs.readdir(root, { withFileTypes: true });
			for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
				const candidate = path.join(root, entry.name);
				if (entry.isDirectory() && entry.name.toLowerCase().includes(`jdk-${version}`) && isJdkHome(candidate)) {
					return candidate;
				}
			}
		} catch {
			// Try the next standard JDK installation root.
		}
	}
	return undefined;
}

function run(command: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, [...args], { windowsHide: true, timeout: 15 * 60 * 1000 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error((stderr || stdout || error.message).trim()));
				return;
			}
			resolve(`${stdout}\n${stderr}`.trim());
		});
	});
}
