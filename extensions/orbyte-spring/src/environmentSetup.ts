/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbyte. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface ILanguageEnvironment {
	readonly id: string;
	readonly label: string;
	readonly icon: string;
	readonly languageIds: readonly string[];
	readonly executables: readonly string[];
	readonly selectorCommand?: string;
	readonly downloadUrl: string;
	readonly memory: 'java' | 'node' | 'none';
}

const environments: readonly ILanguageEnvironment[] = [
	{ id: 'java', label: 'Java / JVM', icon: 'coffee', languageIds: ['java', 'kotlin', 'groovy'], executables: ['java'], downloadUrl: 'https://adoptium.net/temurin/releases/', memory: 'java' },
	{ id: 'node', label: 'JavaScript / TypeScript', icon: 'symbol-method', languageIds: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'], executables: ['node'], downloadUrl: 'https://nodejs.org/en/download', memory: 'node' },
	{ id: 'python', label: 'Python', icon: 'symbol-method', languageIds: ['python'], executables: ['python3', 'python'], selectorCommand: 'python.setInterpreter', downloadUrl: 'https://www.python.org/downloads/', memory: 'none' },
	{ id: 'cpp', label: 'C / C++', icon: 'symbol-namespace', languageIds: ['c', 'cpp', 'cuda-cpp'], executables: ['clang', 'gcc', 'cl'], selectorCommand: 'C_Cpp.SelectIntelliSenseConfiguration', downloadUrl: 'https://code.visualstudio.com/docs/cpp/config-mingw', memory: 'none' },
	{ id: 'dotnet', label: '.NET / C#', icon: 'symbol-class', languageIds: ['csharp', 'fsharp', 'vb'], executables: ['dotnet'], downloadUrl: 'https://dotnet.microsoft.com/download', memory: 'none' },
	{ id: 'go', label: 'Go', icon: 'symbol-struct', languageIds: ['go'], executables: ['go'], selectorCommand: 'go.locate.tools', downloadUrl: 'https://go.dev/dl/', memory: 'none' },
	{ id: 'rust', label: 'Rust', icon: 'symbol-struct', languageIds: ['rust'], executables: ['rustc', 'cargo'], downloadUrl: 'https://rustup.rs/', memory: 'none' },
	{ id: 'php', label: 'PHP', icon: 'symbol-method', languageIds: ['php'], executables: ['php'], downloadUrl: 'https://www.php.net/downloads', memory: 'none' },
	{ id: 'ruby', label: 'Ruby', icon: 'ruby', languageIds: ['ruby'], executables: ['ruby'], downloadUrl: 'https://www.ruby-lang.org/en/downloads/', memory: 'none' },
];

export function registerEnvironmentSetup(context: vscode.ExtensionContext): void {
	const manager = new EnvironmentSetupManager();
	context.subscriptions.push(
		manager,
		vscode.commands.registerCommand('orbyte.environment.configure', () => manager.configure()),
	);
	void manager.start();
}

class EnvironmentSetupManager implements vscode.Disposable {
	private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
	private readonly disposables: vscode.Disposable[] = [];
	private readonly prompted = new Set<string>();
	private updateTimer: NodeJS.Timeout | undefined;

	constructor() {
		this.statusBar.name = 'Language Environment Setup';
		this.statusBar.command = 'orbyte.environment.configure';
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => this.scheduleUpdate()),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('orbyte.environment')) {
					this.scheduleUpdate();
				}
			}),
		);
	}

	dispose(): void {
		if (this.updateTimer) {
			clearTimeout(this.updateTimer);
		}
		this.statusBar.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	async start(): Promise<void> {
		await this.update();
	}

	private scheduleUpdate(): void {
		if (this.updateTimer) {
			clearTimeout(this.updateTimer);
		}
		this.updateTimer = setTimeout(() => void this.update(), 500);
	}

	async configure(): Promise<void> {
		const detected = await detectEnvironment();
		const selected = detected ?? await vscode.window.showQuickPick(environments.map(environment => ({
			label: `$(${environment.icon}) ${environment.label}`,
			description: 'Configure runtime, compiler/interpreter, and supported memory settings',
			environment,
		})), {
			title: 'Language Environment Setup',
			placeHolder: 'Choose a programming language environment',
		}).then(choice => choice?.environment);
		if (!selected) {
			return;
		}
		if (selected.id === 'java') {
			const javaChoice = await vscode.window.showQuickPick([
				{ label: '$(coffee) SDKs and JDK paths', description: 'Configure JDK 25+ for tooling and a separate project JDK', action: 'runtime' as const },
				{ label: '$(dashboard) Language-server memory and heap', description: memoryDescription(selected), action: 'memory' as const },
				{ label: '$(json) Open all Java settings', description: 'Review advanced Java and Spring Boot settings', action: 'settings' as const },
			], { title: 'Java / JVM Environment', placeHolder: 'Choose what to configure' });
			if (javaChoice?.action === 'runtime') {
				await vscode.commands.executeCommand('orbyte.java.configureJdk');
			} else if (javaChoice?.action === 'memory') {
				await configureMemory(selected);
			} else if (javaChoice?.action === 'settings') {
				await vscode.commands.executeCommand('workbench.action.openSettings', 'Java');
			}
			return;
		}

		const detectedTool = await findExecutable(selected.executables);
		const runtimePaths = vscode.workspace.getConfiguration('orbyte.environment').get<Record<string, string>>('runtimePaths', {});
		const configuredPath = runtimePaths[selected.id];
		const choice = await vscode.window.showQuickPick([
			{
				label: `$(terminal) ${selected.label} runtime / toolchain`,
				description: configuredPath ? `Configured: ${configuredPath}` : detectedTool ? `Detected: ${detectedTool}` : 'Not detected on PATH',
				action: 'runtime' as const,
			},
			...(selected.selectorCommand ? [{
				label: '$(settings-gear) Open language-specific selector',
				description: 'Use the installed language extension to choose its interpreter or compiler',
				action: 'selector' as const,
			}] : []),
			...(selected.memory !== 'none' ? [{
				label: '$(dashboard) Memory and heap',
				description: memoryDescription(selected),
				action: 'memory' as const,
			}] : []),
			{
				label: '$(cloud-download) Download / install runtime',
				description: `Open the official ${selected.label} installation page`,
				action: 'download' as const,
			},
			{
				label: '$(json) Open all language settings',
				description: `Search settings for ${selected.label}`,
				action: 'settings' as const,
			},
		], {
			title: `${selected.label} Environment`,
			placeHolder: 'Choose what to configure',
		});

		if (choice?.action === 'runtime') {
			await this.selectRuntime(selected);
		} else if (choice?.action === 'selector' && selected.selectorCommand) {
			try {
				await vscode.commands.executeCommand(selected.selectorCommand);
			} catch {
				void vscode.window.showWarningMessage(`The ${selected.label} language extension is not ready. Install or enable it, then retry.`);
			}
		} else if (choice?.action === 'memory') {
			await configureMemory(selected);
		} else if (choice?.action === 'download') {
			await vscode.env.openExternal(vscode.Uri.parse(selected.downloadUrl));
		} else if (choice?.action === 'settings') {
			await vscode.commands.executeCommand('workbench.action.openSettings', selected.label);
		}
	}

	private async selectRuntime(environment: ILanguageEnvironment): Promise<void> {
		const selection = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			openLabel: `Use for ${environment.label}`,
			title: `Select the ${environment.label} executable`,
		});
		if (!selection?.[0]) {
			return;
		}
		const executable = selection[0].fsPath;
		const configuration = vscode.workspace.getConfiguration('orbyte.environment');
		const current = configuration.get<Record<string, string>>('runtimePaths', {});
		await configuration.update('runtimePaths', { ...current, [environment.id]: executable }, vscode.ConfigurationTarget.Global);
		try {
			await applyLanguageRuntimeSetting(environment, executable);
		} catch (error) {
			void vscode.window.showWarningMessage(`The runtime path was saved, but the language-specific setting could not be updated: ${error instanceof Error ? error.message : String(error)}`);
		}
		await addExecutableToTerminalPath(executable);
		void vscode.window.showInformationMessage(`${environment.label} now uses ${executable}. New terminals will include it on PATH.`);
		await this.update();
	}

	private async update(): Promise<void> {
		const environment = await detectEnvironment();
		if (!environment || environment.id === 'java') {
			this.statusBar.hide();
			return;
		}
		const configured = vscode.workspace.getConfiguration('orbyte.environment').get<Record<string, string>>('runtimePaths', {})[environment.id];
		const executable = configured && existsSync(configured) ? configured : await findExecutable(environment.executables);
		this.statusBar.text = executable ? `$(${environment.icon}) ${environment.label}` : `$(warning) Set up ${environment.label}`;
		this.statusBar.tooltip = executable
			? `${environment.label} runtime detected at ${executable}. Click to change runtime and memory settings.`
			: `${environment.label} runtime was not detected. Click to select or download it.`;
		this.statusBar.backgroundColor = executable ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
		this.statusBar.show();

		if (!executable && vscode.workspace.isTrusted && !this.prompted.has(environment.id)) {
			this.prompted.add(environment.id);
			const action = await vscode.window.showWarningMessage(
				`${environment.label} was detected, but its required runtime or compiler is not available.`,
				'Configure Environment',
				'Download',
			);
			if (action === 'Configure Environment') {
				await this.configure();
			} else if (action === 'Download') {
				await vscode.env.openExternal(vscode.Uri.parse(environment.downloadUrl));
			}
		}
	}
}

function activeEnvironment(): ILanguageEnvironment | undefined {
	const languageId = vscode.window.activeTextEditor?.document.languageId;
	return environments.find(environment => languageId && environment.languageIds.includes(languageId));
}

async function detectEnvironment(): Promise<ILanguageEnvironment | undefined> {
	const active = activeEnvironment();
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
			return environments.find(environment => environment.id === id);
		}
	}
	return undefined;
}

async function findExecutable(names: readonly string[]): Promise<string | undefined> {
	for (const name of names) {
		try {
			const command = process.platform === 'win32' ? 'where.exe' : 'which';
			const output = await run(command, [name]);
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

async function applyLanguageRuntimeSetting(environment: ILanguageEnvironment, executable: string): Promise<void> {
	const target = vscode.ConfigurationTarget.Global;
	if (environment.id === 'node') {
		await vscode.workspace.getConfiguration().update('js/ts.tsserver.node.path', executable, target);
	} else if (environment.id === 'python') {
		await vscode.workspace.getConfiguration().update('python.defaultInterpreterPath', executable, target);
	} else if (environment.id === 'cpp') {
		await vscode.workspace.getConfiguration().update('C_Cpp.default.compilerPath', executable, target);
	} else if (environment.id === 'go') {
		await vscode.workspace.getConfiguration().update('go.goroot', path.dirname(path.dirname(executable)), target);
	} else if (environment.id === 'php') {
		await vscode.workspace.getConfiguration().update('php.validate.executablePath', executable, target);
	}
}

async function addExecutableToTerminalPath(executable: string): Promise<void> {
	const key = process.platform === 'win32' ? 'terminal.integrated.env.windows' : process.platform === 'darwin' ? 'terminal.integrated.env.osx' : 'terminal.integrated.env.linux';
	const configuration = vscode.workspace.getConfiguration();
	const existing = configuration.get<Record<string, string | null>>(key, {});
	const variable = process.platform === 'win32' ? '${env:Path}' : '${env:PATH}';
	const separator = process.platform === 'win32' ? ';' : ':';
	await configuration.update(key, { ...existing, PATH: `${path.dirname(executable)}${separator}${variable}` }, vscode.ConfigurationTarget.Global);
}

function memoryDescription(environment: ILanguageEnvironment): string {
	const values = vscode.workspace.getConfiguration('orbyte.environment').get<Record<string, number>>('heapMb', {});
	return values[environment.id] ? `Current maximum: ${values[environment.id]} MB` : 'Auto-sized by default; set a custom maximum when needed';
}

async function configureMemory(environment: ILanguageEnvironment): Promise<void> {
	const current = vscode.workspace.getConfiguration('orbyte.environment').get<Record<string, number>>('heapMb', {});
	const value = await vscode.window.showInputBox({
		title: `${environment.label} Memory / Heap`,
		prompt: 'Maximum memory in MB. Use 0 to return to automatic sizing.',
		value: String(current[environment.id] ?? (environment.memory === 'java' ? 2048 : 4096)),
		validateInput: input => /^\d+$/.test(input) && Number(input) >= 0 && Number(input) <= 131072 ? undefined : 'Enter a value from 0 to 131072 MB.',
	});
	if (value === undefined) {
		return;
	}
	const heapMb = Number(value);
	const configuration = vscode.workspace.getConfiguration('orbyte.environment');
	const next = { ...current };
	if (heapMb === 0) {
		delete next[environment.id];
	} else {
		next[environment.id] = heapMb;
	}
	await configuration.update('heapMb', next, vscode.ConfigurationTarget.Global);

	if (environment.memory === 'node') {
		await vscode.workspace.getConfiguration().update('js/ts.tsserver.maxMemory', heapMb || undefined, vscode.ConfigurationTarget.Global);
	} else if (environment.memory === 'java') {
		const settings = vscode.workspace.getConfiguration();
		const currentVmArgs = settings.get<string>('java.jdt.ls.vmargs', '');
		await settings.update('java.jdt.ls.vmargs', replaceMemoryArg(currentVmArgs, heapMb), vscode.ConfigurationTarget.Global);
		const springArgs = settings.get<string>('spring-boot.ls.vmargs', '');
		await settings.update('spring-boot.ls.vmargs', replaceMemoryArg(springArgs, heapMb), vscode.ConfigurationTarget.Global);
	}
	void vscode.window.showInformationMessage(heapMb ? `${environment.label} maximum memory set to ${heapMb} MB.` : `${environment.label} memory returned to automatic sizing.`);
}

function replaceMemoryArg(argumentsValue: string, heapMb: number): string {
	const withoutMaximum = argumentsValue.replace(/(?:^|\s)-Xmx\d+[kKmMgG]?\b/g, '').replace(/\s+/g, ' ').trim();
	return heapMb ? `${withoutMaximum}${withoutMaximum ? ' ' : ''}-Xmx${heapMb}m` : withoutMaximum;
}

function run(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error((stderr || stdout || error.message).trim()));
				return;
			}
			resolve(stdout);
		});
	});
}
