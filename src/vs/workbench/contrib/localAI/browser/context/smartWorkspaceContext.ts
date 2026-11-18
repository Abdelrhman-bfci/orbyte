/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const smartContextStopWords = new Set([
	'a', 'add', 'an', 'and', 'change', 'code', 'create', 'delete', 'directory', 'edit', 'file', 'files', 'fix', 'folder', 'for', 'from', 'implement', 'in', 'inside',
	'into', 'like', 'make', 'module', 'new', 'of', 'on', 'other', 'package', 'please', 'project', 'remove', 'same', 'source', 'src', 'that', 'the', 'this', 'to', 'update', 'want',
	'with', 'java', 'python', 'typescript', 'javascript', 'xml', 'json', 'yaml', 'yml',
]);

export function localAIContextTokens(value: string): Set<string> {
	return new Set(value
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(token => token.length >= 3 && !smartContextStopWords.has(token)));
}

function compactIdentifier(value: string): string {
	return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function promptIdentifierCompacts(value: string): Set<string> {
	const words = value
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.toLowerCase()
		.split(/[^a-z0-9]+/);
	const candidates = new Set<string>();
	let segment: string[] = [];
	const addSegment = () => {
		for (let start = 0; start < segment.length; start++) {
			let candidate = '';
			for (let end = start; end < Math.min(segment.length, start + 4); end++) {
				candidate += segment[end];
				candidates.add(candidate);
			}
		}
		segment = [];
	};
	for (const word of words) {
		if (word.length < 2 || smartContextStopWords.has(word)) {
			addSegment();
		} else {
			segment.push(word);
		}
	}
	addSegment();
	return candidates;
}

function nameWithoutExtension(value: string): string {
	const extensionIndex = value.indexOf('.');
	return extensionIndex > 0 ? value.slice(0, extensionIndex) : value;
}

export interface ILocalAIWorkspacePathScoreOptions {
	readonly folderRequested?: boolean;
	readonly open?: boolean;
}

/** Scores a workspace file using explicit names, natural-language type names, path hints, and build intent. */
export function scoreLocalAIWorkspacePath(prompt: string, path: string, options: ILocalAIWorkspacePathScoreOptions = {}): number {
	const normalizedPrompt = prompt.toLowerCase().replaceAll('\\', '/');
	const rawPath = path.replaceAll('\\', '/');
	const rawFileName = rawPath.slice(rawPath.lastIndexOf('/') + 1);
	const normalizedPath = rawPath.toLowerCase();
	const fileName = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
	const stem = nameWithoutExtension(fileName);
	const rawStem = nameWithoutExtension(rawFileName);
	const promptTokens = localAIContextTokens(prompt);
	const fileTokens = localAIContextTokens(rawFileName);
	const pathTokens = localAIContextTokens(rawPath.slice(0, Math.max(0, rawPath.length - rawFileName.length)));
	const compactPrompt = compactIdentifier(prompt);
	const compactStem = compactIdentifier(rawStem);
	const promptIdentifiers = promptIdentifierCompacts(prompt);
	const hasMoreSpecificIdentifier = [...promptIdentifiers].some(identifier => identifier.length > compactStem.length && (identifier.startsWith(compactStem) || identifier.endsWith(compactStem)));
	let score = 0;

	if (normalizedPath.length >= 4 && normalizedPrompt.includes(normalizedPath)) {
		score += 320;
	}
	if (fileName.length >= 4 && normalizedPrompt.includes(fileName)) {
		score += 280;
	}
	if (stem.length >= 4 && normalizedPrompt.includes(stem) && !hasMoreSpecificIdentifier) {
		score += 220;
	}
	// Prefer the most specific named symbol while matching both "EmployeeService" and "employee service" without @.
	if (compactStem.length >= 5 && promptIdentifiers.has(compactStem) && !hasMoreSpecificIdentifier) {
		score += Math.min(960, 320 + compactStem.length * 32);
	} else if (compactStem.length >= 5 && !promptIdentifiers.has(compactStem) && compactPrompt.includes(compactStem)) {
		score += 240;
	}
	for (const token of fileTokens) {
		if (promptTokens.has(token)) {
			score += 70;
		}
	}
	for (const token of pathTokens) {
		if (promptTokens.has(token)) {
			score += options.folderRequested ? 60 : 28;
		}
	}

	if (/\b(maven|pom)\b/i.test(prompt) && fileName === 'pom.xml') {
		score += 260;
	}
	if (/\bgradle\b/i.test(prompt) && /^(build|settings)\.gradle(?:\.kts)?$/.test(fileName)) {
		score += 260;
	}
	if (/\b(dependency|dependencies|build tool)\b/i.test(prompt) && /^(pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/.test(fileName)) {
		score += 180;
	}
	if (/\b(config|configuration|properties)\b/i.test(prompt) && /^application(?:-[^.]+)?\.(?:properties|ya?ml)$/.test(fileName)) {
		score += 180;
	}

	const asksForTests = [...promptTokens].some(token => token === 'test' || token === 'tests' || token === 'testing' || token === 'spec');
	const isTestFile = /(^|\/)(test|tests|__tests__)(\/|$)/.test(normalizedPath) || /(?:test|tests|spec)\.[^.]+$/.test(fileName);
	if (isTestFile && !asksForTests) {
		score -= 180;
	} else if (isTestFile && asksForTests) {
		score += 100;
	}
	if (options.open && score > 0) {
		score += 20;
	}
	return score;
}
