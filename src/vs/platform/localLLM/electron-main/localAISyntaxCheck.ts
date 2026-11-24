/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { homedir } from 'os';
import { delimiter, extname, isAbsolute } from 'path';
import { findExecutable } from '../../../base/node/processes.js';
import { ILocalAISyntaxCheck, ILocalAISyntaxResult } from '../common/localLLM.js';

function checkJavaScript(source: string, extension: string): Promise<string | undefined | null> {
	const commonJS = extension === '.cjs' || extension === '.cts';
	const script = `const { readFileSync } = require('node:fs');
const { Script, SourceTextModule } = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
try {
	let source = readFileSync(0, 'utf8');
	if (${['.ts', '.mts', '.cts'].includes(extension)}) {
		source = stripTypeScriptTypes(source, { mode: 'transform' });
	}
	if (${commonJS}) {
		new Script(require('node:module').wrap(source.replace(/^#![^\\r\\n]*/, '')));
	} else {
		new SourceTextModule(source);
	}
} catch (error) {
	process.stdout.write(error.message);
	process.exitCode = 1;
}`;
	return runSyntaxCheck(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', script], source, {
		...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined, NODE_PATH: undefined, NODE_COMPILE_CACHE: undefined,
	});
}

async function checkPython(source: string): Promise<string | undefined | null> {
	const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path');
	const paths = (pathKey && process.env[pathKey] || '').split(delimiter).filter(isAbsolute);
	const command = process.platform === 'win32' ? 'python.exe' : 'python3';
	const executable = await findExecutable(command, homedir(), paths, process.env);
	if (!executable || /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(executable)) {
		return null;
	}
	const script = `import sys
try:
    compile(sys.stdin.buffer.read(), '<proposal>', 'exec')
except (SyntaxError, ValueError) as error:
    sys.stdout.write(getattr(error, 'msg', str(error)))
    sys.exit(1)`;
	return runSyntaxCheck(executable, ['-I', '-S', '-c', script], source, process.env);
}

function runSyntaxCheck(executable: string, args: readonly string[], source: string, env: NodeJS.ProcessEnv): Promise<string | undefined | null> {
	return new Promise(resolve => {
		// The input is only parsed. The worker never imports or evaluates the proposed code.
		const child = spawn(executable, args, {
			cwd: homedir(),
			env,
			stdio: ['pipe', 'pipe', 'ignore'],
			windowsHide: true,
		});
		let diagnostic = '';
		child.stdout.setEncoding('utf8').on('data', chunk => { diagnostic = (diagnostic + chunk).slice(0, 600); });
		child.stdin.on('error', () => { /* The checker can exit before reading stdin. */ });
		child.stdin.end(source);
		const timer = setTimeout(() => { child.kill(); resolve(null); }, 5000);
		child.once('error', () => { clearTimeout(timer); resolve(null); });
		child.once('close', code => { clearTimeout(timer); resolve(code === 0 ? undefined : diagnostic || null); });
	});
}

export async function checkLocalAIFileSyntax(file: ILocalAISyntaxCheck): Promise<ILocalAISyntaxResult> {
	const extension = extname(file.path).toLowerCase();
	if (file.content.length > 256 * 1024 || (file.originalContent?.length ?? 0) > 256 * 1024) {
		return { status: 'skipped' };
	}
	let check: (source: string) => Promise<string | undefined | null>;
	if (file.path.split(/[\\/]/).at(-1) === 'package.json') {
		check = async source => {
			try {
				JSON.parse(source.replace(/^\uFEFF/, ''));
				return undefined;
			} catch {
				return 'Invalid JSON in package.json.';
			}
		};
	} else if (['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'].includes(extension)) {
		check = source => checkJavaScript(source, extension);
	} else if (extension === '.py') {
		check = checkPython;
	} else {
		return { status: 'skipped' };
	}
	const diagnostic = await check(file.content);
	if (diagnostic === null) {
		return { status: 'skipped' };
	}
	if (diagnostic === undefined) {
		return { status: 'passed' };
	}
	if (file.originalContent !== undefined && await check(file.originalContent) === diagnostic) {
		return { status: 'skipped' };
	}
	return { status: 'failed', diagnostic };
}
