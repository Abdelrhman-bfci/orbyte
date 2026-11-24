/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getExternalAIProvider, interpretProviderAuth } from '../../electron-main/localAIProviders.js';

suite('Orbyte AI provider authentication', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('checks Codex CLI authentication, not just installation', () => {
		assert.strictEqual(interpretProviderAuth('codex', 0, 'Logged in using ChatGPT'), 'signedIn');
		assert.strictEqual(interpretProviderAuth('codex', 1, 'Not logged in'), 'signedOut');
		assert.strictEqual(interpretProviderAuth('codex', 1, 'Cannot read credentials'), 'unknown');
	});

	test('distinguishes Claude sign-out from an unavailable status command', () => {
		assert.strictEqual(interpretProviderAuth('claude', 0, '{"loggedIn":true}'), 'signedIn');
		assert.strictEqual(interpretProviderAuth('claude', 1, '{"loggedIn":false}'), 'signedOut');
		assert.strictEqual(interpretProviderAuth('claude', 1, 'Error reading credentials'), 'unknown');
	});

	test('external chat uses proposal modes compatible with Orbyte review', () => {
		assert.ok(getExternalAIProvider('codex').chatArgs.includes('read-only'));
		assert.ok(getExternalAIProvider('claude').chatArgs.includes('--tools='));
		assert.ok(getExternalAIProvider('claude').chatArgs.includes('mcp__*'));
	});
});
