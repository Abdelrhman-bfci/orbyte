/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbyte. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { configuredJdkEnvironment, resolveProjectJdkEnvironment } from './jdkRuntime';
import { javaBuildCommand } from './offlineRuntime';

type BuildTool = 'maven' | 'gradle' | 'ant' | 'java';
type ProjectAction = 'run' | 'debug' | 'build' | 'test';
type ActiveApplicationMode = 'run' | 'debug';
type JavaFramework = 'spring-boot' | 'quarkus' | 'micronaut' | 'helidon' | 'vertx' | 'jakarta-ee' | 'java';

interface IJavaProject {
	readonly folder: vscode.WorkspaceFolder;
	readonly root: vscode.Uri;
	readonly name: string;
	readonly buildTool: BuildTool;
	readonly framework: JavaFramework;
	readonly enterprise: boolean;
	readonly serverDeployable: boolean;
	readonly springBoot: boolean;
	readonly springDevtools: boolean;
	readonly mainClass?: string;
	readonly mainUri?: vscode.Uri;
	readonly antTargets: ReadonlySet<string>;
}

interface IProjectCandidate {
	readonly folder: vscode.WorkspaceFolder;
	readonly root: vscode.Uri;
	readonly buildTool: BuildTool;
	readonly buildFile?: vscode.Uri;
}

const PROJECT_EXCLUDE = '**/{.git,.idea,.gradle,target,build,out,node_modules}/**';
const JAVA_MAIN_PATTERN = /\bstatic\s+void\s+main\s*\(/;
const KOTLIN_MAIN_PATTERN = /\bfun\s+main\s*\(/;
const SPRING_MAIN_PATTERN = /@SpringBootApplication\b|SpringApplication\.run\s*\(|runApplication\s*</;

export function registerProjectRuntime(context: vscode.ExtensionContext): void {
	const runtime = new JavaProjectRuntime();
	context.subscriptions.push(runtime);
	void runtime.start();
}

class JavaProjectRuntime implements vscode.Disposable, vscode.CodeLensProvider, vscode.TaskProvider, vscode.DebugConfigurationProvider {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly codeLensChangedEmitter = new vscode.EventEmitter<void>();
	private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
	private readonly runningTasks = new Map<string, vscode.TaskExecution>();
	private readonly debugSessions = new Map<string, { readonly session: vscode.DebugSession; readonly mode: ActiveApplicationMode }>();
	private projects: readonly IJavaProject[] = [];
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;

	readonly onDidChangeCodeLenses = this.codeLensChangedEmitter.event;

	constructor() {
		this.statusBar.command = 'orbyte.spring.showProjectActions';
		this.statusBar.name = 'Orbyte Java Project';
		this.disposables.push(
			this.statusBar,
			this.codeLensChangedEmitter,
			vscode.languages.registerCodeLensProvider([
				{ language: 'java', scheme: 'file' },
				{ language: 'kotlin', scheme: 'file' },
				{ language: 'groovy', scheme: 'file' },
			], this),
			vscode.tasks.registerTaskProvider('orbyte-java', this),
			vscode.debug.registerDebugConfigurationProvider('java', this, vscode.DebugConfigurationProviderTriggerKind.Dynamic),
			vscode.commands.registerCommand('orbyte.spring.run', (uri?: vscode.Uri) => this.execute('run', uri)),
			vscode.commands.registerCommand('orbyte.spring.debug', (uri?: vscode.Uri) => this.execute('debug', uri)),
			vscode.commands.registerCommand('orbyte.spring.stop', (uri?: vscode.Uri) => this.stop(uri)),
			vscode.commands.registerCommand('orbyte.spring.restart', (uri?: vscode.Uri) => this.restart(uri)),
			vscode.commands.registerCommand('orbyte.spring.hotReload', (uri?: vscode.Uri) => this.hotReload(uri)),
			vscode.commands.registerCommand('orbyte.spring.build', (uri?: vscode.Uri) => this.execute('build', uri)),
			vscode.commands.registerCommand('orbyte.spring.test', (uri?: vscode.Uri) => this.execute('test', uri)),
			vscode.commands.registerCommand('orbyte.spring.refreshProjects', () => this.refresh(true)),
			vscode.commands.registerCommand('orbyte.spring.showProjectActions', () => this.showProjectActions()),
			vscode.commands.registerCommand('orbyte.java.listApplications', async () => {
				if (!this.projects.length) {
					await this.refresh(false);
				}
				return this.projects.map(project => ({
					id: project.root.fsPath,
					name: project.name,
					framework: frameworkLabel(project.framework),
					language: 'Java',
					root: project.root.fsPath,
					enterprise: project.enterprise,
					serverDeployable: project.serverDeployable,
				}));
			}),
			vscode.commands.registerCommand('orbyte.java.runApplication', (projectPath: string, mode: ActiveApplicationMode = 'run', programArgs = '') => this.runProjectByPath(projectPath, mode, programArgs)),
			vscode.commands.registerCommand('orbyte.java.stopApplication', (projectPath: string) => this.stopProjectByPath(projectPath)),
			vscode.tasks.onDidStartTask(event => this.trackTask(event.execution)),
			vscode.tasks.onDidEndTask(event => this.untrackTask(event.execution)),
			vscode.debug.onDidStartDebugSession(session => this.trackDebugSession(session)),
			vscode.debug.onDidTerminateDebugSession(session => this.untrackDebugSession(session)),
			vscode.window.onDidChangeActiveTextEditor(() => this.updateStatusBar()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('orbyte.java')) {
					this.scheduleRefresh();
				}
			}),
		);

		for (const pattern of ['**/pom.xml', '**/build.gradle', '**/build.gradle.kts', '**/build.xml', '**/settings.gradle', '**/settings.gradle.kts', '**/src/main/**/*.{java,kt,groovy}']) {
			const watcher = vscode.workspace.createFileSystemWatcher(pattern);
			this.disposables.push(
				watcher,
				watcher.onDidCreate(() => this.scheduleRefresh()),
				watcher.onDidChange(() => this.scheduleRefresh()),
				watcher.onDidDelete(() => this.scheduleRefresh()),
			);
		}
	}

	async start(): Promise<void> {
		for (const execution of vscode.tasks.taskExecutions) {
			this.trackTask(execution, false);
		}
		if (vscode.debug.activeDebugSession) {
			this.trackDebugSession(vscode.debug.activeDebugSession, false);
		}
		await this.refresh(false);
		this.updateApplicationState();
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const text = document.getText();
		if (!(JAVA_MAIN_PATTERN.test(text) || KOTLIN_MAIN_PATTERN.test(text))) {
			return [];
		}
		const mainMatch = /\b(?:static\s+void|fun)\s+main\s*\(/.exec(text);
		const annotationMatch = /@SpringBootApplication\b/.exec(text);
		const offset = annotationMatch?.index ?? mainMatch?.index ?? 0;
		const range = new vscode.Range(document.positionAt(offset), document.positionAt(offset));
		const project = this.projectForUri(document.uri);
		const framework = project ? frameworkLabel(project.framework) : 'Application';
		if (project && this.activeMode(project)) {
			return [
				new vscode.CodeLens(range, {
					title: `$(debug-stop) Stop ${framework}`,
					command: 'orbyte.spring.stop',
					arguments: [document.uri],
				}),
				new vscode.CodeLens(range, {
					title: `$(debug-restart) Restart ${framework}`,
					command: 'orbyte.spring.restart',
					arguments: [document.uri],
				}),
			];
		}
		return [
			new vscode.CodeLens(range, {
				title: `$(run) Run ${framework}`,
				command: 'orbyte.spring.run',
				arguments: [document.uri],
			}),
			new vscode.CodeLens(range, {
				title: `$(debug-alt) Debug ${framework}`,
				command: 'orbyte.spring.debug',
				arguments: [document.uri],
			}),
		];
	}

	provideTasks(): vscode.Task[] {
		return this.projects.flatMap(project => (['run', 'build', 'test'] as const).map(action => this.createTask(project, action)));
	}

	resolveTask(task: vscode.Task): vscode.Task | undefined {
		const definition = task.definition as { action?: ProjectAction; project?: string };
		const project = this.projects.find(candidate => candidate.root.fsPath === definition.project);
		if (!project || !definition.action || definition.action === 'debug') {
			return undefined;
		}
		return this.createTask(project, definition.action);
	}

	provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined): vscode.DebugConfiguration[] {
		return this.projects
			.filter(project => project.mainClass && (!folder || project.folder.uri.toString() === folder.uri.toString()))
			.map(project => this.debugConfiguration(project, false));
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refresh(false);
		}, 500);
	}

	private async refresh(showResult: boolean): Promise<void> {
		const autoDetect = vscode.workspace.getConfiguration('orbyte.java').get('autoDetect', true);
		this.projects = autoDetect || showResult ? await discoverProjects() : [];
		await vscode.commands.executeCommand('setContext', 'orbyte.spring.projectDetected', this.projects.length > 0);
		await vscode.commands.executeCommand('setContext', 'orbyte.spring.springBootDetected', this.projects.some(project => project.springBoot));
		this.codeLensChangedEmitter.fire();
		this.updateStatusBar();
		if (showResult) {
			const frameworks = Array.from(new Set(this.projects.map(project => frameworkLabel(project.framework)))).join(', ');
			void vscode.window.showInformationMessage(
				this.projects.length
					? `Orbyte detected ${this.projects.length} Java project${this.projects.length === 1 ? '' : 's'}: ${frameworks}.`
					: 'No Maven, Gradle, Ant, or Java application project was detected in this workspace.',
			);
		}
	}

	private updateStatusBar(): void {
		const project = this.projectForUri(vscode.window.activeTextEditor?.document.uri) ?? this.projects[0];
		const activeMode = project ? this.activeMode(project) : undefined;
		void vscode.commands.executeCommand('setContext', 'orbyte.spring.activeProjectRunning', Boolean(activeMode));
		const enabled = vscode.workspace.getConfiguration('orbyte.java').get('showStatusBar', true);
		if (!project || !enabled) {
			this.statusBar.hide();
			return;
		}
		const framework = frameworkLabel(project.framework);
		if (activeMode) {
			this.statusBar.text = `$(debug-stop) Stop ${activeMode === 'debug' ? 'Debug' : framework} · ${project.name}`;
			this.statusBar.tooltip = `${project.name} is ${activeMode === 'debug' ? 'being debugged' : 'running'}\nClick to stop the application`;
			this.statusBar.command = 'orbyte.spring.stop';
			this.statusBar.show();
			return;
		}
		this.statusBar.command = 'orbyte.spring.showProjectActions';
		this.statusBar.text = `$(run-all) ${framework} · ${buildToolLabel(project.buildTool)}`;
		this.statusBar.tooltip = `${project.name}\nRun, debug, build, or test this project`;
		this.statusBar.show();
	}

	private async showProjectActions(): Promise<void> {
		const project = await this.pickProject(vscode.window.activeTextEditor?.document.uri);
		if (!project) {
			return;
		}
		const activeMode = this.activeMode(project);
		const choice = await vscode.window.showQuickPick([
			...(activeMode ? [
				{ label: '$(debug-stop) Stop', description: `${project.name} is ${activeMode === 'debug' ? 'being debugged' : 'running'}`, action: 'stop' as const },
				{ label: '$(debug-restart) Restart', description: `Restart in ${activeMode} mode`, action: 'restart' as const },
			] : [
				{ label: '$(run) Run', description: runDescription(project), action: 'run' as const },
				{ label: '$(debug-alt) Debug', description: project.mainClass ?? 'Detect main class', action: 'debug' as const },
			]),
			{ label: '$(tools) Build', description: buildToolLabel(project.buildTool), action: 'build' as const },
			{ label: '$(beaker) Test', description: buildToolLabel(project.buildTool), action: 'test' as const },
			{ label: '$(coffee) Configure JDK', description: configuredJdkEnvironment(project.root)?.JAVA_HOME ?? 'Select or download a JDK', action: 'jdk' as const },
			{ label: '$(settings-gear) Edit Run Configurations…', description: 'Single applications, servers, and compound microservices', action: 'configuration' as const },
		], { title: `${project.name} · ${frameworkLabel(project.framework)} · ${buildToolLabel(project.buildTool)}` });
		if (choice) {
			if (choice.action === 'stop') {
				await this.stopProject(project);
			} else if (choice.action === 'restart') {
				await this.restartProject(project);
			} else if (choice.action === 'jdk') {
				await vscode.commands.executeCommand('orbyte.java.configureJdk', project.root);
			} else if (choice.action === 'configuration') {
				await vscode.commands.executeCommand('orbyte.run.configure', project.root);
			} else {
				await this.execute(choice.action, project.root);
			}
		}
	}

	private async execute(action: ProjectAction, uri?: vscode.Uri): Promise<void> {
		const project = await this.pickProject(uri ?? vscode.window.activeTextEditor?.document.uri);
		if (!project) {
			void vscode.window.showWarningMessage('Open a Maven, Gradle, Ant, or Java application project first.');
			return;
		}
		if ((action === 'run' || action === 'debug') && this.activeMode(project)) {
			const selected = await vscode.window.showInformationMessage(
				`${project.name} is already running.`,
				'Restart',
				'Stop',
			);
			if (selected === 'Restart') {
				await this.restartProject(project);
			} else if (selected === 'Stop') {
				await this.stopProject(project);
			}
			return;
		}
		if (action === 'run' || action === 'debug') {
			await this.startProject(project, action, '');
			return;
		}
		await vscode.tasks.executeTask(this.createTask(project, action, await resolveProjectJdkEnvironment(project.root, project.root.fsPath)));
	}

	private async runProjectByPath(projectPath: string, mode: ActiveApplicationMode, programArgs: string): Promise<boolean> {
		const project = this.projects.find(candidate => normalizePath(candidate.root.fsPath) === normalizePath(projectPath));
		if (!project) {
			return false;
		}
		await this.startProject(project, mode, programArgs);
		return true;
	}

	private async stopProjectByPath(projectPath: string): Promise<boolean> {
		const project = this.projects.find(candidate => normalizePath(candidate.root.fsPath) === normalizePath(projectPath));
		if (!project || !this.activeMode(project)) {
			return false;
		}
		await this.stopProject(project);
		return true;
	}

	private async startProject(project: IJavaProject, mode: ActiveApplicationMode, programArgs: string): Promise<void> {
		if (!vscode.workspace.isTrusted) {
			void vscode.window.showWarningMessage('Trust this workspace before running the Java project.');
			return;
		}
		if (project.enterprise) {
			await vscode.commands.executeCommand('orbyte.enterprise.runProject', project.root, mode === 'debug');
			return;
		}
		const sdk = await resolveProjectJdkEnvironment(project.root, project.root.fsPath);
		if (!sdk) {
			const action = await vscode.window.showWarningMessage(`No compatible local JDK was found for ${project.name}.`, 'Select JDK');
			if (action) {
				await vscode.commands.executeCommand('orbyte.java.configureJdk', project.root);
			}
			return;
		}
		if (project.mainClass && !(mode === 'run' && project.springBoot && (project.buildTool === 'maven' || project.buildTool === 'gradle'))) {
			await this.startJava(project, mode === 'run', programArgs, sdk);
			return;
		}
		const command = frameworkRunCommand(project, mode === 'debug');
		if (!command) {
			void vscode.window.showErrorMessage(`Orbyte detected ${frameworkLabel(project.framework)} in ${project.name}, but could not find a main class or a supported development command.`);
			return;
		}
		if (programArgs && project.springBoot) {
			command.args.push(project.buildTool === 'maven' ? `-Dspring-boot.run.arguments=${programArgs}` : `--args=${programArgs}`);
		}
		const execution = await vscode.tasks.executeTask(this.createRunTask(project, command, sdk));
		this.trackTask(execution);
	}

	private async stop(uri?: vscode.Uri): Promise<void> {
		const project = await this.pickActiveProject(uri ?? vscode.window.activeTextEditor?.document.uri, 'stop');
		if (!project) {
			void vscode.window.showInformationMessage('No Orbyte Java application is currently running.');
			return;
		}
		await this.stopProject(project);
	}

	private async restart(uri?: vscode.Uri): Promise<void> {
		const project = await this.pickActiveProject(uri ?? vscode.window.activeTextEditor?.document.uri, 'restart');
		if (!project) {
			void vscode.window.showInformationMessage('No Orbyte Java application is currently running.');
			return;
		}
		await this.restartProject(project);
	}

	private async hotReload(uri?: vscode.Uri): Promise<boolean> {
		const project = this.projectForUri(uri ?? vscode.window.activeTextEditor?.document.uri);
		if (!project) {
			return false;
		}
		const mode = this.activeMode(project);
		if (!mode) {
			return false;
		}
		if (!project.springBoot || !project.springDevtools) {
			await this.restartProject(project);
			return true;
		}
		const command = incrementalCommandFor(project);
		const task = new vscode.Task(
			{ type: 'orbyte-java', action: 'hotReload', project: project.root.fsPath },
			project.folder,
			`Hot Reload ${project.name}`,
			'Orbyte Hot Reload',
			new vscode.ShellExecution(command.executable, command.args, { cwd: project.root.fsPath, env: await resolveProjectJdkEnvironment(project.root, project.root.fsPath) }),
			[],
		);
		task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Dedicated, clear: false };
		const execution = await vscode.tasks.executeTask(task);
		const exitCode = await waitForTaskProcess(execution);
		if (exitCode !== 0) {
			void vscode.window.showWarningMessage(`Hot reload build failed for ${project.name}. Open the task terminal for details.`);
		}
		return true;
	}

	private async restartProject(project: IJavaProject): Promise<void> {
		const mode = this.activeMode(project);
		if (!mode) {
			return;
		}
		await this.stopProject(project);
		await this.execute(mode, project.root);
	}

	private async stopProject(project: IJavaProject): Promise<void> {
		const key = normalizePath(project.root.fsPath);
		const task = this.runningTasks.get(key);
		const debugSession = this.debugSessions.get(key)?.session;
		this.runningTasks.delete(key);
		this.debugSessions.delete(key);
		this.updateApplicationState();
		await Promise.all([
			task ? terminateTask(task) : Promise.resolve(),
			debugSession ? stopDebugSession(debugSession) : Promise.resolve(),
		]);
	}

	private trackTask(execution: vscode.TaskExecution, update = true): void {
		const definition = execution.task.definition as { type?: string; action?: string; project?: string };
		if (definition.type !== 'orbyte-java' || definition.action !== 'run' || typeof definition.project !== 'string') {
			return;
		}
		this.runningTasks.set(normalizePath(definition.project), execution);
		if (update) {
			this.updateApplicationState();
		}
	}

	private untrackTask(execution: vscode.TaskExecution): void {
		const definition = execution.task.definition as { type?: string; action?: string; project?: string };
		if (definition.type !== 'orbyte-java' || definition.action !== 'run' || typeof definition.project !== 'string') {
			return;
		}
		const key = normalizePath(definition.project);
		if (this.runningTasks.get(key) === execution) {
			this.runningTasks.delete(key);
			this.updateApplicationState();
		}
	}

	private trackDebugSession(session: vscode.DebugSession, update = true): void {
		const project = session.configuration.orbyteProject;
		const mode = session.configuration.orbyteMode;
		if (typeof project !== 'string' || (mode !== 'run' && mode !== 'debug')) {
			return;
		}
		this.debugSessions.set(normalizePath(project), { session, mode });
		if (update) {
			this.updateApplicationState();
		}
	}

	private untrackDebugSession(session: vscode.DebugSession): void {
		for (const [project, active] of this.debugSessions) {
			if (active.session.id === session.id) {
				this.debugSessions.delete(project);
				this.updateApplicationState();
				return;
			}
		}
	}

	private activeMode(project: IJavaProject): ActiveApplicationMode | undefined {
		const key = normalizePath(project.root.fsPath);
		return this.debugSessions.get(key)?.mode ?? (this.runningTasks.has(key) ? 'run' : undefined);
	}

	private updateApplicationState(): void {
		const running = this.runningTasks.size > 0 || this.debugSessions.size > 0;
		const debugging = Array.from(this.debugSessions.values()).some(active => active.mode === 'debug');
		void vscode.commands.executeCommand('setContext', 'orbyte.spring.applicationRunning', running);
		void vscode.commands.executeCommand('setContext', 'orbyte.spring.applicationDebugging', debugging);
		this.codeLensChangedEmitter.fire();
		this.updateStatusBar();
	}

	private async startJava(project: IJavaProject, noDebug: boolean, programArgs: string, jdkEnvironment: Record<string, string>): Promise<void> {
		if (!project.mainClass) {
			void vscode.window.showErrorMessage(`Orbyte could not find a main class under ${project.name}/src/main.`);
			return;
		}
		const debuggerExtension = vscode.extensions.getExtension('vscjava.vscode-java-debug');
		const languageExtension = vscode.extensions.getExtension('redhat.java');
		if (!debuggerExtension || !languageExtension) {
			const action = await vscode.window.showErrorMessage('Java language support or the Java debugger is missing from this Orbyte installation.', 'Show Java Extensions');
			if (action) {
				await vscode.commands.executeCommand('workbench.extensions.search', '@id:redhat.java @id:vscjava.vscode-java-debug');
			}
			return;
		}
		try {
			await Promise.all([languageExtension.activate(), debuggerExtension.activate()]);
		} catch (error) {
			const action = await vscode.window.showErrorMessage(`Java tooling could not start: ${error instanceof Error ? error.message : String(error)}`, 'Environment Setup');
			if (action) {
				await vscode.commands.executeCommand('orbyte.java.configureJdk', project.root);
			}
			return;
		}
		const started = await vscode.debug.startDebugging(project.folder, this.debugConfiguration(project, noDebug, programArgs, jdkEnvironment));
		if (!started) {
			void vscode.window.showErrorMessage(`Could not ${noDebug ? 'run' : 'debug'} ${project.mainClass}. Check the Java runtime configured for this workspace.`);
		}
	}

	private debugConfiguration(project: IJavaProject, noDebug: boolean, programArgs = '', jdkEnvironment = configuredJdkEnvironment(project.root)): vscode.DebugConfiguration {
		return {
			type: 'java',
			request: 'launch',
			name: `${noDebug ? 'Run' : 'Debug'} ${project.name} (${frameworkLabel(project.framework)})`,
			mainClass: project.mainClass,
			cwd: project.root.fsPath,
			console: 'integratedTerminal',
			noDebug,
			env: jdkEnvironment,
			javaExec: jdkEnvironment && path.join(jdkEnvironment.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
			args: programArgs,
			orbyteProject: project.root.fsPath,
			orbyteMode: noDebug ? 'run' : 'debug',
		};
	}

	private createRunTask(project: IJavaProject, command: { executable: string; args: string[] }, jdkEnvironment: Record<string, string>): vscode.Task {
		const task = new vscode.Task(
			{ type: 'orbyte-java', action: 'run', project: project.root.fsPath },
			project.folder,
			`Run ${project.name} (${frameworkLabel(project.framework)})`,
			'Orbyte Applications',
			new vscode.ShellExecution(command.executable, command.args, { cwd: project.root.fsPath, env: jdkEnvironment }),
			[],
		);
		task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
		return task;
	}

	private createTask(project: IJavaProject, action: Exclude<ProjectAction, 'debug'>, jdkEnvironment = configuredJdkEnvironment(project.root)): vscode.Task {
		const command = commandFor(project, action);
		const task = new vscode.Task(
			{ type: 'orbyte-java', action, project: project.root.fsPath },
			project.folder,
			`${actionLabel(action)} ${project.name}`,
			'Orbyte Java',
			new vscode.ShellExecution(command.executable, command.args, { cwd: project.root.fsPath, env: jdkEnvironment }),
			[],
		);
		if (action === 'build') {
			task.group = vscode.TaskGroup.Build;
		} else if (action === 'test') {
			task.group = vscode.TaskGroup.Test;
		}
		task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
		return task;
	}

	private projectForUri(uri: vscode.Uri | undefined): IJavaProject | undefined {
		if (!uri || uri.scheme !== 'file') {
			return undefined;
		}
		return this.projects
			.filter(project => isWithin(uri.fsPath, project.root.fsPath))
			.sort((left, right) => right.root.fsPath.length - left.root.fsPath.length)[0];
	}

	private async pickProject(uri?: vscode.Uri): Promise<IJavaProject | undefined> {
		const contextual = this.projectForUri(uri);
		if (contextual) {
			return contextual;
		}
		if (this.projects.length <= 1) {
			return this.projects[0];
		}
		const selection = await vscode.window.showQuickPick(this.projects.map(project => ({
			label: project.name,
			description: `${frameworkLabel(project.framework)} · ${buildToolLabel(project.buildTool)}`,
			detail: vscode.workspace.asRelativePath(project.root, false),
			project,
		})), { title: 'Select the project to run' });
		return selection?.project;
	}

	private async pickActiveProject(uri: vscode.Uri | undefined, action: 'stop' | 'restart'): Promise<IJavaProject | undefined> {
		const contextual = this.projectForUri(uri);
		if (contextual && this.activeMode(contextual)) {
			return contextual;
		}
		const activeProjects = this.projects.filter(project => this.activeMode(project));
		if (activeProjects.length <= 1) {
			return activeProjects[0];
		}
		const selection = await vscode.window.showQuickPick(activeProjects.map(project => ({
			label: project.name,
			description: `${this.activeMode(project) === 'debug' ? 'Debugging' : 'Running'} · ${buildToolLabel(project.buildTool)}`,
			detail: vscode.workspace.asRelativePath(project.root, false),
			project,
		})), { title: `Select the application to ${action}` });
		return selection?.project;
	}
}

function terminateTask(execution: vscode.TaskExecution): Promise<void> {
	return new Promise(resolve => {
		let completed = false;
		const finish = () => {
			if (completed) {
				return;
			}
			completed = true;
			clearTimeout(timeout);
			disposable.dispose();
			resolve();
		};
		const disposable = vscode.tasks.onDidEndTask(event => {
			if (event.execution === execution) {
				finish();
			}
		});
		const timeout = setTimeout(finish, 5000);
		execution.terminate();
	});
}

function stopDebugSession(session: vscode.DebugSession): Promise<void> {
	return new Promise(resolve => {
		let completed = false;
		const finish = () => {
			if (completed) {
				return;
			}
			completed = true;
			clearTimeout(timeout);
			disposable.dispose();
			resolve();
		};
		const disposable = vscode.debug.onDidTerminateDebugSession(terminated => {
			if (terminated.id === session.id) {
				finish();
			}
		});
		const timeout = setTimeout(finish, 5000);
		void vscode.debug.stopDebugging(session).then(finish, finish);
	});
}

async function discoverProjects(): Promise<readonly IJavaProject[]> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const candidates: IProjectCandidate[] = [];
	for (const folder of folders) {
		const buildFiles = await Promise.all([
			findInFolder(folder, '**/pom.xml'),
			findInFolder(folder, '**/build.gradle'),
			findInFolder(folder, '**/build.gradle.kts'),
			findInFolder(folder, '**/build.xml'),
		]);
		const seen = new Map<string, IProjectCandidate>();
		for (const [index, files] of buildFiles.entries()) {
			const buildTool: BuildTool = index === 0 ? 'maven' : index < 3 ? 'gradle' : 'ant';
			for (const buildFile of files) {
				const root = vscode.Uri.file(path.dirname(buildFile.fsPath));
				const key = normalizePath(root.fsPath);
				const previous = seen.get(key);
				if (!previous || buildToolPriority(buildTool) < buildToolPriority(previous.buildTool)) {
					seen.set(key, { folder, root, buildTool, buildFile });
				}
			}
		}
		if (!seen.size) {
			seen.set(normalizePath(folder.uri.fsPath), { folder, root: folder.uri, buildTool: 'java' });
		}
		candidates.push(...seen.values());
	}

	const projects = (await Promise.all(candidates.map(candidate => inspectProject(candidate)))).filter((project): project is IJavaProject => Boolean(project));
	return projects.sort((left, right) => left.root.fsPath.localeCompare(right.root.fsPath));
}

async function inspectProject(candidate: IProjectCandidate): Promise<IJavaProject | undefined> {
	const buildText = candidate.buildFile ? await readText(candidate.buildFile.fsPath) : '';
	const sourceFiles = await vscode.workspace.findFiles(
		new vscode.RelativePattern(candidate.root, 'src/main/**/*.{java,kt,groovy}'),
		PROJECT_EXCLUDE,
		500,
	);
	let mainClass: string | undefined;
	let mainUri: vscode.Uri | undefined;
	let framework = detectFramework(buildText);
	const enterprisePackage = /<packaging>\s*(?:ear|ejb)\s*<\/packaging>|<ejbjar\b|\b(?:id|apply\s+plugin:)\s*\(?\s*['"]ear['"]/i.test(buildText);
	const warPackage = /<packaging>\s*war\s*<\/packaging>|<war\b|\b(?:id|apply\s+plugin:)\s*\(?\s*['"]war['"]/i.test(buildText);
	let enterprise = enterprisePackage || framework === 'jakarta-ee' || warPackage;
	for (const sourceFile of sourceFiles) {
		const text = await readText(sourceFile.fsPath);
		const isMain = JAVA_MAIN_PATTERN.test(text) || KOTLIN_MAIN_PATTERN.test(text);
		const sourceFramework = detectFramework(text);
		if (framework === 'java' && sourceFramework !== 'java') {
			framework = sourceFramework;
		}
		enterprise ||= /@(Stateless|Stateful|Singleton|MessageDriven|WebServlet|ApplicationPath)\b|\b(?:jakarta|javax)\.(?:ejb|servlet|ws\.rs)\b/.test(text);
		if (!mainClass && isMain) {
			mainClass = qualifiedMainClass(text, sourceFile);
			mainUri = sourceFile;
		}
		if (isMain && SPRING_MAIN_PATTERN.test(text)) {
			mainClass = qualifiedMainClass(text, sourceFile);
			mainUri = sourceFile;
			framework = 'spring-boot';
			break;
		}
	}
	if (!sourceFiles.length && candidate.buildTool === 'java') {
		return undefined;
	}
	const antTargets = candidate.buildTool === 'ant' ? parseAntTargets(buildText) : new Set<string>();
	return {
		...candidate,
		name: await projectName(candidate, buildText),
		framework,
		enterprise: enterprise && (framework !== 'spring-boot' || enterprisePackage),
		serverDeployable: enterprise || warPackage,
		springBoot: framework === 'spring-boot',
		springDevtools: /spring-boot-devtools/.test(buildText),
		mainClass,
		mainUri,
		antTargets,
	};
}

function detectFramework(text: string): JavaFramework {
	if (/spring-boot|org\.springframework\.boot|@SpringBootApplication\b|SpringApplication\.run\s*\(|runApplication\s*</i.test(text)) {
		return 'spring-boot';
	}
	if (/io\.quarkus|quarkus-(?:maven-plugin|gradle-plugin)|@QuarkusMain\b/i.test(text)) {
		return 'quarkus';
	}
	if (/io\.micronaut|micronaut-(?:runtime|application|gradle-plugin)|Micronaut\.run\s*\(/i.test(text)) {
		return 'micronaut';
	}
	if (/io\.helidon|helidon-(?:microprofile|webserver)/i.test(text)) {
		return 'helidon';
	}
	if (/io\.vertx|vertx-(?:core|web)/i.test(text)) {
		return 'vertx';
	}
	if (/jakarta\.platform|jakarta\.jakartaee|javax\.javaee|\b(?:jakarta|javax)\.(?:ejb|servlet|ws\.rs)\b|@(Stateless|Stateful|Singleton|MessageDriven)\b/i.test(text)) {
		return 'jakarta-ee';
	}
	return 'java';
}

async function projectName(candidate: IProjectCandidate, buildText: string): Promise<string> {
	if (candidate.buildTool === 'maven') {
		const projectName = /<name>\s*([^<]+?)\s*<\/name>/.exec(buildText)?.[1];
		if (projectName) {
			return projectName;
		}
		const projectBody = buildText.replace(/<parent>[\s\S]*?<\/parent>/, '');
		const artifact = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(projectBody)?.[1];
		if (artifact) {
			return artifact;
		}
	}
	if (candidate.buildTool === 'gradle') {
		for (const settingsName of ['settings.gradle.kts', 'settings.gradle']) {
			const settings = await readText(path.join(candidate.root.fsPath, settingsName));
			const rootName = /rootProject\.name\s*=\s*['"]([^'"]+)['"]/.exec(settings)?.[1];
			if (rootName) {
				return rootName;
			}
		}
	}
	if (candidate.buildTool === 'ant') {
		const antName = /<project\b[^>]*\bname\s*=\s*['"]([^'"]+)['"]/.exec(buildText)?.[1];
		if (antName) {
			return antName;
		}
	}
	return path.basename(candidate.root.fsPath) || candidate.folder.name;
}

function qualifiedMainClass(text: string, uri: vscode.Uri): string {
	const packageName = /\bpackage\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*;?/.exec(text)?.[1];
	const className = uri.path.endsWith('.kt')
		? `${path.basename(uri.fsPath, '.kt')}Kt`
		: /\b(?:public\s+)?(?:final\s+)?(?:class|object)\s+([A-Za-z_]\w*)/.exec(text)?.[1]
			?? path.basename(uri.fsPath, path.extname(uri.fsPath));
	return packageName ? `${packageName}.${className}` : className;
}

function commandFor(project: IJavaProject, action: Exclude<ProjectAction, 'debug'>): { executable: string; args: string[] } {
	if (project.buildTool === 'maven') {
		const goal = action === 'run' ? mavenRunGoal(project) : action === 'build' ? 'package' : 'test';
		const args = action === 'run' && project.framework === 'java' && project.mainClass
			? [goal, `-Dexec.mainClass=${project.mainClass}`]
			: [goal];
		return javaBuildCommand(project.root, 'maven', args);
	}
	if (project.buildTool === 'gradle') {
		const goal = action === 'run' ? gradleRunGoal(project) : action === 'build' ? 'build' : 'test';
		return javaBuildCommand(project.root, 'gradle', [goal]);
	}
	if (project.buildTool === 'ant') {
		const preferred = action === 'run' ? ['bootRun', 'run', 'start'] : action === 'build' ? ['build', 'package', 'jar', 'compile'] : ['test'];
		const target = preferred.find(item => project.antTargets.has(item));
		return { executable: process.platform === 'win32' ? 'ant.bat' : 'ant', args: target ? [target] : [] };
	}
	return { executable: process.platform === 'win32' ? 'java.exe' : 'java', args: project.mainClass ? [project.mainClass] : [] };
}

function frameworkRunCommand(project: IJavaProject, debug: boolean): { executable: string; args: string[] } | undefined {
	if (project.enterprise) {
		return undefined;
	}
	const command = commandFor(project, 'run');
	if (!debug) {
		return command;
	}
	if (project.framework === 'quarkus') {
		return { ...command, args: [...command.args, '-Dsuspend'] };
	}
	if (project.buildTool === 'gradle' && project.framework === 'micronaut') {
		return { ...command, args: [...command.args, '--debug-jvm'] };
	}
	return command;
}

function mavenRunGoal(project: IJavaProject): string {
	if (project.framework === 'spring-boot') {
		return 'spring-boot:run';
	}
	if (project.framework === 'quarkus') {
		return 'quarkus:dev';
	}
	if (project.framework === 'micronaut') {
		return 'mn:run';
	}
	return project.mainClass ? 'org.codehaus.mojo:exec-maven-plugin:3.5.0:java' : 'package';
}

function gradleRunGoal(project: IJavaProject): string {
	return project.framework === 'spring-boot' ? 'bootRun'
		: project.framework === 'quarkus' ? 'quarkusDev'
			: 'run';
}

function incrementalCommandFor(project: IJavaProject): { executable: string; args: string[] } {
	if (project.buildTool === 'maven') {
		return javaBuildCommand(project.root, 'maven', ['-DskipTests', 'compile']);
	}
	if (project.buildTool === 'gradle') {
		return javaBuildCommand(project.root, 'gradle', ['classes']);
	}
	if (project.buildTool === 'ant') {
		return { executable: process.platform === 'win32' ? 'ant.bat' : 'ant', args: project.antTargets.has('compile') ? ['compile'] : [] };
	}
	return { executable: process.platform === 'win32' ? 'java.exe' : 'java', args: [] };
}

function waitForTaskProcess(execution: vscode.TaskExecution): Promise<number | undefined> {
	return new Promise(resolve => {
		const disposable = vscode.tasks.onDidEndTaskProcess(event => {
			if (event.execution === execution) {
				disposable.dispose();
				resolve(event.exitCode);
			}
		});
	});
}

function parseAntTargets(text: string): ReadonlySet<string> {
	return new Set(Array.from(text.matchAll(/<target\b[^>]*\bname\s*=\s*['"]([^'"]+)['"]/g), match => match[1]));
}

function findInFolder(folder: vscode.WorkspaceFolder, pattern: string): Thenable<vscode.Uri[]> {
	return vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), PROJECT_EXCLUDE, 100);
}

async function readText(filePath: string): Promise<string> {
	try {
		const content = await fs.readFile(filePath);
		return content.subarray(0, 1024 * 1024).toString('utf8');
	} catch {
		return '';
	}
}

function isWithin(candidate: string, parent: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizePath(value: string): string {
	return process.platform === 'win32' ? value.toLowerCase() : value;
}

function buildToolPriority(tool: BuildTool): number {
	return tool === 'maven' ? 0 : tool === 'gradle' ? 1 : tool === 'ant' ? 2 : 3;
}

function buildToolLabel(tool: BuildTool): string {
	return tool === 'maven' ? 'Maven' : tool === 'gradle' ? 'Gradle' : tool === 'ant' ? 'Ant' : 'Java';
}

function frameworkLabel(framework: JavaFramework): string {
	return framework === 'spring-boot' ? 'Spring Boot'
		: framework === 'quarkus' ? 'Quarkus'
			: framework === 'micronaut' ? 'Micronaut'
				: framework === 'helidon' ? 'Helidon'
					: framework === 'vertx' ? 'Vert.x'
						: framework === 'jakarta-ee' ? 'Jakarta EE / EJB'
							: 'Java';
}

function actionLabel(action: Exclude<ProjectAction, 'debug'>): string {
	return action === 'run' ? 'Run' : action === 'build' ? 'Build' : 'Test';
}

function runDescription(project: IJavaProject): string {
	if (project.enterprise) {
		return 'Build and deploy to configured application server';
	}
	if (project.mainClass) {
		return `${frameworkLabel(project.framework)} · ${project.mainClass}`;
	}
	return project.buildTool === 'maven' ? `mvnw ${mavenRunGoal(project)}`
		: project.buildTool === 'gradle' ? `gradlew ${gradleRunGoal(project)}`
			: project.buildTool === 'ant' ? 'Ant run target'
				: project.mainClass ?? 'Java main class';
}
