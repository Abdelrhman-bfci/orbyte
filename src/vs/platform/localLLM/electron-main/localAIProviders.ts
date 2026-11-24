/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, SpawnOptions, spawn } from 'child_process';
import { access, constants, stat } from 'fs/promises';
import { homedir } from 'os';
import { delimiter, isAbsolute, join } from 'path';
import { removeAnsiEscapeCodes } from '../../../base/common/strings.js';
import { findExecutable } from '../../../base/node/processes.js';
import { LocalAIExternalProviderId, LocalAIProviderAuthState } from '../common/localLLM.js';

interface IExternalProvider {
	readonly name: string;
	readonly description: string;
	readonly commands: readonly string[];
	readonly setupUrl: string;
	readonly statusArgs: readonly string[];
	readonly loginArgs: readonly string[];
	readonly chatArgs: readonly string[];
}

export type LocalAICliProviderId = Exclude<LocalAIExternalProviderId, 'cursor'>;

const externalAIProviders: Readonly<Record<LocalAICliProviderId, IExternalProvider>> = {
	codex: {
		name: 'Codex', description: 'ChatGPT account via the Codex CLI', commands: ['codex'],
		setupUrl: 'https://learn.chatgpt.com/docs/cli',
		statusArgs: ['login', 'status'], loginArgs: ['login'],
		chatArgs: ['exec', '--json', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '-'],
	},
	claude: {
		name: 'Claude', description: 'Connect through Anthropic’s official Claude Code sign-in', commands: ['claude'],
		setupUrl: 'https://code.claude.com/docs/en/setup',
		statusArgs: ['auth', 'status'], loginArgs: ['auth', 'login'],
		chatArgs: ['-p', '--tools=', '--disallowedTools', 'mcp__*', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
	},
};

export function getExternalAIProvider(id: LocalAICliProviderId): IExternalProvider {
	if (!Object.hasOwn(externalAIProviders, id)) {
		throw new Error('Unknown external AI provider.');
	}
	return externalAIProviders[id];
}

export async function findProviderCommand(id: LocalAICliProviderId, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const provider = getExternalAIProvider(id);
	const home = homedir();
	const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
	const paths = (pathKey ? env[pathKey] : '')?.split(delimiter).filter(isAbsolute) ?? [];
	paths.push(join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'));
	if (process.platform === 'win32' && env.APPDATA && isAbsolute(env.APPDATA)) {
		paths.push(join(env.APPDATA, 'npm'));
	} else if (process.platform === 'darwin') {
		paths.push('/opt/homebrew/bin', '/usr/local/bin');
	}
	// Resolve against user-owned installation locations, never the current workspace.
	const isExecutable = async (file: string) => {
		try {
			await access(file, constants.X_OK);
			return (await stat(file)).isFile();
		} catch {
			return false;
		}
	};
	for (const command of provider.commands) {
		const executable = await findExecutable(command, home, paths, env, isExecutable);
		if (executable) {
			return executable;
		}
	}
	if (id === 'codex' && process.platform === 'darwin') {
		return findExecutable('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', home, paths, env, isExecutable);
	}
	return undefined;
}

export function spawnProviderCommand(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd = homedir(), stdio: SpawnOptions['stdio'] = ['ignore', 'pipe', 'pipe']): ChildProcess {
	const options: SpawnOptions = { cwd, env, stdio, windowsHide: true };
	if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
		// The arguments all come from the provider definitions. Pass the path through an
		// environment variable to keep spaces and shell characters in the path literal.
		return spawn(env.ComSpec || 'cmd.exe', ['/d', '/s', '/v:off', '/c', `""%ORBYTE_PROVIDER_EXECUTABLE%" ${args.join(' ')}"`], {
			...options, windowsVerbatimArguments: true, env: { ...env, ORBYTE_PROVIDER_EXECUTABLE: executable },
		});
	}
	return spawn(executable, args, options);
}

export function interpretProviderAuth(id: LocalAICliProviderId, exitCode: number | null, output: string): LocalAIProviderAuthState {
	const text = removeAnsiEscapeCodes(output).trim();
	if (id === 'claude') {
		try {
			const result = JSON.parse(text) as { loggedIn?: unknown };
			if (exitCode === 0 && result.loggedIn === true) {
				return 'signedIn';
			}
			if (result.loggedIn === false) {
				return 'signedOut';
			}
		} catch {
			// An unsupported auth command or failed probe does not prove sign-out.
		}
	} else {
		if (/\b(?:not (?:logged|signed) in|not authenticated|unauthenticated|aren['’]t (?:logged|signed) in)\b/i.test(text)) {
			return 'signedOut';
		}
		if (exitCode === 0) {
			return 'signedIn';
		}
	}
	return 'unknown';
}

export async function checkProviderAuth(id: LocalAICliProviderId, executable: string, env: NodeJS.ProcessEnv): Promise<LocalAIProviderAuthState> {
	return new Promise(resolve => {
		const child = spawnProviderCommand(executable, getExternalAIProvider(id).statusArgs, env);
		let stdout = '';
		let stderr = '';
		child.stdout?.setEncoding('utf8').on('data', text => { stdout = (stdout + text).slice(-8192); });
		child.stderr?.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-8192); });
		const timer = setTimeout(() => {
			child.kill();
			resolve('unknown');
		}, 5000);
		child.once('error', () => { clearTimeout(timer); resolve('unknown'); });
		child.once('close', code => {
			clearTimeout(timer);
			resolve(interpretProviderAuth(id, code, id === 'claude' ? stdout : `${stdout}\n${stderr}`));
		});
	});
}
