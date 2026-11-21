/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbyte. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, promises as fs } from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';

type ServerKind = 'wildfly' | 'websphere';
type EnterpriseBuildTool = 'maven' | 'gradle' | 'ant';
type EnterprisePackaging = 'ear' | 'war' | 'ejb' | 'jar';

interface IEnterpriseServer {
	readonly kind: ServerKind;
	readonly label: string;
	readonly home?: string;
	readonly serverName?: string;
	readonly debugPort: number;
}

interface IEnterpriseProject {
	readonly folder: vscode.WorkspaceFolder;
	readonly root: vscode.Uri;
	readonly name: string;
	readonly buildTool: EnterpriseBuildTool;
	readonly packaging: EnterprisePackaging;
}

type ServerAction = 'start' | 'debug' | 'attach' | 'stop' | 'deploy';

interface IServerTreeNode {
	readonly type: 'server' | 'action' | 'configure';
	readonly server?: IEnterpriseServer;
	readonly action?: ServerAction;
}

const SEARCH_EXCLUDE = '**/{.git,.idea,.gradle,node_modules,target,build,out}/**';

export function registerEnterpriseRuntime(context: vscode.ExtensionContext): void {
	const runtime = new EnterpriseRuntime();
	context.subscriptions.push(runtime);
}

class EnterpriseRuntime implements vscode.Disposable, vscode.TreeDataProvider<IServerTreeNode>, vscode.CodeLensProvider {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly treeChangedEmitter = new vscode.EventEmitter<IServerTreeNode | undefined>();
	readonly onDidChangeTreeData = this.treeChangedEmitter.event;

	constructor() {
		this.disposables.push(
			this.treeChangedEmitter,
			vscode.window.registerTreeDataProvider('orbyteApplicationServers', this),
			vscode.languages.registerCodeLensProvider([
				{ language: 'java', scheme: 'file' },
				{ language: 'kotlin', scheme: 'file' },
			], this),
			vscode.commands.registerCommand('orbyte.enterprise.configureServer', () => this.configureServer()),
			vscode.commands.registerCommand('orbyte.enterprise.refreshServers', () => this.treeChangedEmitter.fire(undefined)),
			vscode.commands.registerCommand('orbyte.enterprise.startServer', (value?: unknown) => this.runServerAction('start', value)),
			vscode.commands.registerCommand('orbyte.enterprise.stopServer', (value?: unknown) => this.runServerAction('stop', value)),
			vscode.commands.registerCommand('orbyte.enterprise.debugServer', (value?: unknown) => this.runServerAction('debug', value)),
			vscode.commands.registerCommand('orbyte.enterprise.attachDebugger', (value?: unknown) => this.runServerAction('attach', value)),
			vscode.commands.registerCommand('orbyte.enterprise.deploy', (first?: unknown, second?: vscode.Uri) => this.deployCommand(first, second)),
			vscode.commands.registerCommand('orbyte.enterprise.hotReload', (resource?: vscode.Uri) => this.hotReload(resource)),
			vscode.commands.registerCommand('orbyte.enterprise.selectProjectServer', (resource?: vscode.Uri) => this.selectProjectServer(resource, true)),
			vscode.commands.registerCommand('orbyte.enterprise.runProject', (resource?: vscode.Uri, debug = false) => this.runProject(resource, debug)),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('orbyte.enterprise')) {
					this.treeChangedEmitter.fire(undefined);
				}
			}),
		);
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const text = document.getText();
		const enterpriseType = /@(Stateless|Stateful|Singleton|MessageDriven)\b|\bjakarta\.ejb\b|\bjavax\.ejb\b/.exec(text);
		if (!enterpriseType) {
			return [];
		}
		const position = document.positionAt(enterpriseType.index);
		return [new vscode.CodeLens(new vscode.Range(position, position), {
			title: '$(server-environment) Build & Deploy EJB',
			command: 'orbyte.enterprise.deploy',
			arguments: [document.uri],
		})];
	}

	getTreeItem(element: IServerTreeNode): vscode.TreeItem {
		if (element.type === 'configure') {
			const item = new vscode.TreeItem('Add Application Server…', vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon('add');
			item.command = { command: 'orbyte.enterprise.configureServer', title: 'Add Application Server' };
			return item;
		}
		const server = element.server!;
		if (element.type === 'server') {
			const item = new vscode.TreeItem(server.label, server.home ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon('server-environment');
			item.description = server.home ? serverDescription(server) : 'Not configured';
			item.tooltip = server.home ?? `Configure ${server.label}`;
			item.contextValue = server.home ? `orbyteServer.${server.kind}` : 'orbyteServer.unconfigured';
			if (!server.home) {
				item.command = { command: 'orbyte.enterprise.configureServer', title: 'Configure Server' };
			}
			return item;
		}
		const action = element.action!;
		const item = new vscode.TreeItem(actionLabel(action, server.kind), vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon(actionIcon(action));
		item.command = {
			command: action === 'start' ? 'orbyte.enterprise.startServer'
				: action === 'stop' ? 'orbyte.enterprise.stopServer'
					: action === 'debug' ? 'orbyte.enterprise.debugServer'
						: action === 'attach' ? 'orbyte.enterprise.attachDebugger'
							: 'orbyte.enterprise.deploy',
			title: actionLabel(action, server.kind),
			arguments: [server.kind],
		};
		return item;
	}

	getChildren(element?: IServerTreeNode): IServerTreeNode[] {
		if (!element) {
			return [...configuredServers().map(server => ({ type: 'server' as const, server })), { type: 'configure' }];
		}
		if (element.type !== 'server' || !element.server?.home) {
			return [];
		}
		const actions: ServerAction[] = element.server.kind === 'wildfly'
			? ['start', 'debug', 'attach', 'stop', 'deploy']
			: ['start', 'attach', 'stop', 'deploy'];
		return actions.map(action => ({ type: 'action', server: element.server, action }));
	}

	private async configureServer(): Promise<void> {
		const selection = await vscode.window.showQuickPick([
			{ label: 'JBoss EAP / WildFly', description: 'Standalone server or JBoss EAP installation', serverKind: 'wildfly' as const },
			{ label: 'IBM WebSphere Application Server', description: 'Traditional WebSphere profile', serverKind: 'websphere' as const },
		], { title: 'Add Application Server' });
		if (!selection) {
			return;
		}
		const selected = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: selection.serverKind === 'wildfly' ? 'Select JBoss/WildFly Home' : 'Select WebSphere Profile',
			title: selection.serverKind === 'wildfly'
				? 'Choose the directory containing bin/standalone'
				: 'Choose the profile directory containing bin/startServer and bin/wsadmin',
		});
		if (!selected?.[0]) {
			return;
		}
		const target = workspaceConfigurationTarget();
		const configuration = vscode.workspace.getConfiguration('orbyte.enterprise');
		if (selection.serverKind === 'wildfly') {
			const home = selected[0].fsPath;
			if (!serverExecutable(home, 'bin', scriptName('standalone'))) {
				void vscode.window.showErrorMessage('This is not a JBoss/WildFly home directory: bin/standalone was not found.');
				return;
			}
			const port = await promptPort('WildFly debug port', 8787);
			if (!port) {
				return;
			}
			await configuration.update('wildfly.home', home, target);
			await configuration.update('wildfly.debugPort', port, target);
		} else {
			const profile = await resolveWebSphereProfile(selected[0].fsPath);
			if (!profile) {
				void vscode.window.showErrorMessage('No WebSphere profile containing bin/startServer and bin/wsadmin was found.');
				return;
			}
			const serverName = await vscode.window.showInputBox({
				title: 'WebSphere Server Name',
				value: configuration.get('websphere.serverName', 'server1'),
				validateInput: value => value.trim() ? undefined : 'Enter a WebSphere server name.',
			});
			if (!serverName) {
				return;
			}
			const port = await promptPort('WebSphere debug port', configuration.get('websphere.debugPort', 7777));
			if (!port) {
				return;
			}
			await configuration.update('websphere.profile', profile, target);
			await configuration.update('websphere.serverName', serverName.trim(), target);
			await configuration.update('websphere.debugPort', port, target);
		}
		this.treeChangedEmitter.fire(undefined);
		void vscode.window.showInformationMessage(`${selection.label} added to Orbyte Application Servers.`);
	}

	private async runServerAction(action: Exclude<ServerAction, 'deploy'>, value?: unknown): Promise<void> {
		const server = await this.resolveServer(value);
		if (!server?.home) {
			return;
		}
		if (action === 'attach') {
			await attachDebugger(server);
			return;
		}
		if (action === 'debug' && server.kind === 'wildfly') {
			await vscode.tasks.executeTask(createServerTask(server, 'debug'));
			void vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: `Waiting for ${server.label} debugger on port ${server.debugPort}`,
				cancellable: false,
			}, async () => {
				if (await waitForPort('127.0.0.1', server.debugPort, 45_000)) {
					await attachDebugger(server);
				} else {
					void vscode.window.showErrorMessage(`${server.label} did not open debug port ${server.debugPort}. Check the server terminal.`);
				}
			});
			return;
		}
		await vscode.tasks.executeTask(createServerTask(server, action));
	}

	private async deployCommand(first?: unknown, second?: vscode.Uri): Promise<void> {
		let serverValue = first;
		let resource = second;
		if (isUri(first)) {
			resource = first;
			serverValue = undefined;
		}
		const server = await this.resolveServer(serverValue);
		if (!server?.home) {
			return;
		}
		const project = await pickEnterpriseProject(resource);
		if (!project) {
			void vscode.window.showWarningMessage('No EJB, EAR, WAR, Jakarta EE, or Java EE project was detected in this workspace.');
			return;
		}
		const buildTask = createEnterpriseBuildTask(project);
		const buildExecution = await vscode.tasks.executeTask(buildTask);
		const exitCode = await waitForTask(buildExecution);
		if (exitCode !== 0) {
			void vscode.window.showErrorMessage(`Build failed for ${project.name}; deployment was not started.`);
			return;
		}
		const artifact = await findDeploymentArtifact(project);
		if (!artifact) {
			void vscode.window.showErrorMessage(`Build completed but no ${project.packaging.toUpperCase()} deployment artifact was found.`);
			return;
		}
		await vscode.tasks.executeTask(createDeploymentTask(server, project, artifact));
	}

	private async selectProjectServer(resource?: vscode.Uri, forcePick = false): Promise<ServerKind | undefined> {
		const project = await pickEnterpriseProject(resource);
		if (!project) {
			return undefined;
		}
		const configuration = vscode.workspace.getConfiguration('orbyte.enterprise');
		const selections = configuration.get<Record<string, ServerKind>>('projectServers', {});
		const saved = selections[normalizePath(project.root.fsPath)];
		const servers = configuredServers().filter(server => server.home && isServerInstallationValid(server));
		if (!forcePick && saved && servers.some(server => server.kind === saved)) {
			return saved;
		}
		if (!servers.length) {
			const action = await vscode.window.showWarningMessage('Add JBoss/WildFly or WebSphere before configuring this enterprise application.', 'Add Server');
			if (action) {
				await this.configureServer();
			}
			return undefined;
		}
		const selected = servers.length === 1 && !forcePick
			? servers[0]
			: (await vscode.window.showQuickPick(servers.map(server => ({
				label: server.label,
				description: serverDescription(server),
				detail: server.home,
				server,
			})), { title: `Application server for ${project.name}`, placeHolder: 'Choose where Run and Debug deploy this application' }))?.server;
		if (!selected) {
			return undefined;
		}
		await configuration.update('projectServers', { ...selections, [normalizePath(project.root.fsPath)]: selected.kind }, vscode.ConfigurationTarget.Workspace);
		return selected.kind;
	}

	private async runProject(resource?: vscode.Uri, debug = false): Promise<boolean> {
		const project = await pickEnterpriseProject(resource);
		if (!project) {
			return false;
		}
		const kind = await this.selectProjectServer(project.root, false);
		const server = configuredServers().find(candidate => candidate.kind === kind && candidate.home && isServerInstallationValid(candidate));
		if (!server) {
			return false;
		}
		const ready = await this.ensureServerStarted(server, debug);
		if (!ready) {
			return true;
		}
		const buildExecution = await vscode.tasks.executeTask(createEnterpriseBuildTask(project));
		if (await waitForTask(buildExecution) !== 0) {
			void vscode.window.showErrorMessage(`Build failed for ${project.name}; deployment was not started.`);
			return true;
		}
		const artifact = await findDeploymentArtifact(project);
		if (!artifact) {
			void vscode.window.showErrorMessage(`No ${project.packaging.toUpperCase()} artifact was found after building ${project.name}.`);
			return true;
		}
		const deployment = await vscode.tasks.executeTask(createDeploymentTask(server, project, artifact));
		if (await waitForTask(deployment) !== 0) {
			void vscode.window.showErrorMessage(`Deployment failed for ${project.name} on ${server.label}.`);
			return true;
		}
		if (debug) {
			if (await waitForPort('127.0.0.1', server.debugPort, 10_000)) {
				await attachDebugger(server, project.root.fsPath);
			} else {
				void vscode.window.showWarningMessage(`${project.name} was deployed, but ${server.label} did not expose debug port ${server.debugPort}. Enable server JVM debugging, then use Attach Debugger.`);
			}
		}
		return true;
	}

	private async ensureServerStarted(server: IEnterpriseServer, debug: boolean): Promise<boolean> {
		if (server.kind === 'wildfly') {
			const readinessPort = debug ? server.debugPort : 9990;
			if (await canConnect('127.0.0.1', readinessPort)) {
				return true;
			}
			await vscode.tasks.executeTask(createServerTask(server, debug ? 'debug' : 'start'));
			const ready = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: `Starting ${server.label} for deployment`,
				cancellable: false,
			}, () => waitForPort('127.0.0.1', readinessPort, 60_000));
			if (!ready) {
				void vscode.window.showErrorMessage(`${server.label} did not become ready on port ${readinessPort}. Check the server terminal and port configuration.`);
			}
			return ready;
		}
		const startExecution = await vscode.tasks.executeTask(createServerTask(server, 'start'));
		await waitForTask(startExecution, 120_000);
		// WebSphere returns a non-zero code when the named server is already running;
		// wsadmin below is the authoritative deployment/readiness check.
		return true;
	}

	private async hotReload(resource?: vscode.Uri): Promise<boolean> {
		const servers = configuredServers().filter(server => server.home && isServerInstallationValid(server));
		if (!servers.length) {
			return false;
		}
		const projects = await discoverEnterpriseProjects();
		const project = resource?.scheme === 'file'
			? projects.filter(candidate => isWithin(resource.fsPath, candidate.root.fsPath)).sort((left, right) => right.root.fsPath.length - left.root.fsPath.length)[0]
			: undefined;
		if (!project) {
			return false;
		}
		const projectServer = await this.selectProjectServer(project.root, false);
		const preferred = vscode.workspace.getConfiguration('orbyte.hotReload').get<ServerKind | 'auto'>('enterpriseServer', 'auto');
		const server = servers.find(candidate => candidate.kind === projectServer)
			?? (preferred === 'auto' ? servers[0] : servers.find(candidate => candidate.kind === preferred) ?? servers[0]);
		const buildExecution = await vscode.tasks.executeTask(createEnterpriseBuildTask(project, true));
		if (await waitForTask(buildExecution) !== 0) {
			void vscode.window.showWarningMessage(`Hot reload build failed for ${project.name}. The server still has the previous deployment.`);
			return true;
		}
		const artifact = await findDeploymentArtifact(project);
		if (!artifact) {
			void vscode.window.showWarningMessage(`Hot reload could not find the ${project.packaging.toUpperCase()} artifact for ${project.name}.`);
			return true;
		}
		const deployment = await vscode.tasks.executeTask(createDeploymentTask(server, project, artifact, true));
		if (await waitForTask(deployment) !== 0) {
			void vscode.window.showWarningMessage(`Hot reload deployment failed for ${project.name} on ${server.label}.`);
		}
		return true;
	}

	private async resolveServer(value?: unknown): Promise<IEnterpriseServer | undefined> {
		const kind = serverKindFrom(value);
		const servers = configuredServers().filter(server => server.home);
		let server = kind ? servers.find(candidate => candidate.kind === kind) : undefined;
		if (!server && servers.length === 1) {
			server = servers[0];
		}
		if (!server && servers.length > 1) {
			const selection = await vscode.window.showQuickPick(servers.map(candidate => ({
				label: candidate.label,
				description: serverDescription(candidate),
				server: candidate,
			})), { title: 'Select an Application Server' });
			server = selection?.server;
		}
		if (!server) {
			const configure = await vscode.window.showWarningMessage('Configure a JBoss/WildFly or WebSphere server first.', 'Add Server');
			if (configure) {
				await this.configureServer();
			}
		}
		if (server?.home && !isServerInstallationValid(server)) {
			void vscode.window.showErrorMessage(
				server.kind === 'wildfly'
					? `The configured JBoss/WildFly directory is invalid: ${server.home}`
					: `The configured WebSphere profile is invalid: ${server.home}`,
			);
			return undefined;
		}
		return server;
	}
}

function configuredServers(): IEnterpriseServer[] {
	const configuration = vscode.workspace.getConfiguration('orbyte.enterprise');
	return [
		{
			kind: 'wildfly',
			label: 'JBoss EAP / WildFly',
			home: configuration.get<string>('wildfly.home') || undefined,
			debugPort: configuration.get('wildfly.debugPort', 8787),
		},
		{
			kind: 'websphere',
			label: 'IBM WebSphere',
			home: configuration.get<string>('websphere.profile') || undefined,
			serverName: configuration.get('websphere.serverName', 'server1'),
			debugPort: configuration.get('websphere.debugPort', 7777),
		},
	];
}

async function pickEnterpriseProject(resource?: vscode.Uri): Promise<IEnterpriseProject | undefined> {
	const projects = await discoverEnterpriseProjects();
	const contextual = resource && resource.scheme === 'file'
		? projects.filter(project => isWithin(resource.fsPath, project.root.fsPath)).sort((left, right) => right.root.fsPath.length - left.root.fsPath.length)[0]
		: undefined;
	if (contextual || projects.length <= 1) {
		return contextual ?? projects[0];
	}
	const selected = await vscode.window.showQuickPick(projects.map(project => ({
		label: project.name,
		description: `${project.packaging.toUpperCase()} · ${buildToolLabel(project.buildTool)}`,
		detail: vscode.workspace.asRelativePath(project.root, false),
		project,
	})), { title: 'Select the Enterprise Java project to deploy' });
	return selected?.project;
}

async function discoverEnterpriseProjects(): Promise<IEnterpriseProject[]> {
	const projects: IEnterpriseProject[] = [];
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const definitions = await Promise.all([
			vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/pom.xml'), SEARCH_EXCLUDE, 200),
			vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/build.gradle'), SEARCH_EXCLUDE, 200),
			vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/build.gradle.kts'), SEARCH_EXCLUDE, 200),
			vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/build.xml'), SEARCH_EXCLUDE, 200),
		]);
		for (const [index, files] of definitions.entries()) {
			for (const definition of files) {
				const text = await readText(definition.fsPath);
				const buildTool: EnterpriseBuildTool = index === 0 ? 'maven' : index < 3 ? 'gradle' : 'ant';
				const packaging = enterprisePackaging(text, buildTool);
				if (!packaging) {
					continue;
				}
				const root = vscode.Uri.file(path.dirname(definition.fsPath));
				projects.push({
					folder,
					root,
					name: enterpriseProjectName(text, root, buildTool),
					buildTool,
					packaging,
				});
			}
		}
	}
	return projects;
}

function enterprisePackaging(text: string, buildTool: EnterpriseBuildTool): EnterprisePackaging | undefined {
	if (buildTool === 'maven') {
		const explicit = /<packaging>\s*(ear|war|ejb|jar)\s*<\/packaging>/i.exec(text)?.[1]?.toLowerCase() as EnterprisePackaging | undefined;
		if (/<packaging>\s*pom\s*<\/packaging>/i.test(text)) {
			return undefined;
		}
		if (explicit && explicit !== 'jar') {
			return explicit;
		}
		if (/jakarta\.ejb|javax\.ejb|jakarta\.platform|javaee-api|maven-ejb-plugin/i.test(text)) {
			return explicit ?? 'ejb';
		}
		return undefined;
	}
	if (buildTool === 'gradle') {
		if (/\bplugin\s*\(?\s*['"]ear['"]|\bid\s*\(?\s*['"]ear['"]/i.test(text)) {
			return 'ear';
		}
		if (/\bplugin\s*\(?\s*['"]war['"]|\bid\s*\(?\s*['"]war['"]/i.test(text)) {
			return 'war';
		}
		if (/jakarta\.ejb|javax\.ejb|jakarta\.platform|javaee-api/i.test(text)) {
			return 'ejb';
		}
		return undefined;
	}
	if (/<ear\b|<war\b|<ejbjar\b/i.test(text)) {
		return /<ear\b/i.test(text) ? 'ear' : /<war\b/i.test(text) ? 'war' : 'ejb';
	}
	return undefined;
}

function enterpriseProjectName(text: string, root: vscode.Uri, buildTool: EnterpriseBuildTool): string {
	if (buildTool === 'maven') {
		return /<name>\s*([^<]+?)\s*<\/name>/.exec(text)?.[1]
			?? /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(text)?.[1]
			?? path.basename(root.fsPath);
	}
	if (buildTool === 'ant') {
		return /<project\b[^>]*\bname\s*=\s*['"]([^'"]+)['"]/.exec(text)?.[1] ?? path.basename(root.fsPath);
	}
	return path.basename(root.fsPath);
}

function createEnterpriseBuildTask(project: IEnterpriseProject, quiet = false): vscode.Task {
	let executable: string;
	let args: string[];
	if (project.buildTool === 'maven') {
		const wrapper = path.join(project.root.fsPath, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
		({ executable, args } = wrapperCommand(wrapper, process.platform === 'win32' ? 'mvn.cmd' : 'mvn', ['package']));
	} else if (project.buildTool === 'gradle') {
		const wrapper = path.join(project.root.fsPath, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
		({ executable, args } = wrapperCommand(wrapper, process.platform === 'win32' ? 'gradle.bat' : 'gradle', ['build']));
	} else {
		executable = process.platform === 'win32' ? 'ant.bat' : 'ant';
		args = [];
	}
	const task = new vscode.Task(
		{ type: 'orbyte-enterprise', action: 'build', project: project.root.fsPath },
		project.folder,
		`Build ${project.name}`,
		'Orbyte Enterprise Java',
		new vscode.ShellExecution(executable, args, { cwd: project.root.fsPath }),
		[],
	);
	task.group = vscode.TaskGroup.Build;
	task.presentationOptions = { reveal: quiet ? vscode.TaskRevealKind.Silent : vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: !quiet };
	return task;
}

function createServerTask(server: IEnterpriseServer, action: 'start' | 'stop' | 'debug'): vscode.Task {
	let executable: string;
	let args: string[];
	if (server.kind === 'wildfly') {
		if (action === 'stop') {
			executable = serverExecutable(server.home!, 'bin', scriptName('jboss-cli'))!;
			args = ['--connect', '--command=:shutdown'];
		} else {
			executable = serverExecutable(server.home!, 'bin', scriptName('standalone'))!;
			args = action === 'debug' ? ['--debug', String(server.debugPort)] : [];
		}
	} else {
		executable = serverExecutable(server.home!, 'bin', scriptName(action === 'stop' ? 'stopServer' : 'startServer'))!;
		args = [server.serverName ?? 'server1'];
	}
	return terminalTask(
		{ type: 'orbyte-enterprise', action, server: server.kind },
		`${action === 'debug' ? 'Debug' : action === 'start' ? 'Start' : 'Stop'} ${server.label}`,
		executable,
		args,
		server.home!,
	);
}

function createDeploymentTask(server: IEnterpriseServer, project: IEnterpriseProject, artifact: vscode.Uri, quiet = false): vscode.Task {
	let executable: string;
	let args: string[];
	if (server.kind === 'wildfly') {
		executable = serverExecutable(server.home!, 'bin', scriptName('jboss-cli'))!;
		args = ['--connect', `--command=deploy "${artifact.fsPath}" --force`];
	} else {
		executable = serverExecutable(server.home!, 'bin', scriptName('wsadmin'))!;
		const artifactPath = artifact.fsPath.replaceAll('\\', '/').replaceAll("'", "\\'");
		const appName = path.basename(artifact.fsPath, path.extname(artifact.fsPath)).replace(/[^A-Za-z0-9_.-]/g, '-');
		const script = [
			'apps = AdminApp.list().splitlines()',
			`if '${appName}' in apps:`,
			`    AdminApp.update('${appName}', 'app', ['-operation', 'update', '-contents', '${artifactPath}'])`,
			'else:',
			`    AdminApp.install('${artifactPath}', ['-appname', '${appName}'])`,
			'AdminConfig.save()',
		].join('\n');
		args = ['-lang', 'jython', '-c', script];
	}
	const task = terminalTask(
		{ type: 'orbyte-enterprise', action: 'deploy', server: server.kind, project: project.root.fsPath },
		`Deploy ${project.name} to ${server.label}`,
		executable,
		args,
		project.root.fsPath,
	);
	if (quiet) {
		task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Dedicated, clear: false };
	}
	return task;
}

function terminalTask(definition: vscode.TaskDefinition, name: string, executable: string, args: string[], cwd: string): vscode.Task {
	const scope = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd)) ?? vscode.TaskScope.Workspace;
	const task = new vscode.Task(definition, scope, name, 'Orbyte Application Servers', new vscode.ShellExecution(executable, args, { cwd }), []);
	task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: false };
	return task;
}

async function findDeploymentArtifact(project: IEnterpriseProject): Promise<vscode.Uri | undefined> {
	const patterns = ['target/**/*.{ear,war,jar}', 'build/libs/**/*.{ear,war,jar}', 'dist/**/*.{ear,war,jar}'];
	const artifacts = (await Promise.all(patterns.map(pattern => vscode.workspace.findFiles(new vscode.RelativePattern(project.root, pattern), undefined, 100)))).flat();
	const candidates = artifacts.filter(uri => !/(?:-sources|-javadoc|-tests|\.original|plain)\.(?:jar|war|ear)$/i.test(uri.fsPath));
	const preferredExtension = project.packaging === 'ejb' ? '.jar' : `.${project.packaging}`;
	const preferred = candidates.filter(uri => path.extname(uri.fsPath).toLowerCase() === preferredExtension);
	const withStats = await Promise.all((preferred.length ? preferred : candidates).map(async uri => ({ uri, stat: await fs.stat(uri.fsPath) })));
	return withStats.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0]?.uri;
}

async function attachDebugger(server: IEnterpriseServer, projectPath?: string): Promise<void> {
	const java = vscode.extensions.getExtension('redhat.java');
	const debuggerExtension = vscode.extensions.getExtension('vscjava.vscode-java-debug');
	if (!java || !debuggerExtension) {
		void vscode.window.showErrorMessage('Java language support and the Java debugger are required to attach to an application server.');
		return;
	}
	await Promise.all([java.activate(), debuggerExtension.activate()]);
	await vscode.debug.startDebugging(undefined, {
		type: 'java',
		request: 'attach',
		name: `Attach to ${server.label}`,
		hostName: 'localhost',
		port: server.debugPort,
		orbyteProject: projectPath,
		orbyteMode: projectPath ? 'debug' : undefined,
	});
}

function waitForTask(execution: vscode.TaskExecution, timeoutMs = 10 * 60_000): Promise<number | undefined> {
	return new Promise(resolve => {
		const timeout = setTimeout(() => {
			disposable.dispose();
			resolve(undefined);
		}, timeoutMs);
		const disposable = vscode.tasks.onDidEndTaskProcess(event => {
			if (event.execution === execution) {
				clearTimeout(timeout);
				disposable.dispose();
				resolve(event.exitCode);
			}
		});
	});
}

function normalizePath(value: string): string {
	return process.platform === 'win32' ? value.toLowerCase() : value;
}

async function waitForPort(host: string, port: number, timeout: number): Promise<boolean> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await canConnect(host, port)) {
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	return false;
}

function canConnect(host: string, port: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = net.createConnection({ host, port });
		const finish = (result: boolean) => {
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(400);
		socket.once('connect', () => finish(true));
		socket.once('timeout', () => finish(false));
		socket.once('error', () => finish(false));
	});
}

async function resolveWebSphereProfile(selectedPath: string): Promise<string | undefined> {
	if (isWebSphereProfile(selectedPath)) {
		return selectedPath;
	}
	const profilesRoot = path.join(selectedPath, 'profiles');
	try {
		const entries = await fs.readdir(profilesRoot, { withFileTypes: true });
		const profiles = entries.filter(entry => entry.isDirectory()).map(entry => path.join(profilesRoot, entry.name)).filter(isWebSphereProfile);
		if (profiles.length === 1) {
			return profiles[0];
		}
		if (profiles.length > 1) {
			const selected = await vscode.window.showQuickPick(profiles.map(profile => ({ label: path.basename(profile), description: profile, profile })), { title: 'Select a WebSphere profile' });
			return selected?.profile;
		}
	} catch {
		// The selected directory does not contain a profiles directory.
	}
	return undefined;
}

function isWebSphereProfile(profile: string): boolean {
	return Boolean(serverExecutable(profile, 'bin', scriptName('startServer')) && serverExecutable(profile, 'bin', scriptName('wsadmin')));
}

function isServerInstallationValid(server: IEnterpriseServer): boolean {
	return server.kind === 'wildfly'
		? Boolean(serverExecutable(server.home!, 'bin', scriptName('standalone')) && serverExecutable(server.home!, 'bin', scriptName('jboss-cli')))
		: isWebSphereProfile(server.home!);
}

function serverExecutable(home: string, ...segments: string[]): string | undefined {
	const executable = path.join(home, ...segments);
	return existsSync(executable) ? executable : undefined;
}

function wrapperCommand(wrapper: string, fallback: string, args: string[]): { executable: string; args: string[] } {
	if (!existsSync(wrapper)) {
		return { executable: fallback, args };
	}
	return process.platform === 'win32' ? { executable: wrapper, args } : { executable: '/bin/sh', args: [wrapper, ...args] };
}

function scriptName(base: string): string {
	return process.platform === 'win32' ? `${base}.bat` : `${base}.sh`;
}

function workspaceConfigurationTarget(): vscode.ConfigurationTarget {
	return vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

async function promptPort(title: string, defaultPort: number): Promise<number | undefined> {
	const value = await vscode.window.showInputBox({
		title,
		value: String(defaultPort),
		validateInput: input => {
			const port = Number(input);
			return Number.isInteger(port) && port > 0 && port <= 65535 ? undefined : 'Enter a port between 1 and 65535.';
		},
	});
	return value ? Number(value) : undefined;
}

async function readText(filePath: string): Promise<string> {
	try {
		return (await fs.readFile(filePath)).subarray(0, 1024 * 1024).toString('utf8');
	} catch {
		return '';
	}
}

function serverKindFrom(value: unknown): ServerKind | undefined {
	if (value === 'wildfly' || value === 'websphere') {
		return value;
	}
	if (value && typeof value === 'object' && 'server' in value) {
		return (value as IServerTreeNode).server?.kind;
	}
	return undefined;
}

function isUri(value: unknown): value is vscode.Uri {
	return Boolean(value && typeof value === 'object' && 'scheme' in value && 'fsPath' in value);
}

function isWithin(candidate: string, parent: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function serverDescription(server: IEnterpriseServer): string {
	return server.kind === 'websphere' ? `${server.serverName} · debug ${server.debugPort}` : `debug ${server.debugPort}`;
}

function buildToolLabel(tool: EnterpriseBuildTool): string {
	return tool === 'maven' ? 'Maven' : tool === 'gradle' ? 'Gradle' : 'Ant';
}

function actionLabel(action: ServerAction, kind: ServerKind): string {
	if (action === 'start') {
		return 'Start Server';
	}
	if (action === 'debug') {
		return 'Start in Debug Mode';
	}
	if (action === 'attach') {
		return kind === 'websphere' ? 'Attach Java Debugger' : 'Attach to Debug Port';
	}
	if (action === 'stop') {
		return 'Stop Server';
	}
	return 'Build & Deploy Project…';
}

function actionIcon(action: ServerAction): string {
	return action === 'start' ? 'play'
		: action === 'debug' || action === 'attach' ? 'debug-alt'
			: action === 'stop' ? 'debug-stop'
				: 'cloud-upload';
}
