/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbyte. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

type RunMode = 'run' | 'debug';

interface IApplicationDescriptor {
	readonly id: string;
	readonly name: string;
	readonly language: string;
	readonly framework: string;
	readonly root: string;
	readonly command?: { readonly executable: string; readonly args: readonly string[] };
	readonly debug?: IDebugConfiguration;
	readonly enterprise?: boolean;
}

interface IDebugConfiguration {
	readonly type: string;
	readonly request: string;
	readonly [key: string]: unknown;
}

interface IRunConfiguration {
	readonly name: string;
	readonly applications: readonly string[];
	readonly programArgs?: Readonly<Record<string, string>>;
	readonly commandOverrides?: Readonly<Record<string, string>>;
}

const SEARCH_EXCLUDE = '**/{.git,.idea,.gradle,node_modules,target,build,out,dist,vendor,bin,obj}/**';

export function registerApplicationRuntime(context: vscode.ExtensionContext): void {
	const runtime = new ApplicationRuntime();
	context.subscriptions.push(runtime);
	void runtime.start();
}

class ApplicationRuntime implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 91);
	private readonly runningTasks = new Map<string, vscode.TaskExecution>();
	private readonly debugSessions = new Map<string, vscode.DebugSession>();
	private applications: readonly IApplicationDescriptor[] = [];
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;

	constructor() {
		this.statusBar.name = 'Orbyte Run Configuration';
		this.statusBar.command = 'orbyte.run.select';
		this.disposables.push(
			this.statusBar,
			vscode.commands.registerCommand('orbyte.run.configure', (resource?: vscode.Uri) => this.configure(resource)),
			vscode.commands.registerCommand('orbyte.run.select', () => this.selectConfiguration()),
			vscode.commands.registerCommand('orbyte.run.runSelected', () => this.runSelected('run')),
			vscode.commands.registerCommand('orbyte.run.debugSelected', () => this.runSelected('debug')),
			vscode.commands.registerCommand('orbyte.run.stopSelected', () => this.stopSelected()),
			vscode.commands.registerCommand('orbyte.run.runDetected', (resource?: vscode.Uri) => this.runDetected(resource, 'run')),
			vscode.commands.registerCommand('orbyte.run.debugDetected', (resource?: vscode.Uri) => this.runDetected(resource, 'debug')),
			vscode.commands.registerCommand('orbyte.run.refreshApplications', () => this.refresh(true)),
			vscode.tasks.onDidStartTask(event => this.trackTask(event.execution)),
			vscode.tasks.onDidEndTask(event => this.untrackTask(event.execution)),
			vscode.debug.onDidStartDebugSession(session => this.trackDebug(session)),
			vscode.debug.onDidTerminateDebugSession(session => this.untrackDebug(session)),
			vscode.window.onDidChangeActiveTextEditor(() => this.updateStatusBar()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('orbyte.run')) {
					this.updateStatusBar();
				}
			}),
		);

		for (const pattern of ['**/package.json', '**/pyproject.toml', '**/requirements*.txt', '**/manage.py', '**/composer.json', '**/*.csproj', '**/go.mod', '**/Cargo.toml', '**/Gemfile', '**/CMakeLists.txt']) {
			const watcher = vscode.workspace.createFileSystemWatcher(pattern);
			this.disposables.push(watcher, watcher.onDidCreate(() => this.scheduleRefresh()), watcher.onDidChange(() => this.scheduleRefresh()), watcher.onDidDelete(() => this.scheduleRefresh()));
		}
	}

	async start(): Promise<void> {
		await this.refresh(false);
		for (const execution of vscode.tasks.taskExecutions) {
			this.trackTask(execution);
		}
		if (vscode.debug.activeDebugSession) {
			this.trackDebug(vscode.debug.activeDebugSession);
		}
		this.updateStatusBar();
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refresh(false);
		}, 600);
	}

	private async refresh(showResult: boolean): Promise<void> {
		const [javaApplications, workspaceApplications] = await Promise.all([
			vscode.commands.executeCommand<IApplicationDescriptor[]>('orbyte.java.listApplications').then(value => value ?? [], () => []),
			discoverWorkspaceApplications(),
		]);
		const byId = new Map<string, IApplicationDescriptor>();
		for (const application of [...javaApplications, ...workspaceApplications]) {
			byId.set(normalizePath(application.id), application);
		}
		this.applications = Array.from(byId.values()).sort((left, right) => left.name.localeCompare(right.name));
		await vscode.commands.executeCommand('setContext', 'orbyte.run.applicationDetected', this.applications.length > 0);
		this.updateStatusBar();
		if (showResult) {
			const frameworks = Array.from(new Set(this.applications.map(application => application.framework))).join(', ');
			void vscode.window.showInformationMessage(this.applications.length
				? `Orbyte detected ${this.applications.length} runnable application${this.applications.length === 1 ? '' : 's'}: ${frameworks}.`
				: 'No runnable application or supported framework was detected.');
		}
	}

	private configurations(): readonly IRunConfiguration[] {
		return vscode.workspace.getConfiguration('orbyte.run').get<IRunConfiguration[]>('configurations', []);
	}

	private selectedConfiguration(): IRunConfiguration | undefined {
		const configurations = this.configurations();
		const selectedName = vscode.workspace.getConfiguration('orbyte.run').get<string>('selectedConfiguration', '');
		return configurations.find(configuration => configuration.name === selectedName) ?? configurations[0];
	}

	private async selectConfiguration(): Promise<IRunConfiguration | undefined> {
		const configurations = this.configurations();
		if (!configurations.length) {
			await this.configure(vscode.window.activeTextEditor?.document.uri);
			return this.selectedConfiguration();
		}
		const selected = await vscode.window.showQuickPick(configurations.map(configuration => ({
			label: configuration.name,
			description: `${configuration.applications.length} application${configuration.applications.length === 1 ? '' : 's'}`,
			detail: this.describeConfiguration(configuration),
			configuration,
		})), { title: 'Select Run Configuration', placeHolder: 'Run and Debug use the selected configuration' });
		if (!selected) {
			return undefined;
		}
		await vscode.workspace.getConfiguration('orbyte.run').update('selectedConfiguration', selected.configuration.name, vscode.ConfigurationTarget.Workspace);
		this.updateStatusBar();
		return selected.configuration;
	}

	private async configure(resource?: vscode.Uri): Promise<void> {
		if (!this.applications.length) {
			await this.refresh(false);
		}
		if (!this.applications.length) {
			const action = await vscode.window.showWarningMessage(
				'Orbyte did not find a runnable application. Open a project with a supported framework or configure its SDK/runtime first.',
				'Environment Setup',
				'Refresh',
			);
			if (action === 'Environment Setup') {
				await vscode.commands.executeCommand('orbyte.environment.configure');
			} else if (action === 'Refresh') {
				await this.refresh(true);
			}
			return;
		}
		const existing = this.configurations();
		const choices: Array<
			{ readonly label: string; readonly description: string; readonly choiceType: 'new' }
			| { readonly label: string; readonly description: string; readonly choiceType: 'existing'; readonly configuration: IRunConfiguration }
		> = [
			{ label: '$(add) New Run Configuration', description: 'One application or a compound group of microservices', choiceType: 'new' as const },
			...existing.map(configuration => ({ label: `$(settings-gear) ${configuration.name}`, description: this.describeConfiguration(configuration), choiceType: 'existing' as const, configuration })),
		];
		const choice = await vscode.window.showQuickPick<(typeof choices)[number]>(choices, { title: 'Edit Run Configurations' });
		if (!choice) {
			return;
		}
		if (choice.choiceType === 'existing') {
			const action = await vscode.window.showQuickPick([
				{ label: '$(edit) Edit', action: 'edit' as const },
				{ label: '$(play) Run', action: 'run' as const },
				{ label: '$(debug-alt) Debug', action: 'debug' as const },
				{ label: '$(trash) Delete', action: 'delete' as const },
			], { title: choice.configuration.name });
			if (!action) {
				return;
			}
			if (action.action === 'run' || action.action === 'debug') {
				await this.saveSelected(choice.configuration.name);
				await this.runConfiguration(choice.configuration, action.action);
				return;
			}
			if (action.action === 'delete') {
				await this.saveConfigurations(existing.filter(configuration => configuration.name !== choice.configuration.name));
				return;
			}
			await this.editConfiguration(choice.configuration, resource);
			return;
		}
		await this.editConfiguration(undefined, resource);
	}

	private async editConfiguration(existing: IRunConfiguration | undefined, resource?: vscode.Uri): Promise<void> {
		const contextual = this.applicationForResource(resource);
		const selected = await vscode.window.showQuickPick(this.applications.map(application => ({
			label: application.name,
			description: `${application.framework} · ${application.language}`,
			detail: vscode.workspace.asRelativePath(application.root, false),
			picked: existing ? existing.applications.includes(application.id) : contextual?.id === application.id,
			application,
		})), { title: 'Applications in this configuration', canPickMany: true, placeHolder: 'Select one app or multiple microservices' });
		if (!selected?.length) {
			return;
		}
		const suggestedName = existing?.name ?? (selected.length === 1 ? selected[0].application.name : 'All Microservices');
		const name = await vscode.window.showInputBox({ title: 'Run Configuration Name', value: suggestedName, validateInput: value => value.trim() ? undefined : 'Enter a configuration name.' });
		if (!name) {
			return;
		}
		const programArgs: Record<string, string> = { ...(existing?.programArgs ?? {}) };
		const commandOverrides: Record<string, string> = { ...(existing?.commandOverrides ?? {}) };
		for (const item of selected) {
			const application = item.application;
			if (application.enterprise) {
				await vscode.commands.executeCommand('orbyte.enterprise.selectProjectServer', vscode.Uri.file(application.root));
			}
			const args = await vscode.window.showInputBox({
				title: `${application.name} · Program arguments`,
				value: programArgs[application.id] ?? '',
				prompt: 'Optional. Leave empty to use framework defaults.',
			});
			if (args === undefined) {
				return;
			}
			programArgs[application.id] = args;
			const commandChoice = await vscode.window.showQuickPick([
				{
					label: '$(sparkle) Use detected command',
					description: application.command ? `${application.command.executable} ${application.command.args.join(' ')}` : 'Use the framework debugger configuration',
					value: 'detected' as const,
				},
				{ label: '$(terminal) Use a custom command…', description: commandOverrides[application.id] || 'For custom servers, scripts, or C/C++ executables', value: 'custom' as const },
			], {
				title: `${application.name} · Launch command`,
				placeHolder: 'Orbyte detects the normal framework command; customize it only when needed.',
			});
			if (!commandChoice) {
				return;
			}
			if (commandChoice.value === 'custom') {
				const command = await vscode.window.showInputBox({
					title: `${application.name} · Custom command`,
					value: commandOverrides[application.id] ?? '',
					prompt: 'Enter the complete shell command used to launch this application.',
					validateInput: value => value.trim() ? undefined : 'Enter a command, or go back and use the detected command.',
				});
				if (command === undefined) {
					return;
				}
				commandOverrides[application.id] = command.trim();
			} else {
				delete commandOverrides[application.id];
			}
		}
		const configuration: IRunConfiguration = { name: name.trim(), applications: selected.map(item => item.application.id), programArgs, commandOverrides };
		const configurations = this.configurations().filter(candidate => candidate.name !== existing?.name && candidate.name !== configuration.name);
		await this.saveConfigurations([...configurations, configuration]);
		await this.saveSelected(configuration.name);
		void vscode.window.showInformationMessage(`${configuration.name} is now the active Run Configuration.`);
	}

	private async runSelected(mode: RunMode): Promise<void> {
		const configuration = this.selectedConfiguration() ?? await this.selectConfiguration();
		if (configuration) {
			await this.runConfiguration(configuration, mode);
		}
	}

	private async runDetected(resource: vscode.Uri | undefined, mode: RunMode): Promise<void> {
		const application = this.applicationForResource(resource ?? vscode.window.activeTextEditor?.document.uri);
		if (!application) {
			await this.runSelected(mode);
			return;
		}
		await this.runApplication(application, mode, '');
	}

	private async runConfiguration(configuration: IRunConfiguration, mode: RunMode): Promise<void> {
		const applications = configuration.applications.map(id => this.applicationById(id)).filter((value): value is IApplicationDescriptor => Boolean(value));
		if (!applications.length) {
			void vscode.window.showWarningMessage(`${configuration.name} no longer contains an application in this workspace. Edit the configuration to repair it.`);
			return;
		}
		await this.saveSelected(configuration.name);
		for (const application of applications) {
			await this.runApplication(application, mode, configuration.programArgs?.[application.id] ?? '', configuration.commandOverrides?.[application.id]);
		}
	}

	private async runApplication(application: IApplicationDescriptor, mode: RunMode, programArgs: string, commandOverride?: string): Promise<void> {
		if (application.language === 'Java' && !commandOverride) {
			await vscode.commands.executeCommand('orbyte.java.runApplication', application.root, mode, programArgs);
			return;
		}
		if (mode === 'debug' && application.debug && !commandOverride) {
			const configuration: vscode.DebugConfiguration = { ...application.debug, name: `Debug ${application.name}`, orbyteApplicationId: application.id };
			const started = await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(application.root)), configuration);
			if (!started) {
				void vscode.window.showWarningMessage(`The ${application.language} debugger could not start ${application.name}. Install its debugger extension or run the configuration normally.`);
			}
			return;
		}
		const command = commandOverride ? shellCommand(`${commandOverride}${programArgs ? ` ${programArgs}` : ''}`) : application.command;
		if (!command) {
			void vscode.window.showErrorMessage(`No run command is available for ${application.name}. Edit the Run Configuration and add a command override.`);
			return;
		}
		const args = commandOverride ? [...command.args] : appendProgramArguments(command, programArgs);
		const task = new vscode.Task(
			{ type: 'orbyte-application', application: application.id, mode },
			vscode.workspace.getWorkspaceFolder(vscode.Uri.file(application.root)) ?? vscode.TaskScope.Workspace,
			`${mode === 'debug' ? 'Debug' : 'Run'} ${application.name}`,
			'Orbyte Applications',
			new vscode.ShellExecution(command.executable, args, { cwd: application.root }),
			[],
		);
		task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
		const execution = await vscode.tasks.executeTask(task);
		this.runningTasks.set(normalizePath(application.id), execution);
		this.updateStatusBar();
	}

	private async stopSelected(): Promise<void> {
		const configuration = this.selectedConfiguration();
		const ids = Array.from(new Set([
			...(configuration?.applications ?? []),
			...this.runningTasks.keys(),
			...this.debugSessions.keys(),
		]));
		for (const id of ids) {
			const application = this.applicationById(id);
			if (application?.language === 'Java') {
				await vscode.commands.executeCommand('orbyte.java.stopApplication', application.root);
			}
			this.runningTasks.get(normalizePath(id))?.terminate();
			const session = this.debugSessions.get(normalizePath(id));
			if (session) {
				await vscode.debug.stopDebugging(session);
			}
		}
	}

	private trackTask(execution: vscode.TaskExecution): void {
		const definition = execution.task.definition as { type?: string; application?: string; project?: string };
		if (definition.type === 'orbyte-application' && definition.application) {
			this.runningTasks.set(normalizePath(definition.application), execution);
			this.updateStatusBar();
		} else if (definition.type === 'orbyte-java' && definition.project) {
			this.runningTasks.set(normalizePath(definition.project), execution);
			this.updateStatusBar();
		}
	}

	private untrackTask(execution: vscode.TaskExecution): void {
		for (const [id, active] of this.runningTasks) {
			if (active === execution) {
				this.runningTasks.delete(id);
				this.updateStatusBar();
				break;
			}
		}
	}

	private trackDebug(session: vscode.DebugSession): void {
		const id = session.configuration.orbyteApplicationId
			?? session.configuration.orbyteProject
			?? this.applicationForDebugSession(session)?.id;
		if (typeof id === 'string') {
			this.debugSessions.set(normalizePath(id), session);
			this.updateStatusBar();
		}
	}

	private untrackDebug(session: vscode.DebugSession): void {
		for (const [id, active] of this.debugSessions) {
			if (active.id === session.id) {
				this.debugSessions.delete(id);
				this.updateStatusBar();
				break;
			}
		}
	}

	private applicationForResource(resource: vscode.Uri | undefined): IApplicationDescriptor | undefined {
		if (!resource || resource.scheme !== 'file') {
			return undefined;
		}
		return this.applications
			.filter(application => isWithin(resource.fsPath, application.root))
			.sort((left, right) => Number(languageMatchesResource(right, resource)) - Number(languageMatchesResource(left, resource)) || right.root.length - left.root.length)[0];
	}

	private applicationById(id: string): IApplicationDescriptor | undefined {
		return this.applications.find(application => normalizePath(application.id) === normalizePath(id));
	}

	private applicationForDebugSession(session: vscode.DebugSession): IApplicationDescriptor | undefined {
		const cwd = typeof session.configuration.cwd === 'string' ? session.configuration.cwd : undefined;
		if (cwd) {
			const contextual = this.applications
				.filter(application => isWithin(cwd, application.root))
				.sort((left, right) => Number(languageMatchesDebugType(right, session.type)) - Number(languageMatchesDebugType(left, session.type)) || right.root.length - left.root.length)[0];
			if (contextual) {
				return contextual;
			}
		}
		const workspaceRoot = session.workspaceFolder?.uri.fsPath;
		if (!workspaceRoot) {
			return undefined;
		}
		return this.applications
			.filter(application => isWithin(application.root, workspaceRoot))
			.sort((left, right) => Number(languageMatchesDebugType(right, session.type)) - Number(languageMatchesDebugType(left, session.type)) || right.root.length - left.root.length)[0];
	}

	private describeConfiguration(configuration: IRunConfiguration): string {
		return configuration.applications.map(id => this.applicationById(id)?.name ?? path.basename(id)).join(' + ');
	}

	private async saveConfigurations(configurations: readonly IRunConfiguration[]): Promise<void> {
		await vscode.workspace.getConfiguration('orbyte.run').update('configurations', configurations, vscode.ConfigurationTarget.Workspace);
		this.updateStatusBar();
	}

	private async saveSelected(name: string): Promise<void> {
		await vscode.workspace.getConfiguration('orbyte.run').update('selectedConfiguration', name, vscode.ConfigurationTarget.Workspace);
		this.updateStatusBar();
	}

	private updateStatusBar(): void {
		const configuration = this.selectedConfiguration();
		if (!configuration && !this.applications.length) {
			this.statusBar.hide();
			return;
		}
		const running = this.runningTasks.size + this.debugSessions.size;
		void vscode.commands.executeCommand('setContext', 'orbyte.run.applicationRunning', running > 0);
		this.statusBar.text = running
			? `$(debug-stop) ${running} app${running === 1 ? '' : 's'} · ${configuration?.name ?? 'Detected'}`
			: `$(run-all) ${configuration?.name ?? this.applicationForResource(vscode.window.activeTextEditor?.document.uri)?.name ?? 'Run Configuration'}`;
		this.statusBar.tooltip = running ? 'Click to select, run, debug, edit, or stop applications' : 'Select or edit the active Run Configuration';
		this.statusBar.command = 'orbyte.run.select';
		this.statusBar.show();
	}
}

async function discoverWorkspaceApplications(): Promise<IApplicationDescriptor[]> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const applications: IApplicationDescriptor[] = [];
	for (const folder of folders) {
		const [packages, pythonProjects, manageFiles, composerFiles, csProjects, goModules, cargoFiles, gemFiles, cmakeFiles] = await Promise.all([
			find(folder, '**/package.json'),
			find(folder, '**/{pyproject.toml,requirements.txt,requirements-dev.txt}'),
			find(folder, '**/manage.py'),
			find(folder, '**/composer.json'),
			find(folder, '**/*.csproj'),
			find(folder, '**/go.mod'),
			find(folder, '**/Cargo.toml'),
			find(folder, '**/Gemfile'),
			find(folder, '**/CMakeLists.txt'),
		]);
		for (const file of packages) {
			const app = await nodeApplication(file);
			if (app) { applications.push(app); }
		}
		const pythonRoots = new Map<string, vscode.Uri>();
		for (const file of [...pythonProjects, ...manageFiles]) { pythonRoots.set(path.dirname(file.fsPath), file); }
		for (const [root, marker] of pythonRoots) { applications.push(await pythonApplication(root, marker)); }
		for (const file of composerFiles) { applications.push(await phpApplication(file)); }
		for (const file of csProjects) { applications.push(await dotnetApplication(file)); }
		for (const file of goModules) { applications.push(await goApplication(file)); }
		for (const file of cargoFiles) { applications.push(await rustApplication(file)); }
		for (const file of gemFiles) { applications.push(await rubyApplication(file)); }
		for (const file of cmakeFiles) { applications.push(await cppApplication(file)); }
	}
	return applications;
}

async function nodeApplication(file: vscode.Uri): Promise<IApplicationDescriptor | undefined> {
	const data = await readJson(file.fsPath) as { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined;
	if (!data?.scripts) { return undefined; }
	const root = path.dirname(file.fsPath);
	const script = ['dev', 'start', 'serve'].find(name => data.scripts?.[name]);
	if (!script) { return undefined; }
	const dependencies = { ...data.dependencies, ...data.devDependencies };
	const framework = dependencies.next ? 'Next.js' : dependencies.nuxt ? 'Nuxt' : dependencies['@nestjs/core'] ? 'NestJS' : dependencies['@angular/core'] ? 'Angular' : dependencies.vite ? 'Vite' : dependencies.express ? 'Express' : dependencies.react ? 'React' : 'Node.js';
	const executable = await packageManager(root);
	const args = executable === 'npm' ? ['run', script] : [script];
	const commandText = [executable, ...args].join(' ');
	return { id: `node:${root}`, name: data.name ?? path.basename(root), language: 'JavaScript / TypeScript', framework, root, command: { executable, args }, debug: { type: 'node-terminal', request: 'launch', command: commandText, cwd: root } };
}

async function pythonApplication(root: string, marker: vscode.Uri): Promise<IApplicationDescriptor> {
	const text = await readText(marker.fsPath);
	const requirements = `${text}\n${await readText(path.join(root, 'requirements.txt'))}`;
	const python = runtimePath('python', process.platform === 'win32' ? 'python.exe' : 'python3');
	if (path.basename(marker.fsPath) === 'manage.py' || /django/i.test(requirements)) {
		return { id: `python:${root}`, name: path.basename(root), language: 'Python', framework: 'Django', root, command: { executable: python, args: ['manage.py', 'runserver'] }, debug: { type: 'python', request: 'launch', program: path.join(root, 'manage.py'), args: ['runserver'], cwd: root, django: true } };
	}
	if (/fastapi|uvicorn/i.test(requirements)) {
		const module = await findPythonAppModule(root);
		return { id: `python:${root}`, name: path.basename(root), language: 'Python', framework: 'FastAPI', root, command: { executable: python, args: ['-m', 'uvicorn', `${module}:app`, '--reload'] }, debug: { type: 'python', request: 'launch', module: 'uvicorn', args: [`${module}:app`, '--reload'], cwd: root } };
	}
	if (/flask/i.test(requirements)) {
		return { id: `python:${root}`, name: path.basename(root), language: 'Python', framework: 'Flask', root, command: { executable: python, args: ['-m', 'flask', 'run', '--debug'] }, debug: { type: 'python', request: 'launch', module: 'flask', args: ['run', '--debug'], cwd: root } };
	}
	const entry = await firstExisting(root, ['main.py', 'app.py']);
	if (/streamlit/i.test(requirements) && entry) {
		return { id: `python:${root}`, name: path.basename(root), language: 'Python', framework: 'Streamlit', root, command: { executable: python, args: ['-m', 'streamlit', 'run', path.basename(entry)] }, debug: { type: 'python', request: 'launch', module: 'streamlit', args: ['run', path.basename(entry)], cwd: root } };
	}
	return { id: `python:${root}`, name: path.basename(root), language: 'Python', framework: 'Python', root, command: { executable: python, args: entry ? [path.basename(entry)] : ['-m', path.basename(root)] }, debug: entry ? { type: 'python', request: 'launch', program: entry, cwd: root } : undefined };
}

async function phpApplication(file: vscode.Uri): Promise<IApplicationDescriptor> {
	const root = path.dirname(file.fsPath);
	const text = await readText(file.fsPath);
	const php = runtimePath('php', process.platform === 'win32' ? 'php.exe' : 'php');
	const laravel = /laravel\/framework/i.test(text);
	const symfony = /symfony\/framework-bundle/i.test(text);
	const codeIgniter = /codeigniter4\/framework/i.test(text);
	const cakePhp = /cakephp\/cakephp/i.test(text);
	const args = laravel ? ['artisan', 'serve'] : codeIgniter ? ['spark', 'serve'] : cakePhp ? ['bin/cake.php', 'server'] : ['-S', 'localhost:8000', '-t', symfony ? 'public' : '.'];
	const framework = laravel ? 'Laravel' : symfony ? 'Symfony' : codeIgniter ? 'CodeIgniter' : cakePhp ? 'CakePHP' : /drupal\/core/i.test(text) ? 'Drupal' : 'PHP';
	return { id: `php:${root}`, name: path.basename(root), language: 'PHP', framework, root, command: { executable: php, args }, debug: { type: 'php', request: 'launch', port: 9003, pathMappings: { '/app': root } } };
}

async function dotnetApplication(file: vscode.Uri): Promise<IApplicationDescriptor> {
	const root = path.dirname(file.fsPath);
	const text = await readText(file.fsPath);
	const framework = /Microsoft\.NET\.Sdk\.BlazorWebAssembly/i.test(text) ? 'Blazor WebAssembly'
		: /Microsoft\.NET\.Sdk\.Web|Microsoft\.AspNetCore/i.test(text) ? 'ASP.NET Core'
			: /Microsoft\.Azure\.Functions|Microsoft\.NET\.Sdk\.Functions/i.test(text) ? 'Azure Functions'
				: /Microsoft\.Maui|UseMaui/i.test(text) ? '.NET MAUI'
					: /Microsoft\.NET\.Sdk\.Worker/i.test(text) ? '.NET Worker'
						: '.NET';
	const args = ['run', '--project', file.fsPath];
	return { id: `dotnet:${file.fsPath}`, name: path.basename(file.fsPath, '.csproj'), language: 'C# / .NET', framework, root, command: { executable: 'dotnet', args }, debug: { type: 'dotnet', request: 'launch', projectPath: file.fsPath, cwd: root } };
}

async function goApplication(file: vscode.Uri): Promise<IApplicationDescriptor> {
	const root = path.dirname(file.fsPath);
	const text = await readText(file.fsPath);
	const moduleName = /^module\s+(.+)$/m.exec(text)?.[1]?.trim();
	const framework = /github\.com\/gin-gonic\/gin/i.test(text) ? 'Gin'
		: /github\.com\/gofiber\/fiber/i.test(text) ? 'Fiber'
			: /github\.com\/labstack\/echo/i.test(text) ? 'Echo'
				: 'Go';
	return { id: `go:${root}`, name: moduleName?.split('/').pop() ?? path.basename(root), language: 'Go', framework, root, command: { executable: 'go', args: ['run', '.'] }, debug: { type: 'go', request: 'launch', mode: 'debug', program: root } };
}

async function rustApplication(file: vscode.Uri): Promise<IApplicationDescriptor> {
	const root = path.dirname(file.fsPath);
	const text = await readText(file.fsPath);
	const name = /^name\s*=\s*["']([^"']+)/m.exec(text)?.[1] ?? path.basename(root);
	return { id: `rust:${root}`, name, language: 'Rust', framework: /actix-web/i.test(text) ? 'Actix Web' : /axum/i.test(text) ? 'Axum' : /rocket/i.test(text) ? 'Rocket' : 'Rust', root, command: { executable: 'cargo', args: ['run'] }, debug: { type: 'lldb', request: 'launch', cargo: { args: ['build', '--bin', name], filter: { name, kind: 'bin' } }, args: [], cwd: root } };
}

async function rubyApplication(file: vscode.Uri): Promise<IApplicationDescriptor> {
	const root = path.dirname(file.fsPath);
	const text = await readText(file.fsPath);
	const rails = /gem\s+['"]rails['"]/i.test(text);
	return { id: `ruby:${root}`, name: path.basename(root), language: 'Ruby', framework: rails ? 'Ruby on Rails' : 'Ruby', root, command: rails ? { executable: 'bundle', args: ['exec', 'rails', 'server'] } : { executable: 'ruby', args: ['main.rb'] }, debug: { type: 'rdbg', request: 'launch', script: rails ? 'bin/rails server' : 'main.rb', cwd: root } };
}

async function cppApplication(file: vscode.Uri): Promise<IApplicationDescriptor> {
	const root = path.dirname(file.fsPath);
	const target = /add_executable\s*\(\s*([^\s)]+)/i.exec(await readText(file.fsPath))?.[1];
	const executable = target ? path.join(root, 'build', process.platform === 'win32' ? `${target}.exe` : target) : undefined;
	return {
		id: `cmake:${root}`,
		name: target ?? path.basename(root),
		language: 'C / C++',
		framework: 'CMake',
		root,
		command: executable ? shellCommand(`cmake --build build && ${shellQuote(executable)}`) : { executable: 'cmake', args: ['--build', 'build'] },
		debug: executable ? { type: 'cppdbg', request: 'launch', program: executable, cwd: root } : undefined,
	};
}

function find(folder: vscode.WorkspaceFolder, pattern: string): Thenable<vscode.Uri[]> {
	return vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), SEARCH_EXCLUDE, 200);
}

async function readJson(filePath: string): Promise<unknown | undefined> {
	try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return undefined; }
}

async function readText(filePath: string): Promise<string> {
	try { return (await fs.readFile(filePath, 'utf8')).slice(0, 1024 * 1024); } catch { return ''; }
}

async function packageManager(root: string): Promise<string> {
	for (const [file, command] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun']] as const) {
		try { await fs.access(path.join(root, file)); return command; } catch { /* Try the next manager. */ }
	}
	return 'npm';
}

function runtimePath(language: string, fallback: string): string {
	return vscode.workspace.getConfiguration('orbyte.environment').get<Record<string, string>>('runtimePaths', {})[language] || fallback;
}

async function findPythonAppModule(root: string): Promise<string> {
	const files = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(root), '**/*.py'), SEARCH_EXCLUDE, 50);
	for (const file of files) {
		if (/\bFastAPI\s*\(/.test(await readText(file.fsPath))) {
			return path.relative(root, file.fsPath).replace(/\.py$/, '').split(path.sep).join('.');
		}
	}
	return 'main';
}

async function firstExisting(root: string, names: readonly string[]): Promise<string | undefined> {
	for (const name of names) {
		const candidate = path.join(root, name);
		try { await fs.access(candidate); return candidate; } catch { /* Try next entry point. */ }
	}
	return undefined;
}

function shellCommand(value: string): { executable: string; args: string[] } {
	return process.platform === 'win32' ? { executable: 'cmd.exe', args: ['/d', '/s', '/c', value] } : { executable: '/bin/sh', args: ['-lc', value] };
}

function shellQuote(value: string): string {
	return process.platform === 'win32' ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}

function splitArguments(value: string): string[] {
	return Array.from(value.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g), match => match[1] ?? match[2] ?? match[3]);
}

function appendProgramArguments(command: { readonly executable: string; readonly args: readonly string[] }, programArgs: string): string[] {
	if (!programArgs) {
		return [...command.args];
	}
	if ((command.executable === '/bin/sh' && command.args[0] === '-lc') || (path.basename(command.executable).toLowerCase() === 'cmd.exe' && command.args.includes('/c'))) {
		const args = [...command.args];
		args[args.length - 1] = `${args[args.length - 1]} ${programArgs}`;
		return args;
	}
	return [...command.args, ...splitArguments(programArgs)];
}

function normalizePath(value: string): string {
	return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isWithin(candidate: string, parent: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function languageMatchesResource(application: IApplicationDescriptor, resource: vscode.Uri): boolean {
	const extension = path.extname(resource.fsPath).toLowerCase();
	if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte'].includes(extension)) { return application.language === 'JavaScript / TypeScript'; }
	if (extension === '.py') { return application.language === 'Python'; }
	if (extension === '.php') { return application.language === 'PHP'; }
	if (['.cs', '.fs', '.vb'].includes(extension)) { return application.language === 'C# / .NET'; }
	if (extension === '.go') { return application.language === 'Go'; }
	if (extension === '.rs') { return application.language === 'Rust'; }
	if (extension === '.rb') { return application.language === 'Ruby'; }
	if (['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp'].includes(extension)) { return application.language === 'C / C++'; }
	if (['.java', '.kt', '.kts', '.groovy'].includes(extension)) { return application.language === 'Java'; }
	return false;
}

function languageMatchesDebugType(application: IApplicationDescriptor, debugType: string): boolean {
	const normalized = debugType.toLowerCase();
	if (normalized === 'java') { return application.language === 'Java'; }
	if (normalized === 'python' || normalized === 'debugpy') { return application.language === 'Python'; }
	if (normalized.includes('node') || normalized.includes('chrome') || normalized.includes('pwa')) { return application.language === 'JavaScript / TypeScript'; }
	if (normalized === 'php') { return application.language === 'PHP'; }
	if (normalized === 'coreclr' || normalized === 'dotnet' || normalized === 'clr') { return application.language === 'C# / .NET'; }
	if (normalized === 'go') { return application.language === 'Go'; }
	if (normalized === 'lldb' || normalized === 'rust') { return application.language === 'Rust'; }
	if (normalized === 'rdbg' || normalized === 'ruby') { return application.language === 'Ruby'; }
	if (normalized === 'cppdbg' || normalized === 'cppvsdbg') { return application.language === 'C / C++'; }
	return false;
}
