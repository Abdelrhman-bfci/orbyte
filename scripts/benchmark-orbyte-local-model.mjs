/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Usage: node scripts/benchmark-orbyte-local-model.mjs http://127.0.0.1:8080
// Launch llama-server with --jinja and the GGUF model to measure before running this script.

import { performance } from 'node:perf_hooks';

const server = new URL(process.argv[2] ?? 'http://127.0.0.1:8080');
if (server.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(server.hostname)) {
	throw new Error('Use a locally running llama-server URL.');
}

const editSchema = {
	type: 'object',
	properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } },
	required: ['path', 'search', 'replace'],
	additionalProperties: false,
};
const readTool = {
	type: 'function',
	function: {
		name: 'read_file', description: 'Read one file by its relative path.',
		parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
	},
};

async function complete(messages, options = {}) {
	const response = await fetch(new URL('/v1/chat/completions', server), {
		method: 'POST',
		redirect: 'error',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model: 'local', messages, max_tokens: 384, temperature: 0, stream: false, ...options }),
		signal: AbortSignal.timeout(90_000),
	});
	if (!response.ok) {
		throw new Error(`llama-server returned HTTP ${response.status}`);
	}
	return (await response.json()).choices[0].message;
}

async function structuredEdit(prompt, path, search, replace) {
	const message = await complete([
		{ role: 'system', content: 'Return a single JSON edit with path, exact search text, and replacement text.' },
		{ role: 'user', content: prompt },
	], { response_format: { type: 'json_schema', json_schema: { name: 'file_edit', schema: editSchema, strict: true } } });
	const edit = JSON.parse(message.content);
	return Object.keys(edit).length === 3 && edit.path === path && edit.search === search && edit.replace === replace;
}

async function toolRoundTrip(path, value) {
	const messages = [
		{ role: 'system', content: 'Read the specified file with read_file, then return only the value it contains.' },
		{ role: 'user', content: `Read ${path} and report its value.` },
	];
	const options = { tools: [readTool] };
	const message = await complete(messages, options);
	const calls = message.tool_calls ?? [];
	const call = calls[0];
	if (calls.length !== 1 || call.function.name !== 'read_file' || !call.id) {
		throw new Error('Expected one read_file tool call with an ID.');
	}
	const args = JSON.parse(call.function.arguments);
	if (Object.keys(args).length !== 1 || args.path !== path) {
		throw new Error('The tool arguments did not match the requested path.');
	}
	// Fixed fixture output. The benchmark never opens a path chosen by the model.
	const answer = await complete([...messages, { role: 'assistant', content: message.content ?? '', tool_calls: calls }, { role: 'tool', tool_call_id: call.id, content: value }], options);
	return answer.content?.trim() === value;
}

const cases = [
	['Structured edit', () => structuredEdit('config.js contains exactly `const port = 8080;`. Set the port to 3000. Use the entire statement for search and replace.', 'config.js', 'const port = 8080;', 'const port = 3000;')],
	['Repair from syntax feedback', () => structuredEdit('feature.js contains exactly `const value = 1;`. The previous replacement `const value = ;` failed with SyntaxError: Unexpected token ;. Correct the proposal so value is 2. Use the entire statement for search and replace.', 'feature.js', 'const value = 1;', 'const value = 2;')],
	['Tool call and tool result (configuration)', () => toolRoundTrip('settings/build-version.txt', 'ORBYTE-1742')],
	['Tool call and tool result (nested fixture)', () => toolRoundTrip('packages/api/fixtures/token.txt', 'TULIP-8136')],
];

let passed = 0;
for (const [name, run] of cases) {
	const start = performance.now();
	let detail = '';
	try {
		if (await run()) {
			passed++;
			detail = 'PASS';
		} else {
			detail = 'FAIL — result did not match the fixture';
		}
	} catch (error) {
		detail = `FAIL — ${error.message}`;
	}
	console.log(`${name}: ${detail} (${((performance.now() - start) / 1000).toFixed(2)} s)`);
}
console.log(`${passed}/${cases.length} passed`);
process.exitCode = passed === cases.length ? 0 : 1;
