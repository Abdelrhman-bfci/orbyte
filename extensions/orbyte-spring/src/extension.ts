/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbyte. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, createWriteStream } from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as vscode from 'vscode';
import * as yauzl from 'yauzl';
import { registerEnterpriseRuntime } from './enterpriseRuntime';
import { registerEnvironmentSetup } from './environmentSetup';
import { registerJdkRuntime } from './jdkRuntime';
import { registerProjectRuntime } from './projectRuntime';

interface IChoice {
	readonly id: string;
	readonly name: string;
}

interface IInitializrMetadata {
	readonly bootVersion?: { readonly default?: string; readonly values?: readonly IChoice[] };
	readonly javaVersion?: { readonly default?: string; readonly values?: readonly IChoice[] };
}

interface IProjectRequest {
	readonly build: 'maven-project' | 'gradle-project' | 'gradle-project-kotlin';
	readonly language: 'java' | 'kotlin' | 'groovy';
	readonly bootVersion: string;
	readonly groupId: string;
	readonly artifactId: string;
	readonly name: string;
	readonly description: string;
	readonly packageName: string;
	readonly packaging: 'jar' | 'war';
	readonly javaVersion: string;
	readonly dependencies: readonly string[];
}

const fallbackMetadata: IInitializrMetadata = {
	bootVersion: {
		default: '4.1.2',
		values: [
			{ id: '4.1.2', name: '4.1.2' },
			{ id: '4.0.9', name: '4.0.9' },
		],
	},
	javaVersion: {
		default: '17',
		values: [
			{ id: '25', name: '25' },
			{ id: '21', name: '21' },
			{ id: '17', name: '17' },
		],
	},
};

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.commands.registerCommand('orbyte.spring.createProject', () => showSpringProjectWizard()));
	registerEnvironmentSetup(context);
	registerJdkRuntime(context);
	registerProjectRuntime(context);
	registerEnterpriseRuntime(context);
}

async function showSpringProjectWizard(): Promise<void> {
	const metadata = await fetchMetadata().catch(() => fallbackMetadata);
	const panel = vscode.window.createWebviewPanel(
		'orbyteSpringProject',
		'New Spring Boot Project',
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	panel.webview.html = wizardHtml(metadata);
	panel.webview.onDidReceiveMessage(async message => {
		if (message?.type !== 'create') {
			return;
		}
		const request = validateRequest(message.project);
		if (!request) {
			void vscode.window.showErrorMessage('Complete the required Spring project fields. Group, artifact, package, and project name are required.');
			return;
		}
		const destination = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Create Project Here',
			title: 'Select the parent directory for the Spring Boot project',
		});
		if (!destination?.[0]) {
			return;
		}
		const projectDirectory = path.join(destination[0].fsPath, request.artifactId);
		try {
			await ensureEmptyDestination(projectDirectory);
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: `Creating Spring Boot project ${request.name}`,
				cancellable: false,
			}, async progress => {
				progress.report({ message: 'Generating with Spring Initializr…' });
				try {
					const archive = await download(initializrUrl(request));
					progress.report({ message: 'Extracting project…' });
					await extractZip(archive, projectDirectory);
				} catch (error) {
					if (request.language !== 'kotlin') {
						throw error;
					}
					progress.report({ message: 'Spring Initializr Kotlin generation is unavailable; using Orbyte fallback…' });
					await generateKotlinProject(request, projectDirectory);
				}
			});
			panel.dispose();
			const action = await vscode.window.showInformationMessage(
				`Created ${request.name} with ${languageLabel(request.language)}, ${buildLabel(request.build)}, Java ${request.javaVersion}, and Spring Boot ${displayBootVersion(request.bootVersion)}.`,
				'Open Project',
				'Add to Workspace',
			);
			if (action === 'Open Project') {
				await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectDirectory));
			} else if (action === 'Add to Workspace') {
				vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(projectDirectory) });
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not create Spring Boot project: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}

function validateRequest(value: unknown): IProjectRequest | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	const stringValue = (key: string) => typeof candidate[key] === 'string' ? candidate[key].trim() : '';
	const build = stringValue('build');
	const language = stringValue('language');
	const packaging = stringValue('packaging');
	const required = ['bootVersion', 'groupId', 'artifactId', 'name', 'packageName', 'javaVersion'];
	if (!['maven-project', 'gradle-project', 'gradle-project-kotlin'].includes(build)
		|| !['java', 'kotlin', 'groovy'].includes(language)
		|| !['jar', 'war'].includes(packaging)
		|| required.some(key => !stringValue(key))) {
		return undefined;
	}
	const groupId = stringValue('groupId');
	const artifactId = stringValue('artifactId');
	const packageName = stringValue('packageName');
	if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(groupId)
		|| !/^[A-Za-z][A-Za-z0-9._-]*$/.test(artifactId)
		|| !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(packageName)) {
		return undefined;
	}
	return {
		build: build as IProjectRequest['build'],
		language: language as IProjectRequest['language'],
		bootVersion: stringValue('bootVersion'),
		groupId,
		artifactId,
		name: stringValue('name'),
		description: stringValue('description'),
		packageName,
		packaging: packaging as IProjectRequest['packaging'],
		javaVersion: stringValue('javaVersion'),
		dependencies: Array.isArray(candidate.dependencies)
			? candidate.dependencies.filter((item): item is string => typeof item === 'string')
			: [],
	};
}

async function ensureEmptyDestination(destination: string): Promise<void> {
	try {
		const entries = await fs.readdir(destination);
		if (entries.length) {
			throw new Error(`The destination ${destination} already exists and is not empty.`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
	await fs.mkdir(destination, { recursive: true });
}

function initializrUrl(request: IProjectRequest): string {
	const query = new URLSearchParams({
		type: request.build,
		language: request.language,
		bootVersion: request.bootVersion,
		groupId: request.groupId,
		artifactId: request.artifactId,
		name: request.name,
		description: request.description,
		packageName: request.packageName,
		packaging: request.packaging,
		javaVersion: request.javaVersion,
		dependencies: request.dependencies.join(','),
	});
	return `https://start.spring.io/starter.zip?${query.toString()}`;
}

async function fetchMetadata(): Promise<IInitializrMetadata> {
	const data = await download('https://start.spring.io/metadata/client', { Accept: 'application/json' });
	return JSON.parse(data.toString('utf8')) as IInitializrMetadata;
}

function download(url: string, headers: Record<string, string> = {}, redirects = 0): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const request = https.get(url, { headers: { 'User-Agent': 'Orbyte Spring Project Wizard', ...headers } }, response => {
			const statusCode = response.statusCode ?? 0;
			if (statusCode >= 300 && statusCode < 400 && response.headers.location && redirects < 5) {
				response.resume();
				void download(new URL(response.headers.location, url).toString(), headers, redirects + 1).then(resolve, reject);
				return;
			}
			if (statusCode < 200 || statusCode >= 300) {
				response.resume();
				reject(new Error(`Spring Initializr returned HTTP ${statusCode}.`));
				return;
			}
			const chunks: Buffer[] = [];
			response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			response.on('end', () => resolve(Buffer.concat(chunks)));
		});
		request.on('error', reject);
		request.setTimeout(30_000, () => request.destroy(new Error('Spring Initializr timed out.')));
	});
}

function extractZip(archive: Buffer, destination: string): Promise<void> {
	return new Promise((resolve, reject) => {
		yauzl.fromBuffer(archive, { lazyEntries: true }, (openError, zipFile) => {
			if (openError || !zipFile) {
				reject(openError ?? new Error('Invalid Spring project archive.'));
				return;
			}
			zipFile.on('error', reject);
			zipFile.on('end', resolve);
			zipFile.on('entry', entry => {
				const destinationPath = path.resolve(destination, entry.fileName);
				const rootPath = `${path.resolve(destination)}${path.sep}`;
				if (!destinationPath.startsWith(rootPath)) {
					zipFile.close();
					reject(new Error('Spring Initializr returned an unsafe archive path.'));
					return;
				}
				if (/\/$/.test(entry.fileName)) {
					void fs.mkdir(destinationPath, { recursive: true }).then(() => zipFile.readEntry(), reject);
					return;
				}
				void fs.mkdir(path.dirname(destinationPath), { recursive: true }).then(() => {
					zipFile.openReadStream(entry, (streamError, stream) => {
						if (streamError || !stream) {
							reject(streamError ?? new Error('Could not read Spring project archive.'));
							return;
						}
						const output = createWriteStream(destinationPath, { mode: (entry.externalFileAttributes >>> 16) & 0o777 });
						stream.on('error', reject);
						output.on('error', reject);
						output.on('finish', () => zipFile.readEntry());
						stream.pipe(output);
					});
				}, reject);
			});
			zipFile.readEntry();
		});
	});
}

function languageLabel(language: IProjectRequest['language']): string {
	return language === 'java' ? 'Java' : language === 'kotlin' ? 'Kotlin' : 'Groovy';
}

function buildLabel(build: IProjectRequest['build']): string {
	return build === 'maven-project' ? 'Maven' : build === 'gradle-project-kotlin' ? 'Gradle Kotlin' : 'Gradle Groovy';
}

function displayBootVersion(version: string): string {
	return version.replace(/\.RELEASE$/, '');
}

const dependencyArtifacts: Record<string, { group: string; artifact: string; scope?: string }> = {
	web: { group: 'org.springframework.boot', artifact: 'spring-boot-starter-webmvc' },
	webflux: { group: 'org.springframework.boot', artifact: 'spring-boot-starter-webflux' },
	'data-jpa': { group: 'org.springframework.boot', artifact: 'spring-boot-starter-data-jpa' },
	security: { group: 'org.springframework.boot', artifact: 'spring-boot-starter-security' },
	validation: { group: 'org.springframework.boot', artifact: 'spring-boot-starter-validation' },
	actuator: { group: 'org.springframework.boot', artifact: 'spring-boot-starter-actuator' },
	devtools: { group: 'org.springframework.boot', artifact: 'spring-boot-devtools', scope: 'runtime' },
	h2: { group: 'com.h2database', artifact: 'h2', scope: 'runtime' },
	postgresql: { group: 'org.postgresql', artifact: 'postgresql', scope: 'runtime' },
	mysql: { group: 'com.mysql', artifact: 'mysql-connector-j', scope: 'runtime' },
	thymeleaf: { group: 'org.springframework.boot', artifact: 'spring-boot-starter-thymeleaf' },
};

async function generateKotlinProject(request: IProjectRequest, destination: string): Promise<void> {
	const className = `${pascalCase(request.artifactId)}Application`;
	const packagePath = request.packageName.replaceAll('.', '/');
	const sourceDirectory = path.join(destination, 'src', 'main', 'kotlin', packagePath);
	const testDirectory = path.join(destination, 'src', 'test', 'kotlin', packagePath);
	await Promise.all([
		fs.mkdir(sourceDirectory, { recursive: true }),
		fs.mkdir(testDirectory, { recursive: true }),
		fs.mkdir(path.join(destination, 'src', 'main', 'resources'), { recursive: true }),
	]);
	await Promise.all([
		fs.writeFile(path.join(sourceDirectory, `${className}.kt`), `package ${request.packageName}\n\nimport org.springframework.boot.autoconfigure.SpringBootApplication\nimport org.springframework.boot.runApplication\n\n@SpringBootApplication\nclass ${className}\n\nfun main(args: Array<String>) {\n\trunApplication<${className}>(*args)\n}\n`),
		fs.writeFile(path.join(testDirectory, `${className}Tests.kt`), `package ${request.packageName}\n\nimport org.junit.jupiter.api.Test\nimport org.springframework.boot.test.context.SpringBootTest\n\n@SpringBootTest\nclass ${className}Tests {\n\t@Test\n\tfun contextLoads() {\n\t}\n}\n`),
		fs.writeFile(path.join(destination, 'src', 'main', 'resources', 'application.properties'), `spring.application.name=${request.name}\n`),
		fs.writeFile(path.join(destination, '.gitignore'), '.gradle/\nbuild/\ntarget/\n.idea/\n*.iml\n.vscode/\n'),
		fs.writeFile(path.join(destination, 'README.md'), `# ${request.name}\n\n${request.description || 'Spring Boot application generated by Orbyte.'}\n`),
	]);
	if (request.build === 'maven-project') {
		await fs.writeFile(path.join(destination, 'pom.xml'), kotlinMavenBuild(request));
	} else if (request.build === 'gradle-project-kotlin') {
		await fs.writeFile(path.join(destination, 'settings.gradle.kts'), `rootProject.name = "${request.name}"\n`);
		await fs.writeFile(path.join(destination, 'build.gradle.kts'), kotlinGradleBuild(request, true));
	} else {
		await fs.writeFile(path.join(destination, 'settings.gradle'), `rootProject.name = '${request.name}'\n`);
		await fs.writeFile(path.join(destination, 'build.gradle'), kotlinGradleBuild(request, false));
	}
}

function kotlinMavenBuild(request: IProjectRequest): string {
	const dependencies = request.dependencies.map(id => dependencyArtifacts[id]).filter((value): value is NonNullable<typeof value> => Boolean(value));
	const dependencyXml = dependencies.map(dependency => `\n\t\t<dependency>\n\t\t\t<groupId>${dependency.group}</groupId>\n\t\t\t<artifactId>${dependency.artifact}</artifactId>${dependency.scope ? `\n\t\t\t<scope>${dependency.scope}</scope>` : ''}\n\t\t</dependency>`).join('');
	return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
\t<modelVersion>4.0.0</modelVersion>
\t<parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>${request.bootVersion}</version><relativePath/></parent>
\t<groupId>${request.groupId}</groupId><artifactId>${request.artifactId}</artifactId><version>0.0.1-SNAPSHOT</version><packaging>${request.packaging}</packaging>
\t<name>${request.name}</name><description>${escapeXml(request.description)}</description>
\t<properties><java.version>${request.javaVersion}</java.version><kotlin.version>2.2.21</kotlin.version></properties>
\t<dependencies>
\t\t<dependency><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-reflect</artifactId></dependency>${dependencyXml}
\t\t<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-test</artifactId><scope>test</scope></dependency>
\t</dependencies>
\t<build><sourceDirectory>\${project.basedir}/src/main/kotlin</sourceDirectory><testSourceDirectory>\${project.basedir}/src/test/kotlin</testSourceDirectory><plugins>
\t\t<plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin>
\t\t<plugin><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-maven-plugin</artifactId><extensions>true</extensions><configuration><args><arg>-Xjsr305=strict</arg></args><compilerPlugins><plugin>spring</plugin></compilerPlugins></configuration><dependencies><dependency><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-maven-allopen</artifactId><version>\${kotlin.version}</version></dependency></dependencies></plugin>
\t</plugins></build>
</project>
`;
}

function kotlinGradleBuild(request: IProjectRequest, kotlinDsl: boolean): string {
	const quote = kotlinDsl ? '"' : '\'';
	const pluginLine = kotlinDsl
		? `kotlin("jvm") version "2.2.21"\n\tkotlin("plugin.spring") version "2.2.21"\n\tid("org.springframework.boot") version "${request.bootVersion}"\n\tid("io.spring.dependency-management") version "1.1.7"`
		: `id 'org.jetbrains.kotlin.jvm' version '2.2.21'\n\tid 'org.jetbrains.kotlin.plugin.spring' version '2.2.21'\n\tid 'org.springframework.boot' version '${request.bootVersion}'\n\tid 'io.spring.dependency-management' version '1.1.7'`;
	const configuration = (scope: string | undefined) => scope === 'runtime' ? 'runtimeOnly' : 'implementation';
	const dependencies = request.dependencies.map(id => dependencyArtifacts[id]).filter((value): value is NonNullable<typeof value> => Boolean(value));
	const dependencyLines = dependencies.map(dependency => `\t${configuration(dependency.scope)}(${quote}${dependency.group}:${dependency.artifact}${quote})`).join('\n');
	const testConfiguration = kotlinDsl ? 'tasks.withType<Test> { useJUnitPlatform() }' : "tasks.named('test') { useJUnitPlatform() }";
	return `plugins {\n\t${pluginLine}\n}\n\ngroup = ${quote}${request.groupId}${quote}\nversion = ${quote}0.0.1-SNAPSHOT${quote}\n\njava { toolchain { languageVersion = JavaLanguageVersion.of(${request.javaVersion}) } }\n\nrepositories { mavenCentral() }\n\ndependencies {\n\timplementation(${quote}org.jetbrains.kotlin:kotlin-reflect${quote})\n${dependencyLines}\n\ttestImplementation(${quote}org.springframework.boot:spring-boot-starter-test${quote})\n}\n\n${testConfiguration}\n`;
}

function pascalCase(value: string): string {
	const result = value.split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join('');
	return result || 'Application';
}

function escapeXml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&apos;');
}

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function selectOptions(values: readonly IChoice[] | undefined, selected: string): string {
	return (values ?? []).map(value => `<option value="${escapeHtml(value.id)}"${value.id === selected ? ' selected' : ''}>${escapeHtml(value.name)}</option>`).join('');
}

function wizardHtml(metadata: IInitializrMetadata): string {
	const bootVersion = metadata.bootVersion?.default ?? fallbackMetadata.bootVersion!.default!;
	const javaVersion = metadata.javaVersion?.default ?? fallbackMetadata.javaVersion!.default!;
	const bootOptions = selectOptions(metadata.bootVersion?.values ?? fallbackMetadata.bootVersion?.values, bootVersion);
	const javaOptions = selectOptions(metadata.javaVersion?.values ?? fallbackMetadata.javaVersion?.values, javaVersion);
	const nonce = Math.random().toString(36).slice(2);
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:13px var(--vscode-font-family)}
.shell{display:grid;grid-template-columns:210px minmax(560px,820px);min-height:100vh}.rail{padding:34px 22px;background:var(--vscode-sideBar-background);border-right:1px solid var(--vscode-sideBar-border)}
.brand{font-size:20px;font-weight:700;margin-bottom:34px}.step{display:flex;gap:11px;align-items:center;padding:10px 8px;color:var(--vscode-descriptionForeground)}.step.active{color:var(--vscode-foreground);font-weight:600}.num{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;border:1px solid var(--vscode-panel-border)}.active .num{background:var(--vscode-button-background);border-color:var(--vscode-button-background);color:var(--vscode-button-foreground)}
main{padding:34px 42px 60px}h1{font-size:24px;margin:0 0 6px}h2{font-size:15px;margin:28px 0 12px}.sub{color:var(--vscode-descriptionForeground);margin-bottom:24px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 18px}.full{grid-column:1/-1}label{display:flex;flex-direction:column;gap:6px;font-weight:600}input,select{height:34px;padding:0 9px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:3px;outline:none}input:focus,select:focus{border-color:var(--vscode-focusBorder)}
.dependencies{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.dependency{display:flex;align-items:center;gap:8px;padding:10px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-sideBar-background);font-weight:400}.dependency:hover{border-color:var(--vscode-focusBorder)}.dependency input{width:15px;height:15px}.actions{display:flex;justify-content:flex-end;margin-top:30px;padding-top:20px;border-top:1px solid var(--vscode-panel-border)}button{border:0;border-radius:3px;padding:8px 18px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}
@media(max-width:850px){.shell{grid-template-columns:1fr}.rail{display:none}.grid,.dependencies{grid-template-columns:1fr}main{padding:24px}.full{grid-column:auto}}
</style></head><body><div class="shell"><aside class="rail"><div class="brand">Orbyte Spring</div><div class="step active"><span class="num">1</span>Project</div><div class="step"><span class="num">2</span>Dependencies</div><div class="step"><span class="num">3</span>Location</div></aside>
<main><h1>New Spring Boot Project</h1><div class="sub">Create a production-ready project with Spring Initializr.</div><form id="form"><div class="grid">
<label>Build system<select name="build"><option value="maven-project">Maven</option><option value="gradle-project">Gradle - Groovy</option><option value="gradle-project-kotlin">Gradle - Kotlin</option></select></label>
<label>Language<select name="language"><option value="java">Java</option><option value="kotlin">Kotlin</option><option value="groovy">Groovy</option></select></label>
<label>Spring Boot<select name="bootVersion">${bootOptions}</select></label><label>Java<select name="javaVersion">${javaOptions}</select></label>
<label>Group<input name="groupId" value="com.example" required></label><label>Artifact<input name="artifactId" value="demo" required></label>
<label>Name<input name="name" value="demo" required></label><label>Package name<input name="packageName" value="com.example.demo" required></label>
<label class="full">Description<input name="description" value="Demo project for Spring Boot"></label><label>Packaging<select name="packaging"><option value="jar">Jar</option><option value="war">War</option></select></label>
</div><h2>Dependencies</h2><div class="dependencies">
${[['web','Spring Web'],['webflux','Spring Reactive Web'],['data-jpa','Spring Data JPA'],['security','Spring Security'],['validation','Validation'],['actuator','Actuator'],['devtools','DevTools'],['lombok','Lombok'],['h2','H2 Database'],['postgresql','PostgreSQL'],['mysql','MySQL Driver'],['thymeleaf','Thymeleaf']].map(([id,name])=>`<label class="dependency"><input type="checkbox" name="dependencies" value="${id}"${id==='web'?' checked':''}>${name}</label>`).join('')}
</div><div class="actions"><button type="submit">Create Project…</button></div></form></main></div>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();const form=document.getElementById('form');const artifact=form.elements.artifactId;const name=form.elements.name;const packageName=form.elements.packageName;artifact.addEventListener('input',()=>{name.value=artifact.value;packageName.value=form.elements.groupId.value+'.'+artifact.value.replace(/[^A-Za-z0-9_]/g,'');});form.addEventListener('submit',event=>{event.preventDefault();const data=new FormData(form);vscode.postMessage({type:'create',project:{build:data.get('build'),language:data.get('language'),bootVersion:data.get('bootVersion'),javaVersion:data.get('javaVersion'),groupId:data.get('groupId'),artifactId:data.get('artifactId'),name:data.get('name'),packageName:data.get('packageName'),description:data.get('description'),packaging:data.get('packaging'),dependencies:data.getAll('dependencies')}});});</script></body></html>`;
}
