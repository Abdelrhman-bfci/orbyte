/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbyte. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readdirSync, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export function isOffline(): boolean {
	return vscode.workspace.getConfiguration('orbyte.run').get<boolean>('offline', false);
}

export async function setOffline(offline: boolean): Promise<void> {
	const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
	const settings = vscode.workspace.getConfiguration();
	await settings.update('orbyte.run.offline', offline, target);
	for (const key of ['java.import.maven.offline.enabled', 'java.import.gradle.offline.enabled']) {
		await settings.update(key, offline, target);
	}
}

export function offlineEnvironment(): Record<string, string> | undefined {
	return isOffline() ? {
		npm_config_offline: 'true',
		YARN_ENABLE_NETWORK: '0',
		COREPACK_ENABLE_NETWORK: '0',
		PIP_NO_INDEX: '1',
		GOPROXY: 'off',
		GOSUMDB: 'off',
		GOTOOLCHAIN: 'local',
		CARGO_NET_OFFLINE: 'true',
	} : undefined;
}

export function javaBuildCommand(root: vscode.Uri, tool: 'maven' | 'gradle', args: string[]): { executable: string; args: string[] } {
	const windows = process.platform === 'win32';
	const maven = tool === 'maven';
	const executable = maven ? (windows ? 'mvn.cmd' : 'mvn') : (windows ? 'gradle.bat' : 'gradle');
	const wrapper = path.join(root.fsPath, maven ? (windows ? 'mvnw.cmd' : 'mvnw') : (windows ? 'gradlew.bat' : 'gradlew'));
	if (isOffline()) {
		// The wrapper itself may fetch the tool before it forwards the offline flag.
		const cached = cachedBuildTool(root.fsPath, tool, executable);
		return { executable: cached ?? executable, args: [maven ? '-o' : '--offline', ...args] };
	}
	return !existsSync(wrapper) ? { executable, args }
		: windows ? { executable: wrapper, args }
			: { executable: '/bin/sh', args: [wrapper, ...args] };
}

function cachedBuildTool(root: string, tool: 'maven' | 'gradle', executable: string): string | undefined {
	try {
		const maven = tool === 'maven';
		const properties = readFileSync(path.join(root, maven ? '.mvn/wrapper/maven-wrapper.properties' : 'gradle/wrapper/gradle-wrapper.properties'), 'utf8');
		const distribution = /^\s*distributionUrl\s*=.*[/\\]([\w.-]+)\.zip\s*$/m.exec(properties)?.[1];
		if (!distribution) {
			return undefined;
		}
		const userHome = maven ? process.env.MAVEN_USER_HOME || path.join(os.homedir(), '.m2')
			: process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle');
		const cache = path.join(userHome, 'wrapper', 'dists');
		const distributions = maven ? [distribution, distribution.replace(/-bin$/, '')] : [distribution];
		for (const name of new Set(distributions)) {
			const directory = path.join(cache, name);
			if (!existsSync(directory)) {
				continue;
			}
			for (const hash of readdirSync(directory, { withFileTypes: true })) {
				if (!hash.isDirectory()) {
					continue;
				}
				const candidate = path.join(directory, hash.name, 'bin', executable);
				if (existsSync(candidate)) {
					return candidate;
				}
				for (const child of readdirSync(path.join(directory, hash.name), { withFileTypes: true })) {
					const nested = path.join(directory, hash.name, child.name, 'bin', executable);
					if (child.isDirectory() && existsSync(nested)) {
						return nested;
					}
				}
			}
		}
	} catch {
		// Fall back to the local tool on PATH when no wrapper distribution is cached.
	}
	return undefined;
}
