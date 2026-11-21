/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbyte. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { existsSync, statSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findInstalledJdks } from './jdkRuntime';

type MemoryMode = 'java' | 'node' | 'none';
type ConfigurationScope = 'workspace' | 'global';

interface ILanguageEnvironment {
	readonly id: string;
	readonly label: string;
	readonly shortLabel: string;
	readonly languageIds: readonly string[];
	readonly executables: readonly string[];
	readonly versions: readonly string[];
	readonly recommendedVersion: string;
	readonly selectorCommand?: string;
	readonly downloadUrl: string;
	readonly memory: MemoryMode;
}

interface IEnvironmentViewState {
	readonly selectedId: string;
	readonly detectedId?: string;
	readonly platform: string;
	readonly architecture: string;
	readonly totalMemoryGb: number;
	readonly recommendedHeapMb: number;
	readonly autoDetect: boolean;
	readonly preferredVersions: Readonly<Record<string, string>>;
	readonly heapMb: Readonly<Record<string, number>>;
	readonly runtimePaths: Readonly<Record<string, string>>;
	readonly detectedPaths: Readonly<Record<string, string>>;
	readonly detectedVersions: Readonly<Record<string, string>>;
	readonly javaJdkPath: string;
	readonly javaJdkMajor?: number;
	readonly javaJdkReady: boolean;
	readonly javaInstalledJdks: readonly { readonly version: number; readonly path: string }[];
	readonly environments: readonly {
		readonly id: string;
		readonly label: string;
		readonly shortLabel: string;
		readonly versions: readonly string[];
		readonly recommendedVersion: string;
		readonly memorySupported: boolean;
		readonly hasSelector: boolean;
	}[];
}

const environments: readonly ILanguageEnvironment[] = [
	{ id: 'java', label: 'Java / JVM', shortLabel: 'Java', languageIds: ['java', 'kotlin', 'groovy'], executables: ['java'], versions: ['27', '26', '25', '21', '17', '11', '8'], recommendedVersion: '21', downloadUrl: 'https://adoptium.net/temurin/releases/', memory: 'java' },
	{ id: 'node', label: 'JavaScript / TypeScript', shortLabel: 'Node.js', languageIds: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'], executables: ['node'], versions: ['24', '22', '20'], recommendedVersion: '24', downloadUrl: 'https://nodejs.org/en/download', memory: 'node' },
	{ id: 'python', label: 'Python', shortLabel: 'Python', languageIds: ['python'], executables: ['python3', 'python'], versions: ['3.14', '3.13', '3.12', '3.11', '3.10'], recommendedVersion: '3.13', selectorCommand: 'python.setInterpreter', downloadUrl: 'https://www.python.org/downloads/', memory: 'none' },
	{ id: 'cpp', label: 'C / C++', shortLabel: 'C/C++', languageIds: ['c', 'cpp', 'cuda-cpp'], executables: ['clang', 'gcc', 'cl'], versions: ['Clang', 'GCC', 'MSVC'], recommendedVersion: 'Clang', selectorCommand: 'C_Cpp.SelectIntelliSenseConfiguration', downloadUrl: 'https://code.visualstudio.com/docs/cpp/config-mingw', memory: 'none' },
	{ id: 'dotnet', label: '.NET / C#', shortLabel: '.NET', languageIds: ['csharp', 'fsharp', 'vb'], executables: ['dotnet'], versions: ['10', '9', '8'], recommendedVersion: '10', downloadUrl: 'https://dotnet.microsoft.com/download', memory: 'none' },
	{ id: 'go', label: 'Go', shortLabel: 'Go', languageIds: ['go'], executables: ['go'], versions: ['1.25', '1.24', '1.23'], recommendedVersion: '1.25', selectorCommand: 'go.locate.tools', downloadUrl: 'https://go.dev/dl/', memory: 'none' },
	{ id: 'rust', label: 'Rust', shortLabel: 'Rust', languageIds: ['rust'], executables: ['rustc', 'cargo'], versions: ['stable', 'beta', 'nightly'], recommendedVersion: 'stable', downloadUrl: 'https://rustup.rs/', memory: 'none' },
	{ id: 'php', label: 'PHP', shortLabel: 'PHP', languageIds: ['php'], executables: ['php'], versions: ['8.5', '8.4', '8.3', '8.2'], recommendedVersion: '8.4', downloadUrl: 'https://www.php.net/downloads', memory: 'none' },
	{ id: 'ruby', label: 'Ruby', shortLabel: 'Ruby', languageIds: ['ruby'], executables: ['ruby'], versions: ['3.4', '3.3', '3.2'], recommendedVersion: '3.4', downloadUrl: 'https://www.ruby-lang.org/en/downloads/', memory: 'none' },
];

export function registerEnvironmentSetup(context: vscode.ExtensionContext): void {
	const manager = new EnvironmentSetupManager(context);
	context.subscriptions.push(
		manager,
		vscode.commands.registerCommand('orbyte.environment.configure', (languageId?: string) => manager.configure(languageId)),
	);
	void manager.start();
}

class EnvironmentSetupManager implements vscode.Disposable {
	private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
	private readonly disposables: vscode.Disposable[] = [];
	private readonly prompted = new Set<string>();
	private panel: vscode.WebviewPanel | undefined;
	private updateTimer: NodeJS.Timeout | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.statusBar.name = 'Language Environment Setup';
		this.statusBar.command = 'orbyte.environment.configure';
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => this.scheduleUpdate()),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('orbyte.environment') || event.affectsConfiguration('orbyte.java')) {
					this.scheduleUpdate();
					void this.refreshPanel();
				}
			}),
		);
	}

	dispose(): void {
		if (this.updateTimer) {
			clearTimeout(this.updateTimer);
		}
		this.panel?.dispose();
		this.statusBar.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	async start(): Promise<void> {
		await this.update();
	}

	async configure(requestedLanguageId?: string): Promise<void> {
		const detected = await detectEnvironment();
		const requested = environmentByIdOrLanguage(requestedLanguageId);
		const selected = requested ?? detected ?? environments[0];
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);
			await this.refreshPanel(selected.id);
			return;
		}

		this.panel = vscode.window.createWebviewPanel(
			'orbyteEnvironmentSetup',
			'Orbyte Environment Setup',
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
			},
		);
		this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'orbyte-brand.svg');
		this.panel.webview.html = this.webviewHtml(this.panel.webview);
		this.panel.onDidDispose(() => this.panel = undefined, undefined, this.disposables);
		this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message), undefined, this.disposables);
		await this.refreshPanel(selected.id);
	}

	private async handleMessage(message: unknown): Promise<void> {
		if (!message || typeof message !== 'object') {
			return;
		}
		const payload = message as Record<string, unknown>;
		const languageId = typeof payload.languageId === 'string' ? payload.languageId : undefined;
		const environment = environmentByIdOrLanguage(languageId);
		if (payload.type === 'ready') {
			await this.refreshPanel(languageId);
			return;
		}
		if (!environment) {
			return;
		}
		try {
			if (payload.type === 'selectLocal') {
				if (environment.id === 'java') {
					await vscode.commands.executeCommand('orbyte.java.selectJdkInternal', 'unified');
				} else {
					await this.selectRuntime(environment, payload.scope === 'workspace' ? 'workspace' : 'global');
				}
			} else if (payload.type === 'download') {
				const version = typeof payload.version === 'string' ? payload.version : environment.recommendedVersion;
				if (environment.id === 'java') {
					await vscode.commands.executeCommand('orbyte.java.downloadJdkInternal', 'unified', Number(version));
				} else {
					await vscode.env.openExternal(vscode.Uri.parse(downloadUrl(environment, version)));
				}
			} else if (payload.type === 'useJdkVersion' && environment.id === 'java') {
				const version = typeof payload.version === 'string' ? Number(payload.version) : Number.NaN;
				if (!Number.isFinite(version)) {
					throw new Error('Select a valid JDK version.');
				}
				await vscode.commands.executeCommand('orbyte.java.useOrDownloadJdkInternal', 'unified', version);
			} else if (payload.type === 'apply') {
				await this.applyForm(environment, payload);
			} else if (payload.type === 'openSelector' && environment.selectorCommand) {
				await vscode.commands.executeCommand(environment.selectorCommand);
			} else if (payload.type === 'openSettings') {
				await vscode.commands.executeCommand('workbench.action.openSettings', environment.label);
			} else if (payload.type === 'reload') {
				await vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not update ${environment.label}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			await this.refreshPanel(environment.id);
			await this.update();
		}
	}

	private async applyForm(environment: ILanguageEnvironment, payload: Record<string, unknown>): Promise<void> {
		const configuration = vscode.workspace.getConfiguration('orbyte.environment');
		const target = payload.scope === 'workspace' && vscode.workspace.workspaceFolders?.length
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
		const versions = configuration.get<Record<string, string>>('preferredVersions', {});
		const version = typeof payload.version === 'string' ? payload.version : environment.recommendedVersion;
		await configuration.update('preferredVersions', { ...versions, [environment.id]: version }, target);
		if (typeof payload.autoDetect === 'boolean') {
			await configuration.update('autoDetect', payload.autoDetect, vscode.ConfigurationTarget.Global);
		}
		if (environment.memory !== 'none') {
			const automatic = payload.heapAuto !== false;
			const heapMb = automatic ? 0 : Number(payload.heapMb);
			if (!automatic && (!Number.isFinite(heapMb) || heapMb < 512 || heapMb > 131072)) {
				throw new Error('Heap memory must be between 512 MB and 131072 MB.');
			}
			await applyMemory(environment, heapMb, target);
		}
		void vscode.window.showInformationMessage(`${environment.label} environment settings were saved.`);
	}

	private async selectRuntime(environment: ILanguageEnvironment, scope: ConfigurationScope): Promise<void> {
		const selection = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: `Use for ${environment.label}`,
			title: `Select the ${environment.label} SDK, runtime, compiler, or executable`,
		});
		if (!selection?.[0]) {
			return;
		}
		const executable = resolveExecutable(environment, selection[0].fsPath);
		if (!executable) {
			void vscode.window.showErrorMessage(`No ${environment.shortLabel} executable was found under ${selection[0].fsPath}. Select the SDK home, runtime folder, or executable file.`);
			return;
		}
		const target = scope === 'workspace' && vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
		const configuration = vscode.workspace.getConfiguration('orbyte.environment');
		const current = configuration.get<Record<string, string>>('runtimePaths', {});
		await configuration.update('runtimePaths', { ...current, [environment.id]: executable }, target);
		try {
			await applyLanguageRuntimeSetting(environment, executable, target);
		} catch (error) {
			void vscode.window.showWarningMessage(`The path was saved, but the language extension setting could not be updated: ${error instanceof Error ? error.message : String(error)}`);
		}
		await addExecutableToTerminalPath(executable, target);
		void vscode.window.showInformationMessage(`${environment.label} now uses ${executable}. New terminals will include it on PATH.`);
	}

	private scheduleUpdate(): void {
		if (this.updateTimer) {
			clearTimeout(this.updateTimer);
		}
		this.updateTimer = setTimeout(() => void this.update(), 500);
	}

	private async update(): Promise<void> {
		const environment = await detectEnvironment();
		if (!environment || environment.id === 'java') {
			this.statusBar.hide();
			return;
		}
		const executable = await configuredOrDetectedRuntime(environment);
		this.statusBar.text = executable ? `$(tools) ${environment.shortLabel}` : `$(warning) Set up ${environment.shortLabel}`;
		this.statusBar.tooltip = executable
			? `${environment.label} runtime detected at ${executable}. Click to open the full environment dialog.`
			: `${environment.label} runtime was not detected. Click to select a local path or download it.`;
		this.statusBar.backgroundColor = executable ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
		this.statusBar.show();

		const autoDetect = vscode.workspace.getConfiguration('orbyte.environment').get<boolean>('autoDetect', true);
		if (autoDetect && !executable && vscode.workspace.isTrusted && !this.prompted.has(environment.id)) {
			this.prompted.add(environment.id);
			const action = await vscode.window.showWarningMessage(
				`${environment.label} was detected, but its required SDK, runtime, or compiler is not available.`,
				'Open Full Setup',
				'Not Now',
			);
			if (action === 'Open Full Setup') {
				await this.configure(environment.id);
			}
		}
	}

	private async refreshPanel(selectedId?: string): Promise<void> {
		if (!this.panel) {
			return;
		}
		const state = await buildViewState(selectedId);
		await this.panel.webview.postMessage({ type: 'state', state });
	}

	private webviewHtml(webview: vscode.Webview): string {
		const nonce = randomNonce();
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(media, 'environmentSetup.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(media, 'environmentSetup.js'));
		const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(media, 'orbyte-brand.svg'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${styleUri}">
	<title>Orbyte Environment Setup</title>
</head>
<body>
	<div id="app" data-icon="${iconUri}"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

async function buildViewState(selectedId?: string): Promise<IEnvironmentViewState> {
	const detected = await detectEnvironment();
	const configuration = vscode.workspace.getConfiguration('orbyte.environment');
	const runtimePaths = configuration.get<Record<string, string>>('runtimePaths', {});
	const detectedPaths: Record<string, string> = {};
	const detectedVersions: Record<string, string> = {};
	for (const environment of environments) {
		const detectedPath = await findExecutable(environment.executables);
		if (detectedPath) {
			detectedPaths[environment.id] = detectedPath;
			detectedVersions[environment.id] = await executableVersion(detectedPath) ?? 'Installed';
		}
	}
	const totalMemoryGb = Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10;
	const javaInstalledJdks = await findInstalledJdks();
	const javaProjectPath = vscode.workspace.getConfiguration('orbyte.java', configurationResource()).get<string>('jdkHome', '');
	const preferredJavaVersion = Number(configuration.get<Record<string, string>>('preferredVersions', {}).java);
	const preferredInstalledJdk = javaInstalledJdks.find(jdk => jdk.version === preferredJavaVersion) ?? javaInstalledJdks[0];
	const configuredProjectHome = isJavaHomeDirectory(javaProjectPath) ? javaProjectPath : '';
	const javaJdkPath = configuredProjectHome || preferredInstalledJdk?.path || detectedPaths.java || '';
	const javaExecutable = javaJdkPath
		? resolveJavaExecutable(javaJdkPath)
		: detectedPaths.java;
	const javaJdkVersion = javaExecutable ? await executableVersion(javaExecutable) : undefined;
	const javaJdkMajor = javaJdkVersion ? parseJavaMajor(javaJdkVersion) : undefined;
	const javaJdkReady = Boolean(configuredProjectHome && javaJdkMajor);
	return {
		selectedId: environmentByIdOrLanguage(selectedId)?.id ?? detected?.id ?? 'java',
		detectedId: detected?.id,
		platform: process.platform,
		architecture: process.arch,
		totalMemoryGb,
		recommendedHeapMb: recommendedHeapMb(),
		autoDetect: configuration.get<boolean>('autoDetect', true),
		preferredVersions: configuration.get<Record<string, string>>('preferredVersions', {}),
		heapMb: configuration.get<Record<string, number>>('heapMb', {}),
		runtimePaths,
		detectedPaths,
		detectedVersions,
		javaJdkPath,
		javaJdkMajor,
		javaJdkReady,
		javaInstalledJdks,
		environments: environments.map(environment => ({
			id: environment.id,
			label: environment.label,
			shortLabel: environment.shortLabel,
			versions: environment.versions,
			recommendedVersion: environment.recommendedVersion,
			memorySupported: environment.memory !== 'none',
			hasSelector: Boolean(environment.selectorCommand),
		})),
	};
}

function environmentByIdOrLanguage(value?: string): ILanguageEnvironment | undefined {
	return environments.find(environment => environment.id === value || environment.languageIds.includes(value ?? ''));
}

function resolveJavaExecutable(homeOrExecutable: string): string | undefined {
	if (!existsSync(homeOrExecutable)) {
		return undefined;
	}
	try {
		if (statSync(homeOrExecutable).isFile()) {
			return homeOrExecutable;
		}
	} catch {
		return undefined;
	}
	const executable = path.join(homeOrExecutable, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
	return existsSync(executable) ? executable : undefined;
}

function isJavaHomeDirectory(value: string): boolean {
	if (!value || !existsSync(value)) {
		return false;
	}
	try {
		if (!statSync(value).isDirectory()) {
			return false;
		}
	} catch {
		return false;
	}
	const suffix = process.platform === 'win32' ? '.exe' : '';
	return existsSync(path.join(value, 'bin', `java${suffix}`)) && existsSync(path.join(value, 'bin', `javac${suffix}`));
}

function parseJavaMajor(versionOutput: string): number | undefined {
	const match = /(?:java|openjdk)(?:\s+version)?\s+"?(?:(1)\.)?(\d+)/i.exec(versionOutput);
	return match ? Number(match[2]) : undefined;
}

async function configuredOrDetectedRuntime(environment: ILanguageEnvironment): Promise<string | undefined> {
	const configured = vscode.workspace.getConfiguration('orbyte.environment').get<Record<string, string>>('runtimePaths', {})[environment.id];
	return configured && existsSync(configured) ? configured : findExecutable(environment.executables);
}

function resolveExecutable(environment: ILanguageEnvironment, selectedPath: string): string | undefined {
	if (!existsSync(selectedPath)) {
		return undefined;
	}
	try {
		if (statSync(selectedPath).isFile()) {
			return selectedPath;
		}
	} catch {
		return undefined;
	}
	const suffix = process.platform === 'win32' ? '.exe' : '';
	for (const name of environment.executables) {
		for (const candidate of [path.join(selectedPath, `${name}${suffix}`), path.join(selectedPath, 'bin', `${name}${suffix}`)]) {
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

async function detectEnvironment(): Promise<ILanguageEnvironment | undefined> {
	const languageId = vscode.window.activeTextEditor?.document.languageId;
	const active = environmentByIdOrLanguage(languageId);
	if (active || !vscode.workspace.workspaceFolders?.length) {
		return active;
	}
	const signals: readonly [string, string][] = [
		['java', '**/{pom.xml,build.gradle,build.gradle.kts,build.xml,*.java,*.kt,*.groovy}'],
		['node', '**/{package.json,tsconfig.json,jsconfig.json,*.ts,*.tsx,*.js,*.jsx}'],
		['python', '**/{pyproject.toml,requirements.txt,Pipfile,*.py}'],
		['cpp', '**/{CMakeLists.txt,Makefile,*.c,*.cc,*.cpp,*.h,*.hpp}'],
		['dotnet', '**/*.{sln,csproj,fsproj,cs,fs}'],
		['go', '**/{go.mod,go.work,*.go}'],
		['rust', '**/{Cargo.toml,*.rs}'],
		['php', '**/{composer.json,*.php}'],
		['ruby', '**/{Gemfile,*.rb}'],
	];
	const excluded = '**/{node_modules,target,build,out,dist,vendor,.git}/**';
	for (const [id, include] of signals) {
		if ((await vscode.workspace.findFiles(include, excluded, 1)).length) {
			return environmentByIdOrLanguage(id);
		}
	}
	return undefined;
}

async function findExecutable(names: readonly string[]): Promise<string | undefined> {
	for (const name of names) {
		try {
			const output = await run(process.platform === 'win32' ? 'where.exe' : 'which', [name]);
			const first = output.split(/\r?\n/).map(line => line.trim()).find(Boolean);
			if (first) {
				return first;
			}
		} catch {
			// Try the next executable name.
		}
	}
	return undefined;
}

async function executableVersion(executable: string): Promise<string | undefined> {
	for (const argument of ['--version', '-version']) {
		try {
			const output = await run(executable, [argument]);
			return output.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 90);
		} catch {
			// Try the alternative version argument.
		}
	}
	return undefined;
}

async function applyLanguageRuntimeSetting(environment: ILanguageEnvironment, executable: string, target: vscode.ConfigurationTarget): Promise<void> {
	const configuration = vscode.workspace.getConfiguration();
	if (environment.id === 'node') {
		await configuration.update('js/ts.tsserver.node.path', executable, target);
	} else if (environment.id === 'python') {
		await configuration.update('python.defaultInterpreterPath', executable, target);
	} else if (environment.id === 'cpp') {
		await configuration.update('C_Cpp.default.compilerPath', executable, target);
	} else if (environment.id === 'go') {
		await configuration.update('go.goroot', path.dirname(path.dirname(executable)), target);
	} else if (environment.id === 'php') {
		await configuration.update('php.validate.executablePath', executable, target);
	}
}

async function addExecutableToTerminalPath(executable: string, target: vscode.ConfigurationTarget): Promise<void> {
	const key = process.platform === 'win32' ? 'terminal.integrated.env.windows' : process.platform === 'darwin' ? 'terminal.integrated.env.osx' : 'terminal.integrated.env.linux';
	const configuration = vscode.workspace.getConfiguration();
	const existing = configuration.get<Record<string, string | null>>(key, {});
	const variable = process.platform === 'win32' ? '${env:Path}' : '${env:PATH}';
	const separator = process.platform === 'win32' ? ';' : ':';
	await configuration.update(key, { ...existing, PATH: `${path.dirname(executable)}${separator}${variable}` }, target);
}

async function applyMemory(environment: ILanguageEnvironment, heapMb: number, target: vscode.ConfigurationTarget): Promise<void> {
	const configuration = vscode.workspace.getConfiguration('orbyte.environment');
	const current = configuration.get<Record<string, number>>('heapMb', {});
	const next = { ...current };
	if (heapMb === 0) {
		delete next[environment.id];
	} else {
		next[environment.id] = heapMb;
	}
	await configuration.update('heapMb', next, target);
	const settings = vscode.workspace.getConfiguration();
	if (environment.memory === 'node') {
		await settings.update('js/ts.tsserver.maxMemory', heapMb || undefined, target);
	} else if (environment.memory === 'java') {
		await settings.update('java.jdt.ls.vmargs', replaceMemoryArg(settings.get<unknown>('java.jdt.ls.vmargs'), heapMb), target);
		await settings.update('spring-boot.ls.java.vmargs', replaceMemoryArg(settings.get<unknown>('spring-boot.ls.java.vmargs'), heapMb), target);
	}
}

function replaceMemoryArg(argumentsValue: unknown, heapMb: number): unknown {
	if (Array.isArray(argumentsValue)) {
		const withoutMaximum = argumentsValue
			.filter((value): value is string => typeof value === 'string')
			.map(removeMaximumHeapArgument)
			.filter(Boolean);
		return heapMb ? [...withoutMaximum, `-Xmx${heapMb}m`] : withoutMaximum;
	}
	if (typeof argumentsValue === 'string') {
		const withoutMaximum = removeMaximumHeapArgument(argumentsValue);
		return heapMb ? `${withoutMaximum}${withoutMaximum ? ' ' : ''}-Xmx${heapMb}m` : withoutMaximum;
	}
	if (argumentsValue !== undefined && argumentsValue !== null) {
		return argumentsValue;
	}
	return heapMb ? `-Xmx${heapMb}m` : undefined;
}

function removeMaximumHeapArgument(value: string): string {
	return value.replace(/(?:^|\s)-Xmx\d+[kKmMgG]?\b/g, '').replace(/\s+/g, ' ').trim();
}

function recommendedHeapMb(): number {
	const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
	return Math.min(16384, Math.max(1024, Math.floor(totalMb * 0.25 / 256) * 256));
}

function downloadUrl(environment: ILanguageEnvironment, version: string): string {
	if (environment.id === 'node') {
		return `https://nodejs.org/dist/latest-v${encodeURIComponent(version)}.x/`;
	}
	if (environment.id === 'python') {
		return `https://www.python.org/downloads/?version=${encodeURIComponent(version)}`;
	}
	if (environment.id === 'dotnet') {
		return `https://dotnet.microsoft.com/download/dotnet/${encodeURIComponent(version)}.0`;
	}
	return environment.downloadUrl;
}

function configurationResource(): vscode.Uri | undefined {
	const active = vscode.window.activeTextEditor?.document.uri;
	return active && vscode.workspace.getWorkspaceFolder(active) ? active : vscode.workspace.workspaceFolders?.[0]?.uri;
}

function randomNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	return Array.from({ length: 32 }, () => alphabet.charAt(Math.floor(Math.random() * alphabet.length))).join('');
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
