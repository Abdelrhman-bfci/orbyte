/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbyte. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const LANGUAGE_SERVER_JDK_VERSION = 25;
const JDK_HOME_SETTING = 'jdkHome';
const LANGUAGE_SERVER_JDK_HOME_SETTING = 'languageServerJdkHome';

type JdkRole = 'unified' | 'languageServer' | 'project';

interface IJavaRuntimeSetting {
	readonly name: string;
	readonly path: string;
	readonly default?: boolean;
}

export interface IInstalledJdk {
	readonly version: number;
	readonly path: string;
}

let installedJdkCache: { readonly expires: number; readonly value: readonly IInstalledJdk[] } | undefined;

export function registerJdkRuntime(context: vscode.ExtensionContext): void {
	const manager = new JdkRuntimeManager();
	context.subscriptions.push(
		manager,
		vscode.commands.registerCommand('orbyte.java.configureJdk', () => vscode.commands.executeCommand('orbyte.environment.configure', 'java')),
		vscode.commands.registerCommand('orbyte.java.selectJdkInternal', (role: JdkRole, resource?: vscode.Uri) => manager.selectLocalJdk(role, resource)),
		vscode.commands.registerCommand('orbyte.java.downloadJdkInternal', (role: JdkRole, version: number, resource?: vscode.Uri) => manager.downloadJdk(role, version, resource)),
		vscode.commands.registerCommand('orbyte.java.useOrDownloadJdkInternal', (role: JdkRole, version: number, resource?: vscode.Uri) => manager.useOrDownloadJdk(role, version, resource)),
	);
	void manager.start();
}

/** The unified JDK selected for Java tooling and for compiling and running the current project. */
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

class JdkRuntimeManager implements vscode.Disposable {
	private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
	private readonly disposables: vscode.Disposable[] = [];
	private promptStarted = false;

	constructor() {
		this.statusBar.name = 'Java SDK Setup';
		this.statusBar.command = 'orbyte.java.configureJdk';
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => void this.updateStatusBar()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => void this.updateStatusBar()),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('orbyte.java')
					|| event.affectsConfiguration('java.jdt.ls.java.home')
					|| event.affectsConfiguration('spring-boot.ls.java.home')) {
					void this.updateStatusBar();
				}
			}),
		);
	}

	dispose(): void {
		this.statusBar.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	async start(): Promise<void> {
		await this.updateStatusBar();
		await this.promptWhenMissing();
	}

	private async promptWhenMissing(): Promise<void> {
		if (this.promptStarted || !vscode.workspace.isTrusted || !(vscode.workspace.workspaceFolders?.length)) {
			return;
		}
		this.promptStarted = true;
		await new Promise(resolve => setTimeout(resolve, 900));
		if (!(await hasJavaProjectContext()) || await hasManagedJdkConfiguration()) {
			return;
		}

		const action = await vscode.window.showWarningMessage(
			`Java setup is incomplete. Choose the project JDK once and Orbyte will also manage the JDK ${LANGUAGE_SERVER_JDK_VERSION}+ runtime required by its Java tooling.`,
			'Open Full Setup',
			'Not Now',
		);
		if (action === 'Open Full Setup') {
			await vscode.commands.executeCommand('orbyte.environment.configure', 'java');
		}
	}

	async configure(resource = configurationResource()): Promise<void> {
		const choice = await vscode.window.showQuickPick([
			{
				label: '$(folder-opened) Select an installed JDK',
				description: `Use one JDK ${LANGUAGE_SERVER_JDK_VERSION}+ for Orbyte tooling and this project`,
				action: 'select' as const,
			},
			{
				label: `$(cloud-download) Download Temurin JDK ${LANGUAGE_SERVER_JDK_VERSION}`,
				description: process.platform === 'win32' ? 'Install with Windows Package Manager' : 'Open Eclipse Adoptium downloads',
				action: 'download' as const,
			},
			...(vscode.extensions.getExtension('redhat.java') ? [{
				label: '$(settings-gear) Advanced Java runtime settings',
				description: 'Open the Red Hat Java runtime manager',
				action: 'manage' as const,
			}] : []),
		], {
			title: 'Java SDK Setup',
			placeHolder: 'Configure one JDK for the IDE and project',
		});

		if (choice?.action === 'select') {
			await this.selectLocalJdk('unified', resource);
		} else if (choice?.action === 'download') {
			await this.downloadJdk('unified', LANGUAGE_SERVER_JDK_VERSION, resource);
		} else if (choice?.action === 'manage') {
			await vscode.commands.executeCommand('java.runtimes.add');
		}
	}

	async selectLocalJdk(role: JdkRole, resource = configurationResource()): Promise<void> {
		const selection = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Use this JDK',
			title: role === 'unified'
				? 'Select the project JDK (Java 8 or newer)'
				: role === 'languageServer'
					? `Select JDK ${LANGUAGE_SERVER_JDK_VERSION} or newer for Java tooling`
					: 'Select the JDK for this project',
		});
		if (!selection?.[0]) {
			return;
		}
		const home = normalizeJdkHome(selection[0].fsPath);
		if (!isJdkHome(home)) {
			void vscode.window.showErrorMessage(`No complete JDK was found under ${selection[0].fsPath}. Select the JDK home directory containing bin/java and bin/javac.`);
			return;
		}
		await this.useJdk(role, home, resource);
	}

	async downloadJdk(role: JdkRole, version: number, resource = configurationResource()): Promise<void> {
		const installed = (await findInstalledJdks()).find(jdk => jdk.version === version);
		if (installed) {
			await this.useJdk(role, installed.path, resource);
			return;
		}
		if (process.platform !== 'win32') {
			await vscode.env.openExternal(vscode.Uri.parse(`https://adoptium.net/temurin/releases/?version=${version}`));
			void vscode.window.showInformationMessage('After installing the JDK, open “Orbyte: Java SDK Setup” and select its installation directory.');
			return;
		}
		if (!vscode.workspace.isTrusted) {
			void vscode.window.showWarningMessage('Trust this workspace before installing a JDK.');
			return;
		}

		try {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: `Installing Eclipse Temurin JDK ${version}`,
				cancellable: false,
			}, () => run('winget', [
				'install',
				'--id', `EclipseAdoptium.Temurin.${version}.JDK`,
				'-e',
				'--accept-package-agreements',
				'--accept-source-agreements',
			]));
			const downloaded = (await findInstalledJdks(true)).find(jdk => jdk.version === version);
			if (downloaded) {
				await this.useJdk(role, downloaded.path, resource);
				return;
			}
			const action = await vscode.window.showInformationMessage(
				`JDK ${version} was installed, but Orbyte needs a reload or manual selection to finish setup.`,
				'Reload Window',
				'Select JDK',
			);
			if (action === 'Reload Window') {
				await vscode.commands.executeCommand('workbench.action.reloadWindow');
			} else if (action === 'Select JDK') {
				await this.selectLocalJdk(role, resource);
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not install JDK ${version}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async useOrDownloadJdk(role: JdkRole, version: number, resource = configurationResource()): Promise<void> {
		const installed = (await findInstalledJdks()).find(jdk => jdk.version === version);
		if (installed) {
			await this.useJdk(role, installed.path, resource);
			return;
		}
		await this.downloadJdk(role, version, resource);
	}

	private async useJdk(role: JdkRole, home: string, resource = configurationResource()): Promise<void> {
		const version = await readJavaMajor(home);
		if (!version) {
			void vscode.window.showErrorMessage(`The selected directory does not contain a working JDK: ${home}`);
			return;
		}
		if (role === 'unified') {
			if (version < LANGUAGE_SERVER_JDK_VERSION) {
				await this.configureProjectJdk(home, version, resource, false);
				await recordPreferredJdkVersion(version, resource);
				if (await hasLanguageServerJdk()) {
					const toolingVersion = await detectedLanguageServerJdkVersion();
					void vscode.window.showInformationMessage(`Project JDK ${version} is ready. Orbyte continues using JDK ${toolingVersion} for Java tooling.`);
				} else {
					const action = await vscode.window.showWarningMessage(
						`Project JDK ${version} is configured. Orbyte also needs JDK ${LANGUAGE_SERVER_JDK_VERSION}+ to run the Java extensions.`,
						`Download JDK ${LANGUAGE_SERVER_JDK_VERSION}`,
					);
					if (action === `Download JDK ${LANGUAGE_SERVER_JDK_VERSION}`) {
						await this.downloadJdk('languageServer', LANGUAGE_SERVER_JDK_VERSION, resource);
					}
				}
				await this.updateStatusBar();
				return;
			}
			await this.configureLanguageServerJdk(home, version, false);
			await this.configureProjectJdk(home, version, resource, false);
			await recordPreferredJdkVersion(version, resource);
			const action = await vscode.window.showInformationMessage(
				`JDK ${version} is now configured for both Orbyte Java tooling and this project. Reload Orbyte to activate it everywhere.`,
				'Reload Now',
			);
			if (action === 'Reload Now') {
				await vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		} else if (role === 'languageServer') {
			if (version < LANGUAGE_SERVER_JDK_VERSION) {
				void vscode.window.showErrorMessage(`JDK ${version} cannot run the current Java extensions. Select JDK ${LANGUAGE_SERVER_JDK_VERSION} or newer. Your project may still use JDK ${version} separately.`);
				return;
			}
			await this.configureLanguageServerJdk(home, version);
		} else {
			await this.configureProjectJdk(home, version, resource);
		}
		await this.updateStatusBar();
	}

	private async configureLanguageServerJdk(home: string, version: number, notify = true): Promise<void> {
		await vscode.workspace.getConfiguration('orbyte.java').update(LANGUAGE_SERVER_JDK_HOME_SETTING, home, vscode.ConfigurationTarget.Global);
		await vscode.workspace.getConfiguration().update('java.jdt.ls.java.home', home, vscode.ConfigurationTarget.Global);
		await vscode.workspace.getConfiguration().update('spring-boot.ls.java.home', home, vscode.ConfigurationTarget.Global);
		await vscode.workspace.getConfiguration().update('rsp-ui.rsp.java.home', home, vscode.ConfigurationTarget.Global);

		if (!notify) {
			return;
		}
		const action = await vscode.window.showInformationMessage(
			`JDK ${version} is configured for Java, Spring Boot, and application-server tooling. Reload Orbyte to activate it.`,
			'Reload Now',
		);
		if (action === 'Reload Now') {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	}

	private async configureProjectJdk(home: string, version: number, resource = configurationResource(), notify = true): Promise<void> {
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

		if (!notify) {
			return;
		}
		const action = await vscode.window.showInformationMessage(`JDK ${version} is configured for this project.`, 'Restart Java');
		if (action === 'Restart Java' && vscode.extensions.getExtension('redhat.java')) {
			await vscode.commands.executeCommand('java.server.restart');
		}
	}

	private async updateStatusBar(): Promise<void> {
		if (!(await hasJavaProjectContext())) {
			this.statusBar.hide();
			return;
		}
		const toolingVersion = await detectedLanguageServerJdkVersion();
		const projectHome = configuredJdkEnvironment(configurationResource())?.JAVA_HOME;
		const projectVersion = projectHome ? await readJavaMajor(projectHome) : undefined;
		const ready = await hasManagedJdkConfiguration();
		if (!toolingVersion || toolingVersion < LANGUAGE_SERVER_JDK_VERSION || !ready) {
			this.statusBar.text = '$(warning) Java SDK Setup';
			this.statusBar.tooltip = `Select one JDK ${LANGUAGE_SERVER_JDK_VERSION} or newer for both Orbyte Java tooling and this project.`;
			this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else {
			this.statusBar.text = `$(coffee) Java ${projectVersion}${projectVersion !== toolingVersion ? ` · IDE ${toolingVersion}` : ''}`;
			this.statusBar.tooltip = 'Java is ready. One setup manages the project JDK and Orbyte tooling runtime.';
			this.statusBar.backgroundColor = undefined;
		}
		this.statusBar.show();
	}
}

function configuredLanguageServerJdkHome(): string | undefined {
	const candidates = [
		vscode.workspace.getConfiguration('orbyte.java').get<string>(LANGUAGE_SERVER_JDK_HOME_SETTING),
		vscode.workspace.getConfiguration().get<string>('java.jdt.ls.java.home'),
		vscode.workspace.getConfiguration().get<string>('spring-boot.ls.java.home'),
	];
	return candidates.map(candidate => candidate?.trim()).find((candidate): candidate is string => Boolean(candidate && isJdkHome(candidate)));
}

async function detectedLanguageServerJdkVersion(): Promise<number | undefined> {
	const configured = configuredLanguageServerJdkHome();
	if (configured) {
		return readJavaMajor(configured);
	}
	if (process.env.JAVA_HOME && isJdkHome(process.env.JAVA_HOME)) {
		const version = await readJavaMajor(process.env.JAVA_HOME);
		if (version) {
			return version;
		}
	}
	try {
		const output = await run(process.platform === 'win32' ? 'java.exe' : 'java', ['-version']);
		return parseJavaMajor(output);
	} catch {
		return undefined;
	}
}

async function hasLanguageServerJdk(): Promise<boolean> {
	const version = await detectedLanguageServerJdkVersion();
	return Boolean(version && version >= LANGUAGE_SERVER_JDK_VERSION);
}

async function hasManagedJdkConfiguration(resource = configurationResource()): Promise<boolean> {
	const projectHome = configuredJdkEnvironment(resource)?.JAVA_HOME;
	if (!projectHome) {
		return false;
	}
	return hasLanguageServerJdk();
}

async function recordPreferredJdkVersion(version: number, resource = configurationResource()): Promise<void> {
	const configuration = vscode.workspace.getConfiguration('orbyte.environment', resource);
	const versions = configuration.get<Record<string, string>>('preferredVersions', {});
	const target = vscode.workspace.workspaceFolders?.length
		? vscode.ConfigurationTarget.Workspace
		: vscode.ConfigurationTarget.Global;
	await configuration.update('preferredVersions', { ...versions, java: String(version) }, target);
}

async function hasJavaProjectContext(): Promise<boolean> {
	if (['java', 'kotlin', 'groovy'].includes(vscode.window.activeTextEditor?.document.languageId ?? '')) {
		return true;
	}
	if (!vscode.workspace.workspaceFolders?.length) {
		return false;
	}
	const matches = await vscode.workspace.findFiles('**/{pom.xml,build.gradle,build.gradle.kts,build.xml,*.java,*.kt,*.groovy}', '**/{node_modules,target,build,out}/**', 1);
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
		return parseJavaMajor(output);
	} catch {
		return undefined;
	}
}

function parseJavaMajor(output: string): number | undefined {
	const value = /version\s+"(?:(1)\.)?(\d+)/.exec(output);
	return value ? Number(value[2]) : undefined;
}

export async function findInstalledJdks(force = false): Promise<readonly IInstalledJdk[]> {
	if (!force && installedJdkCache && installedJdkCache.expires > Date.now()) {
		return installedJdkCache.value;
	}
	const candidates = new Set<string>();
	for (const candidate of [
		configuredLanguageServerJdkHome(),
		configuredJdkEnvironment(configurationResource())?.JAVA_HOME,
		process.env.JAVA_HOME,
	]) {
		if (candidate) {
			candidates.add(candidate);
		}
	}

	if (process.platform === 'darwin') {
		try {
			const output = await run('/usr/libexec/java_home', ['-V']);
			for (const line of output.split(/\r?\n/)) {
				const match = /(\/.*\/Contents\/Home)\s*$/.exec(line);
				if (match) {
					candidates.add(match[1]);
				}
			}
		} catch {
			// Standard installation directories are scanned below.
		}
	}

	const roots = process.platform === 'win32'
		? [
			process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Eclipse Adoptium'),
			process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Java'),
			process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft'),
			process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Amazon Corretto'),
			process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Zulu'),
			process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Azul Systems'),
			process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium'),
			process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Java'),
		]
		: process.platform === 'darwin'
			? [
				'/Library/Java/JavaVirtualMachines',
				path.join(os.homedir(), 'Library', 'Java', 'JavaVirtualMachines'),
				path.join(os.homedir(), '.sdkman', 'candidates', 'java'),
				path.join(os.homedir(), '.asdf', 'installs', 'java'),
				path.join(os.homedir(), '.jabba', 'jdk'),
				path.join(os.homedir(), '.local', 'share', 'mise', 'installs', 'java'),
				...['openjdk', 'openjdk@8', 'openjdk@11', 'openjdk@17', 'openjdk@21', 'openjdk@25', 'openjdk@26', 'openjdk@27']
					.flatMap(name => [path.join('/opt/homebrew/opt', name), path.join('/usr/local/opt', name)]),
			]
			: [
				'/usr/lib/jvm',
				'/usr/java',
				'/opt/java',
				path.join(os.homedir(), '.sdkman', 'candidates', 'java'),
				path.join(os.homedir(), '.asdf', 'installs', 'java'),
				path.join(os.homedir(), '.jabba', 'jdk'),
				path.join(os.homedir(), '.local', 'share', 'mise', 'installs', 'java'),
			];
	for (const root of roots.filter((value): value is string => Boolean(value))) {
		await collectJdkCandidates(root, candidates, 2);
	}

	try {
		const output = await run(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'java.exe' : 'java']);
		for (const executable of output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
			candidates.add(path.dirname(path.dirname(executable)));
		}
	} catch {
		// PATH does not expose Java; standard locations may still contain installations.
	}

	const result: IInstalledJdk[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const home = normalizeJdkHome(candidate);
		const key = process.platform === 'win32' ? path.resolve(home).toLowerCase() : path.resolve(home);
		if (seen.has(key) || !isJdkHome(home)) {
			continue;
		}
		seen.add(key);
		const version = await readJavaMajor(home);
		if (version) {
			result.push({ version, path: home });
		}
	}
	result.sort((left, right) => right.version - left.version || left.path.localeCompare(right.path));
	installedJdkCache = { expires: Date.now() + 5000, value: result };
	return result;
}

async function collectJdkCandidates(root: string, candidates: Set<string>, depth: number): Promise<void> {
	const home = normalizeJdkHome(root);
	if (isJdkHome(home)) {
		candidates.add(home);
		return;
	}
	if (depth <= 0) {
		return;
	}
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				await collectJdkCandidates(path.join(root, entry.name), candidates, depth - 1);
			}
		}
	} catch {
		// Ignore missing or protected installation directories.
	}
}

function run(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error((stderr || stdout || error.message).trim()));
				return;
			}
			resolve(`${stdout}\n${stderr}`);
		});
	});
}
