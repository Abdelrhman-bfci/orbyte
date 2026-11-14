/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILocalLLMChatMessage } from '../../../../../platform/localLLM/common/localLLM.js';
import { ILocalAIContext } from './localAIContext.js';

const modelContextTokens = 8192;
const reservedGenerationTokens = 3072;
const approximateCharactersPerToken = 3;
const inputCharacterBudget = (modelContextTokens - reservedGenerationTokens) * approximateCharactersPerToken;
const maximumRequestCharacters = 4000;
const maximumAttachmentCharacters = 9000;

export type LocalAIChatMode = 'ask' | 'plan' | 'agent';

export interface ILocalAIAttachment {
	readonly uri: string;
	readonly name: string;
	readonly content: string;
}

function escapeAttribute(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function cdata(value: string): string {
	return `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

function activeFileWindow(context: ILocalAIContext, maximumCharacters: number): string {
	if (context.content.length <= maximumCharacters) {
		return context.content;
	}

	const lines = context.content.split(/\r?\n/);
	const cursorIndex = Math.max(0, context.cursor.lineNumber - 1);
	let start = cursorIndex;
	let end = cursorIndex + 1;
	let count = lines[cursorIndex]?.length ?? 0;
	while (count < maximumCharacters && (start > 0 || end < lines.length)) {
		if (start > 0) {
			count += lines[--start].length + 1;
		}
		if (count < maximumCharacters && end < lines.length) {
			count += lines[end++].length + 1;
		}
	}
	return lines.slice(start, end).join('\n');
}

export function formatContextXml(context: ILocalAIContext, maximumCharacters = inputCharacterBudget): string {
	const rootStart = `<local_code_context token_budget="${modelContextTokens}">\n`;
	const rootEnd = '\n</local_code_context>';
	const sections: string[] = [];
	let remaining = Math.max(0, maximumCharacters - rootStart.length - rootEnd.length);
	const appendTextElement = (start: string, content: string, end: string): void => {
		if (remaining <= start.length + end.length + cdata('').length) {
			return;
		}

		let boundedContent = content.slice(0, remaining - start.length - end.length - cdata('').length);
		let element = `${start}${cdata(boundedContent)}${end}`;
		if (element.length > remaining) {
			boundedContent = boundedContent.slice(0, Math.max(0, boundedContent.length - (element.length - remaining)));
			element = `${start}${cdata(boundedContent)}${end}`;
		}
		if (element.length <= remaining) {
			sections.push(element);
			remaining -= element.length;
		}
	};
	const appendRawElement = (start: string, items: readonly string[], end: string): void => {
		if (remaining < start.length + end.length) {
			return;
		}
		const included: string[] = [];
		let length = start.length + end.length;
		for (const item of items) {
			if (length + item.length > remaining) {
				break;
			}
			included.push(item);
			length += item.length;
		}
		if (included.length) {
			const element = `${start}${included.join('')}${end}`;
			sections.push(element);
			remaining -= element.length;
		}
	};

	appendTextElement(
		`<active_file uri="${escapeAttribute(context.uri)}" language="${escapeAttribute(context.languageId)}" cursor_line="${context.cursor.lineNumber}" cursor_column="${context.cursor.column}">\n`,
		activeFileWindow(context, Math.min(14_000, remaining)),
		'\n</active_file>'
	);
	if (context.selectedText) {
		appendTextElement(
			`\n<selection start_line="${context.selection.startLineNumber}" start_column="${context.selection.startColumn}" end_line="${context.selection.endLineNumber}" end_column="${context.selection.endColumn}">\n`,
			context.selectedText,
			'\n</selection>'
		);
	}
	if (context.diagnostics.length) {
		appendRawElement(
			'\n<diagnostics>\n',
			context.diagnostics.map(diagnostic => `<diagnostic severity="${diagnostic.severity}" line="${diagnostic.range.startLineNumber}" source="${escapeAttribute(diagnostic.source ?? '')}">${cdata(diagnostic.message)}</diagnostic>\n`),
			'</diagnostics>'
		);
	}
	if (context.openTabs.length) {
		appendRawElement(
			'\n<open_tabs>\n',
			context.openTabs.map(uri => `<tab uri="${escapeAttribute(uri)}" />\n`),
			'</open_tabs>'
		);
	}
	for (const chunk of context.symbolChunks) {
		appendTextElement(
			`\n<symbol_scope uri="${escapeAttribute(chunk.uri)}" name="${escapeAttribute(chunk.symbol ?? '')}" start_line="${chunk.startLineNumber}" end_line="${chunk.endLineNumber}">\n`,
			chunk.content,
			'\n</symbol_scope>'
		);
	}

	return `${rootStart}${sections.join('')}${rootEnd}`;
}

function formatAttachmentsXml(attachments: readonly ILocalAIAttachment[]): string {
	if (!attachments.length) {
		return '';
	}

	const sections: string[] = [];
	let remaining = maximumAttachmentCharacters;
	for (const attachment of attachments) {
		const start = `<attached_file uri="${escapeAttribute(attachment.uri)}" name="${escapeAttribute(attachment.name)}">\n`;
		const end = '\n</attached_file>';
		const available = remaining - start.length - end.length - cdata('').length;
		if (available <= 0) {
			break;
		}
		const content = attachment.content.slice(0, available);
		const section = `${start}${cdata(content)}${end}`;
		sections.push(section);
		remaining -= section.length;
	}

	return sections.length ? `<attached_files>\n${sections.join('\n')}\n</attached_files>` : '';
}

function modeSystemPrompt(mode: LocalAIChatMode): string {
	switch (mode) {
		case 'plan':
			return 'You are Qwen2.5-Coder running locally inside an offline code editor in Plan mode. Analyze the supplied context and produce a concise, ordered implementation plan. Identify affected files, risks, and verification steps. Do not provide replacement code or claim that changes were applied.';
		case 'agent':
			return `You are Qwen2.5-Coder running locally inside an offline code editor in Agent mode. Edit one or more supplied files. Return only this machine-readable XML and no Markdown:\n<local_ai_agent_response>\n<summary>A short user-facing description with no code</summary>\n<changes>\n<file uri="exact active_file uri or attached_file uri"><![CDATA[complete replacement file content]]></file>\n</changes>\n</local_ai_agent_response>\nInclude one file element per changed file. Use only exact URIs present in active_file or attached_file elements. Always return the complete file, including unchanged code. Never expose code in the summary. If no edit is needed, return an empty changes element.`;
		default:
			return 'You are Qwen2.5-Coder running locally inside an offline code editor in Ask mode. Answer questions using the supplied context. Be precise, explain relevant code clearly, and do not claim to edit files. Use fenced code blocks only for illustrative code.';
	}
}

export function formatChatMessages(context: ILocalAIContext | undefined, request: string, history: readonly ILocalLLMChatMessage[] = [], mode: LocalAIChatMode = 'ask', attachments: readonly ILocalAIAttachment[] = []): readonly ILocalLLMChatMessage[] {
	const boundedRequest = request.slice(0, maximumRequestCharacters);
	const maximumHistoryCharacters = 6000;
	const boundedHistory: ILocalLLMChatMessage[] = [];
	let historyCharacters = 0;
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index];
		const remaining = maximumHistoryCharacters - historyCharacters;
		if (remaining <= 0) {
			break;
		}
		boundedHistory.unshift({ role: message.role, content: message.content.slice(-remaining) });
		historyCharacters += Math.min(message.content.length, remaining);
	}
	const attachmentsXml = formatAttachmentsXml(attachments);
	const contextBudget = Math.max(2000, inputCharacterBudget - maximumRequestCharacters - historyCharacters - attachmentsXml.length - 1000);
	const contextXml = context ? formatContextXml(context, contextBudget) : '<local_code_context />';
	return [
		{
			role: 'system',
			content: modeSystemPrompt(mode),
		},
		...boundedHistory,
		{
			role: 'user',
			content: `${contextXml}${attachmentsXml ? `\n${attachmentsXml}` : ''}\n<user_request>${cdata(boundedRequest)}</user_request>`,
		},
	];
}

export function formatInlineEditMessages(context: ILocalAIContext, instruction: string, editTarget?: string): readonly ILocalLLMChatMessage[] {
	const boundedInstruction = instruction.slice(0, 2000);
	const target = (editTarget ?? (context.selectedText || context.symbolChunks[0]?.content || context.content)).slice(0, 8000);
	return [
		{
			role: 'system',
			content: 'You are a code editing engine. Return only the complete replacement text for the edit target. Do not use Markdown fences and do not explain the change.',
		},
		{
			role: 'user',
			content: `${formatContextXml(context, inputCharacterBudget - target.length - boundedInstruction.length - 1500)}\n<edit_instruction>${cdata(boundedInstruction)}</edit_instruction>\n<edit_target>${cdata(target)}</edit_target>`,
		},
	];
}

export function formatChatML(messages: readonly ILocalLLMChatMessage[]): string {
	return messages.map(message => `<|im_start|>${message.role}\n${message.content}<|im_end|>\n`).join('') + '<|im_start|>assistant\n';
}

export function formatFimPrompt(prefix: string, suffix: string, contextXml?: string): string {
	const boundedContext = contextXml?.slice(0, 4000);
	const codeBudget = inputCharacterBudget - (boundedContext?.length ?? 0) - 100;
	const prefixBudget = Math.floor(codeBudget * 0.7);
	const boundedPrefix = prefix.slice(-prefixBudget);
	const boundedSuffix = suffix.slice(0, codeBudget - boundedPrefix.length);
	const contextualPrefix = boundedContext ? `${boundedContext}\n${boundedPrefix}` : boundedPrefix;
	return `<|fim_prefix|>${contextualPrefix}<|fim_suffix|>${boundedSuffix}<|fim_middle|>`;
}
