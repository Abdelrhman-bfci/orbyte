/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { checkLocalAIFileSyntax } from '../../electron-main/localAISyntaxCheck.js';

suite('Orbyte Local Agent syntax checks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports a compiler error for a proposed JavaScript edit', async () => {
		const result = await checkLocalAIFileSyntax({ path: 'src/feature.js', originalContent: 'export const value = 1;', content: 'export const value = ;' });
		assert.strictEqual(result.status, 'failed');
		assert.match(result.diagnostic, /Unexpected token/);
	});

	test('parses JavaScript and TypeScript without executing the proposal', async () => {
		assert.deepStrictEqual(await checkLocalAIFileSyntax({ path: 'feature.js', content: 'throw new Error("Do not execute this");' }), { status: 'passed' });
		assert.deepStrictEqual(await checkLocalAIFileSyntax({ path: 'typescript.ts', content: 'export const value: number = 1;' }), { status: 'passed' });
	});

	test('passes package manifests and ignores inherited parser failures', async () => {
		assert.strictEqual((await checkLocalAIFileSyntax({ path: 'package.json', content: '{"name":"example"}' })).status, 'passed');
		assert.strictEqual((await checkLocalAIFileSyntax({ path: 'package.json', content: '{', originalContent: '{' })).status, 'skipped');
		assert.strictEqual((await checkLocalAIFileSyntax({ path: 'package.json', content: '{' })).status, 'failed');
	});
});
