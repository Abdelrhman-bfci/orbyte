/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type LocalAIAgentStreamStage = 'planner' | 'implementer' | 'reviewer' | 'tester' | 'integrationTester';

export interface ILocalAIAgentStreamProgress {
	readonly receivedCharacters: number;
	/** A bounded, user-facing fragment. Machine-readable edits and source code are never returned. */
	readonly preview?: string;
}

const maximumPreviewCharacters = 180;

function decodeXmlText(value: string): string {
	return value
		.replace(/^\s*<!\[CDATA\[/, '')
		.replace(/\]\]>\s*$/, '')
		.replace(/<[^>]*>/g, ' ')
		.replaceAll('&quot;', '"')
		.replaceAll('&apos;', "'")
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&amp;', '&')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, maximumPreviewCharacters);
}

function lastTagText(value: string, tags: readonly string[]): string | undefined {
	let latest: { readonly index: number; readonly text: string } | undefined;
	for (const tag of tags) {
		const expression = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)(?:<\\/${tag}>|$)`, 'gi');
		for (let match = expression.exec(value); match; match = expression.exec(value)) {
			const text = decodeXmlText(match[1]);
			if (text && (!latest || match.index >= latest.index)) {
				latest = { index: match.index, text };
			}
		}
	}
	return latest?.text;
}

function lastAttribute(value: string, elements: readonly string[], attribute: string): string | undefined {
	let latest: { readonly index: number; readonly text: string } | undefined;
	for (const element of elements) {
		const expression = new RegExp(`<${element}\\b[^>]*\\b${attribute}="([^"]*)"`, 'gi');
		for (let match = expression.exec(value); match; match = expression.exec(value)) {
			const text = decodeXmlText(match[1]);
			if (text && (!latest || match.index >= latest.index)) {
				latest = { index: match.index, text };
			}
		}
	}
	return latest?.text;
}

/**
 * Produces a safe live preview from a partially streamed agent protocol response.
 * Only descriptive protocol fields are surfaced. File contents, replacements and
 * other machine-readable edit payloads stay private until the normal parser runs.
 */
export function getLocalAIAgentStreamProgress(stage: LocalAIAgentStreamStage, value: string): ILocalAIAgentStreamProgress {
	let preview: string | undefined;
	switch (stage) {
		case 'planner':
			preview = lastAttribute(value, ['task'], 'title')
				?? lastTagText(value, ['step', 'instruction', 'path']);
			break;
		case 'implementer':
			preview = lastTagText(value, ['summary'])
				?? lastAttribute(value, ['create', 'edit', 'insert', 'file'], 'uri');
			break;
		case 'reviewer':
			preview = lastTagText(value, ['summary', 'issue']);
			break;
		case 'tester':
		case 'integrationTester':
			preview = lastTagText(value, ['check', 'blocker', 'command']);
			break;
	}

	return { receivedCharacters: value.length, preview };
}
