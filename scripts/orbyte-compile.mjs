/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const runner = path.join(repositoryRoot, 'node_modules', 'npm-run-all2', 'bin', 'npm-run-all', 'index.js');

if (!existsSync(runner)) {
	console.log('[Orbyte] Development dependencies are incomplete; repairing them before compilation...');

	let install;
	if (process.platform === 'win32') {
		console.log('[Orbyte] Running the complete Windows prerequisite setup...');
		// Use a path relative to cwd. Embedding a quoted absolute path in the /c
		// argument makes Node escape the quotes on Windows, so cmd.exe sees the
		// literal characters \"...\" and rejects the command.
		install = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'scripts\\setup-windows.cmd'], {
			cwd: repositoryRoot,
			env: process.env,
			stdio: 'inherit',
		});
	} else {
		const blockedEnvironmentKeys = new Set(['node_env', 'npm_config_production', 'pnpm_config_prod']);
		const installEnvironment = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !blockedEnvironmentKeys.has(key.toLowerCase()))
		);
		install = spawnSync('pnpm', ['install', '--frozen-lockfile', '--prod=false'], {
			cwd: repositoryRoot,
			env: installEnvironment,
			stdio: 'inherit',
		});
	}

	if (install.error || install.status !== 0) {
		console.error('[Orbyte] Could not prepare the required compiler toolchain and development dependencies.');
		console.error('[Orbyte] On Windows, run scripts\\setup-windows.cmd from an Administrator Command Prompt.');
		process.exit(install.status || 1);
	}
}

if (!existsSync(runner)) {
	console.error('[Orbyte] npm-run-all2 is still missing after dependency repair.');
	console.error('[Orbyte] Ensure NODE_ENV is not set to production, then run scripts\\setup-windows.cmd.');
	process.exit(1);
}

const compile = spawnSync(process.execPath, [runner, '-lp', 'compile-client', 'compile-copilot'], {
	cwd: repositoryRoot,
	stdio: 'inherit',
});

if (compile.error) {
	console.error(`[Orbyte] Failed to start the compiler: ${compile.error.message}`);
}

process.exit(compile.status ?? 1);
