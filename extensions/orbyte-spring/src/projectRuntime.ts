/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbyte. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

type BuildTool = 'maven' | 'gradle' | 'ant' | 'java';
type ProjectAction = 'run' | 'debug' | 'build' | 'test';

interface IJavaProject {
	readonly folder: vscode.WorkspaceFolder;
	readonly root: vscode.Uri;
	readonly name: string;
	readonly buildTool: BuildTool;
	readonly springBoot: boolean;
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
			vscode.commands.registerCommand('orbyte.spring.build', (uri?: vscode.Uri) => this.execute('build', uri)),
			vscode.commands.registerCommand('orbyte.spring.test', (uri?: vscode.Uri) => this.execute('test', uri)),
			vscode.commands.registerCommand('orbyte.spring.refreshProjects', () => this.refresh(true)),
			vscode.commands.registerCommand('orbyte.spring.showProjectActions', () => this.showProjectActions()),
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
		await this.refresh(false);
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
		if (!(JAVA_MAIN_PATTERN.test(text) || KOTLIN_MAIN_PATTERN.test(text)) || !SPRING_MAIN_PATTERN.test(text)) {
			return [];
		}
		const mainMatch = /\b(?:static\s+void|fun)\s+main\s*\(/.exec(text);
		const annotationMatch = /@SpringBootApplication\b/.exec(text);
		const offset = annotationMatch?.index ?? mainMatch?.index ?? 0;
		const range = new vscode.Range(document.positionAt(offset), document.positionAt(offset));
		return [
			new vscode.CodeLens(range, {
				title: '$(run) Run Spring Boot',
				command: 'orbyte.spring.run',
				arguments: [document.uri],
			}),
			new vscode.CodeLens(range, {
				title: '$(debug-alt) Debug Spring Boot',
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
			const springProjects = this.projects.filter(project => project.springBoot).length;
			void vscode.window.showInformationMessage(
				this.projects.length
					? `Orbyte detected ${this.projects.length} Java project${this.projects.length === 1 ? '' : 's'} (${springProjects} Spring Boot).`
					: 'No Maven, Gradle, Ant, or Java application project was detected in this workspace.',
			);
		}
	}

	private updateStatusBar(): void {
		const project = this.projectForUri(vscode.window.activeTextEditor?.document.uri) ?? this.projects[0];
		const enabled = vscode.workspace.getConfiguration('orbyte.java').get('showStatusBar', true);
		if (!project || !enabled) {
			this.statusBar.hide();
			return;
		}
		const framework = project.springBoot ? 'Spring Boot' : 'Java';
		this.statusBar.text = `$(run-all) ${framework} · ${buildToolLabel(project.buildTool)}`;
		this.statusBar.tooltip = `${project.name}\nRun, debug, build, or test this project`;
		this.statusBar.show();
	}

	private async showProjectActions(): Promise<void> {
		const project = await this.pickProject(vscode.window.activeTextEditor?.document.uri);
		if (!project) {
			return;
		}
		const choice = await vscode.window.showQuickPick([
			{ label: '$(run) Run', description: runDescription(project), action: 'run' as const },
			{ label: '$(debug-alt) Debug', description: project.mainClass ?? 'Detect main class', action: 'debug' as const },
			{ label: '$(tools) Build', description: buildToolLabel(project.buildTool), action: 'build' as const },
			{ label: '$(beaker) Test', description: buildToolLabel(project.buildTool), action: 'test' as const },
		], { title: `${project.name} · ${project.springBoot ? 'Spring Boot' : 'Java'} · ${buildToolLabel(project.buildTool)}` });
		if (choice) {
			await this.execute(choice.action, project.root);
		}
	}

	private async execute(action: ProjectAction, uri?: vscode.Uri): Promise<void> {
		const project = await this.pickProject(uri ?? vscode.window.activeTextEditor?.document.uri);
		if (!project) {
			void vscode.window.showWarningMessage('Open a Maven, Gradle, Ant, or Java application project first.');
			return;
		}
		if (action === 'debug') {
			await this.startJava(project, false);
			return;
		}
		if (action === 'run' && project.buildTool === 'java') {
			await this.startJava(project, true);
			return;
		}
		await vscode.tasks.executeTask(this.createTask(project, action));
	}

	private async startJava(project: IJavaProject, noDebug: boolean): Promise<void> {
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
		await Promise.all([languageExtension.activate(), debuggerExtension.activate()]);
		const started = await vscode.debug.startDebugging(project.folder, this.debugConfiguration(project, noDebug));
		if (!started) {
			void vscode.window.showErrorMessage(`Could not ${noDebug ? 'run' : 'debug'} ${project.mainClass}. Check the Java runtime configured for this workspace.`);
		}
	}

	private debugConfiguration(project: IJavaProject, noDebug: boolean): vscode.DebugConfiguration {
		return {
			type: 'java',
			request: 'launch',
			name: `${noDebug ? 'Run' : 'Debug'} ${project.name}`,
			mainClass: project.mainClass,
			cwd: project.root.fsPath,
			console: 'integratedTerminal',
			noDebug,
		};
	}

	private createTask(project: IJavaProject, action: Exclude<ProjectAction, 'debug'>): vscode.Task {
		const command = commandFor(project, action);
		const task = new vscode.Task(
			{ type: 'orbyte-java', action, project: project.root.fsPath },
			project.folder,
			`${actionLabel(action)} ${project.name}`,
			'Orbyte Java',
			new vscode.ShellExecution(command.executable, command.args, { cwd: project.root.fsPath }),
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
			description: `${project.springBoot ? 'Spring Boot' : 'Java'} · ${buildToolLabel(project.buildTool)}`,
			detail: vscode.workspace.asRelativePath(project.root, false),
			project,
		})), { title: 'Select the project to run' });
		return selection?.project;
	}
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
	let springBoot = /spring-boot|org\.springframework\.boot/.test(buildText);
	for (const sourceFile of sourceFiles) {
		const text = await readText(sourceFile.fsPath);
		const isMain = JAVA_MAIN_PATTERN.test(text) || KOTLIN_MAIN_PATTERN.test(text);
		if (!springBoot && SPRING_MAIN_PATTERN.test(text)) {
			springBoot = true;
		}
		if (!mainClass && isMain) {
			mainClass = qualifiedMainClass(text, sourceFile);
			mainUri = sourceFile;
		}
		if (isMain && SPRING_MAIN_PATTERN.test(text)) {
			mainClass = qualifiedMainClass(text, sourceFile);
			mainUri = sourceFile;
			springBoot = true;
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
		springBoot,
		mainClass,
		mainUri,
		antTargets,
	};
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
		const wrapper = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
		const wrapperPath = path.join(project.root.fsPath, wrapper);
		const goal = action === 'run' ? 'spring-boot:run' : action === 'build' ? 'package' : 'test';
		if (fileExists(wrapperPath)) {
			return process.platform === 'win32'
				? { executable: wrapperPath, args: [goal] }
				: { executable: '/bin/sh', args: [wrapperPath, goal] };
		}
		return { executable: process.platform === 'win32' ? 'mvn.cmd' : 'mvn', args: [goal] };
	}
	if (project.buildTool === 'gradle') {
		const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
		const wrapperPath = path.join(project.root.fsPath, wrapper);
		const goal = action === 'run' ? 'bootRun' : action === 'build' ? 'build' : 'test';
		if (fileExists(wrapperPath)) {
			return process.platform === 'win32'
				? { executable: wrapperPath, args: [goal] }
				: { executable: '/bin/sh', args: [wrapperPath, goal] };
		}
		return { executable: process.platform === 'win32' ? 'gradle.bat' : 'gradle', args: [goal] };
	}
	if (project.buildTool === 'ant') {
		const preferred = action === 'run' ? ['bootRun', 'run', 'start'] : action === 'build' ? ['build', 'package', 'jar', 'compile'] : ['test'];
		const target = preferred.find(item => project.antTargets.has(item));
		return { executable: process.platform === 'win32' ? 'ant.bat' : 'ant', args: target ? [target] : [] };
	}
	return { executable: process.platform === 'win32' ? 'java.exe' : 'java', args: project.mainClass ? [project.mainClass] : [] };
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

function fileExists(filePath: string): boolean {
	return existsSync(filePath);
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

function actionLabel(action: Exclude<ProjectAction, 'debug'>): string {
	return action === 'run' ? 'Run' : action === 'build' ? 'Build' : 'Test';
}

function runDescription(project: IJavaProject): string {
	return project.buildTool === 'maven' ? 'mvnw spring-boot:run'
		: project.buildTool === 'gradle' ? 'gradlew bootRun'
			: project.buildTool === 'ant' ? 'Ant run target'
				: project.mainClass ?? 'Java main class';
}
