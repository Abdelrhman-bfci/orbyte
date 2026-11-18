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

export interface ILocalAIWorkspaceRootContext {
	readonly uri: string;
	readonly name: string;
	readonly files: readonly string[];
}

export interface ILocalAIAgentPlannerTarget {
	readonly uri: string;
	readonly displayPath: string;
}

/** A bounded unit of work that can be given to one feature subagent. */
export interface ILocalAIAgentFeatureTask {
	readonly id: string;
	readonly title: string;
	readonly instruction: string;
	readonly paths: readonly string[];
	readonly dependsOn?: readonly string[];
	readonly needsTests: boolean;
}

export function isNewSourceCreationRequest(value: string): boolean {
	const requestsCreation = /\b(add|create|generate|implement|introduce|new)\b/i.test(value);
	const namesArtifactKind = /\b(class|controller|dto|entity|file|interface|model|repository|service)\b/i.test(value);
	const namesCamelCaseArtifact = /\b[A-Za-z_][A-Za-z0-9_]*(?:Service|Controller|Dto|DTO|Entity|Interface|Model|Repository)\b/.test(value);
	return requestsCreation && (namesArtifactKind || namesCamelCaseArtifact);
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

function formatWorkspaceRootsXml(roots: readonly ILocalAIWorkspaceRootContext[]): string {
	if (!roots.length) {
		return '';
	}
	const maximumCharacters = 6000;
	let remaining = maximumCharacters;
	const sections: string[] = [];
	for (const root of roots) {
		const start = `<workspace_root uri="${escapeAttribute(root.uri)}" name="${escapeAttribute(root.name)}">\n`;
		const end = '</workspace_root>';
		if (remaining <= start.length + end.length) {
			break;
		}
		const paths: string[] = [];
		let length = start.length + end.length;
		for (const file of root.files) {
			const item = `<file path="${escapeAttribute(file)}" />\n`;
			if (length + item.length > remaining) {
				break;
			}
			paths.push(item);
			length += item.length;
		}
		const section = `${start}${paths.join('')}${end}`;
		sections.push(section);
		remaining -= section.length;
	}
	return sections.length ? `<workspace_roots>\n${sections.join('\n')}\n</workspace_roots>` : '';
}

export function formatAgentPlannerMessages(request: string, roots: readonly ILocalAIWorkspaceRootContext[], targets: readonly ILocalAIAgentPlannerTarget[]): readonly ILocalLLMChatMessage[] {
	const boundedRequest = request.slice(0, maximumRequestCharacters);
	const rootsXml = formatWorkspaceRootsXml(roots);
	const knownTargets = targets.length
		? `<known_targets>\n${targets.map(target => `<target uri="${escapeAttribute(target.uri)}" path="${escapeAttribute(target.displayPath)}" />`).join('\n')}\n</known_targets>`
		: '<known_targets />';
	return [{
		role: 'system',
		content: 'You are the Planner subagent for an offline coding agent. Select the smallest set of relevant existing files and decide whether genuinely new files are required. Do not write code. Return concise XML only: <agent_plan><targets><target path="exact workspace-relative path" action="edit|create" /></targets><steps><step>short action</step></steps></agent_plan>. Use only paths present in workspace_roots or known_targets. Never use untitled: URIs or a workspace directory itself as a file target.',
	}, {
		role: 'user',
		content: `${rootsXml}\n${knownTargets}\n<user_request>${cdata(boundedRequest)}</user_request>`,
	}];
}

/**
 * Plans independent feature tasks for a fan-out Agent run. The result is kept
 * intentionally small so a local model cannot consume the implementation
 * context before the feature subagents receive it.
 */
export function formatAgentTaskPlannerMessages(request: string, roots: readonly ILocalAIWorkspaceRootContext[], targets: readonly ILocalAIAgentPlannerTarget[], maximumTasks = 6): readonly ILocalLLMChatMessage[] {
	const boundedRequest = request.slice(0, maximumRequestCharacters);
	const boundedMaximumTasks = Math.max(1, Math.min(8, Math.floor(maximumTasks)));
	const rootsXml = formatWorkspaceRootsXml(roots);
	const knownTargets = targets.length
		? `<known_targets>\n${targets.map(target => `<target uri="${escapeAttribute(target.uri)}" path="${escapeAttribute(target.displayPath)}" />`).join('\n')}\n</known_targets>`
		: '<known_targets />';
	return [{
		role: 'system',
		content: `You are the Lead Planner subagent for an offline coding agent. Split a large request into at most ${boundedMaximumTasks} cohesive feature tasks that can be implemented with isolated context. Tasks may run in parallel only when they do not edit the same file and have no dependency. Do not write code. Return concise XML only:\n<agent_task_plan>\n<task id="feature-1" title="short title" needs_tests="true|false">\n<instruction>one independently actionable requirement</instruction>\n<paths><path>exact workspace-relative file path</path></paths>\n<depends_on><task_id>feature-0</task_id></depends_on>\n</task>\n</agent_task_plan>\nUse stable unique task ids. Put every file in the smallest relevant task. A path may belong to only one parallel task; if two features must edit the same file, combine them or add a dependency. Use only paths present in workspace_roots or known_targets. Never target untitled: URIs or a workspace directory. Set needs_tests="true" for behavior changes.`,
	}, {
		role: 'user',
		content: `${rootsXml}\n${knownTargets}\n<user_request>${cdata(boundedRequest)}</user_request>`,
	}];
}

function formatFeatureTaskXml(task: ILocalAIAgentFeatureTask): string {
	const dependencies = task.dependsOn?.length
		? `<depends_on>${task.dependsOn.map(id => `<task_id>${cdata(id.slice(0, 120))}</task_id>`).join('')}</depends_on>`
		: '<depends_on />';
	return `<feature_task id="${escapeAttribute(task.id.slice(0, 120))}" title="${escapeAttribute(task.title.slice(0, 240))}" needs_tests="${task.needsTests}">\n<instruction>${cdata(task.instruction.slice(0, maximumRequestCharacters))}</instruction>\n<paths>${task.paths.slice(0, 12).map(path => `<path>${cdata(path.slice(0, 500))}</path>`).join('')}</paths>\n${dependencies}\n</feature_task>`;
}

/** Gives one implementer only the files and requirement for its feature task. */
export function formatAgentFeatureImplementerMessages(context: ILocalAIContext | undefined, request: string, task: ILocalAIAgentFeatureTask, attachments: readonly ILocalAIAttachment[], workspaceRoots: readonly ILocalAIWorkspaceRootContext[]): readonly ILocalLLMChatMessage[] {
	const base = formatChatMessages(context, task.instruction, [], 'agent', attachments, workspaceRoots);
	return [{
		role: 'system',
		content: `${base[0].content}\nYou are Feature Implementer ${task.id}. Work only on the supplied feature_task. You receive isolated context deliberately. Do not implement another feature, edit an attachment not listed in feature_task paths, or assume a dependency is complete unless it appears in the supplied file contents. Keep the standard local_ai_agent_response edit protocol.`,
	}, {
		role: 'user',
		content: `${base.at(-1)!.content}\n${formatFeatureTaskXml(task)}`,
	}];
}

/** Asks a focused reviewer for a verdict without giving it unrelated features. */
export function formatAgentFeatureReviewerMessages(request: string, task: ILocalAIAgentFeatureTask, candidateResponse: string, attachments: readonly ILocalAIAttachment[], concerns: readonly string[] = []): readonly ILocalLLMChatMessage[] {
	const attachmentsXml = formatAttachmentsXml(attachments);
	const concernsXml = concerns.length
		? `<known_concerns>${concerns.slice(0, 8).map(concern => `<concern>${cdata(concern.slice(0, 800))}</concern>`).join('')}</known_concerns>`
		: '<known_concerns />';
	return [{
		role: 'system',
		content: 'You are a focused Reviewer subagent. Review exactly one feature task for correctness, preservation of unrelated behavior, architectural placement, security, and missing tests. Do not implement code and do not review other features. Return XML only: <agent_feature_review task_id="exact id" verdict="approved|changes_required"><summary>short result</summary><issues><issue severity="error|warning">actionable issue</issue></issues></agent_feature_review>. Approve only when there is no error-level issue.',
	}, {
		role: 'user',
		content: `${formatFeatureTaskXml(task)}\n<parent_request>${cdata(request.slice(0, maximumRequestCharacters))}</parent_request>\n${attachmentsXml}\n<candidate_response>${cdata(candidateResponse.slice(0, 10_000))}</candidate_response>\n${concernsXml}`,
	}];
}

/** Performs bounded static test analysis and recommends executable commands. */
export function formatAgentTesterMessages(request: string, task: ILocalAIAgentFeatureTask, candidateResponse: string, attachments: readonly ILocalAIAttachment[], availableCommands: readonly string[] = []): readonly ILocalLLMChatMessage[] {
	const attachmentsXml = formatAttachmentsXml(attachments);
	const commandsXml = availableCommands.length
		? `<available_commands>${availableCommands.slice(0, 12).map(command => `<command>${cdata(command.slice(0, 500))}</command>`).join('')}</available_commands>`
		: '<available_commands />';
	return [{
		role: 'system',
		content: 'You are a Tester subagent for one isolated feature. Statically inspect the supplied current files and candidate changes, identify the smallest relevant tests, and recommend commands from available_commands. Never claim that a command ran; the orchestrator executes commands separately. Return XML only: <agent_test_plan task_id="exact id" status="ready|blocked"><checks><check>specific behavior to verify</check></checks><commands><command>exact allowed command</command></commands><missing_test_files><path>workspace-relative path only when a new or updated test is required</path></missing_test_files><blocker>empty or concise blocker</blocker></agent_test_plan>. Do not inspect or test unrelated features.',
	}, {
		role: 'user',
		content: `${formatFeatureTaskXml(task)}\n<parent_request>${cdata(request.slice(0, maximumRequestCharacters))}</parent_request>\n${attachmentsXml}\n<candidate_response>${cdata(candidateResponse.slice(0, 10_000))}</candidate_response>\n${commandsXml}`,
	}];
}

export function formatAgentRepairMessages(context: ILocalAIContext | undefined, request: string, invalidResponse: string, errors: readonly string[], attachments: readonly ILocalAIAttachment[], workspaceRoots: readonly ILocalAIWorkspaceRootContext[]): readonly ILocalLLMChatMessage[] {
	const base = formatChatMessages(context, request, [], 'agent', attachments, workspaceRoots);
	const feedback = errors.length ? errors.slice(0, 6).join('\n') : 'The response contained no usable edit or create operation.';
	const malformedJavaRepair = errors.some(error => error.includes('Existing Java target is structurally invalid'));
	if (malformedJavaRepair) {
		const repairUri = /complete <file> repair for this URI:\s*(\S+)/.exec(feedback)?.[1]
			?? attachments.find(attachment => attachment.name.toLowerCase().endsWith('.java'))?.uri
			?? '';
		return [{
			role: 'system',
			content: 'You are the Reviewer subagent for an offline Java coding agent. The existing Java target is structurally invalid, so partial edits cannot be applied safely. Return only one machine-readable XML response with this exact shape: <local_ai_agent_response><summary>short repair summary</summary><changes><file uri="EXACT_REQUIRED_URI"><![CDATA[complete corrected Java file]]></file></changes></local_ai_agent_response>. You MUST return exactly one file operation and no edit, insert, or create operations. Preserve the package, public type name, annotations, intended public API, and unrelated valid behavior. Correct brace placement, imports, field placement, method placement, and collection initialization. Never use an untitled URI or a directory URI. Do not include Markdown or any text outside the XML.',
		}, {
			role: 'user',
			content: `${base.at(-1)!.content}\n<required_file_uri>${cdata(repairUri)}</required_file_uri>\n<reviewer_feedback>${cdata(feedback)}</reviewer_feedback>\nRepair the attached Java file completely. Copy required_file_uri exactly into the single file operation. Do not repeat or imitate the invalid partial edits.`,
		}];
	}
	const reviewerSystem: ILocalLLMChatMessage = {
		role: 'system',
		content: `${base[0].content}\nYou are the Reviewer subagent. Correct the invalid implementer operations using only exact existing target URIs. Return one corrected <local_ai_agent_response> and no explanation.`,
	};
	return [
		reviewerSystem,
		base.at(-1)!,
		{ role: 'assistant', content: invalidResponse.slice(0, 12_000) },
		{
			role: 'user',
			content: `<reviewer_feedback>${cdata(feedback)}</reviewer_feedback>\nYou are the Reviewer subagent. Repair the implementer response using the exact allowed URIs and current file contents above. Return one corrected <local_ai_agent_response> only. Do not explain the error, use untitled: URIs, target a directory, or use Python before_main insertion for Java.`,
		},
	];
}

function modeSystemPrompt(mode: LocalAIChatMode): string {
	switch (mode) {
		case 'plan':
			return 'You are Qwen2.5-Coder running locally inside an offline code editor in Plan mode. Analyze the supplied context and produce a concise, ordered implementation plan. Identify affected files, risks, and verification steps. Do not provide replacement code or claim that changes were applied.';
		case 'agent':
			return `You are Qwen2.5-Coder running locally inside an offline code editor in Agent mode. Make the smallest targeted edits needed and preserve every unrelated line, function, class, comment, and behavior. Respect the file's architectural order: imports, constants and models, helpers and services, routes or handlers, then its runtime entrypoint. Never replace or shorten a whole file when only a local change is requested. For additive requests, add new standalone definitions near similar code; do not repurpose an existing function, route, or service, insert an early return into it, or change its behavior unless the user explicitly asks. Never insert a definition between a function signature and body or in the middle of an existing function. In Python, an if __name__ == "__main__": block is always the final executable section. For every new Python service, route, class, function, or handler in an existing file, return an insert operation with position="before_main" containing only the complete new top-level definition; Orbyte will calculate its safe placement. Do not use search/replace to add a Python top-level definition. In Java and Spring Boot, preserve package/import order and place fields, constructors, lifecycle methods, public endpoints, and private helpers consistently within the owning class; never emit a second public top-level class in the same file. Java imports belong after package and before annotations or the type declaration. Put every field inside the owning class, immediately after its opening brace and before constructors or methods. For in-memory List storage, import java.util.List and java.util.ArrayList and initialize the field exactly once, for example: private final List<Employee> employees = new ArrayList<>();. Never leave a Java collection field uninitialized. Use separate exact edit operations for imports, fields, and method bodies instead of replacing the whole Java file. When the request requires a new Java class, interface, repository, controller, service, DTO, entity, or other new source file, use create with a complete file URI under one of the supplied workspace_root URIs. Infer its conventional source directory and package from the workspace file outline. Never create outside a workspace_root and never use create for an existing file. Return only this machine-readable XML and no Markdown:\n<local_ai_agent_response>\n<summary>A short user-facing description with no code</summary>\n<changes>\n<create uri="exact new file URI under a workspace_root"><![CDATA[complete new file content]]></create>\n<insert uri="exact existing Python file URI" position="before_main"><![CDATA[complete new top-level Python definition]]></insert>\n<edit uri="exact existing target URI">\n<search><![CDATA[exact existing text that occurs once]]></search>\n<replace><![CDATA[replacement text]]></replace>\n</edit>\n</changes>\n</local_ai_agent_response>\nUse edit or insert only with exact URIs present in active_file or attached_file elements. Use create only for a genuinely new URI below a supplied workspace_root. Use edit only for modifying existing code and include enough unchanged surrounding text in search to make it unique. Never use an empty search. Use multiple operations for separate changes. Never return complete existing files or free-form fenced code. Never expose code in the summary. If no edit is needed, return an empty changes element.`;
		default:
			return 'You are Qwen2.5-Coder running locally inside an offline code editor in Ask mode. Answer questions using the supplied context. Be precise, explain relevant code clearly, and do not claim to edit files. Use fenced code blocks only for illustrative code.';
	}
}

export function formatChatMessages(context: ILocalAIContext | undefined, request: string, history: readonly ILocalLLMChatMessage[] = [], mode: LocalAIChatMode = 'ask', attachments: readonly ILocalAIAttachment[] = [], workspaceRoots: readonly ILocalAIWorkspaceRootContext[] = []): readonly ILocalLLMChatMessage[] {
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
	const attachmentsXml = formatAttachmentsXml(context ? attachments.filter(attachment => attachment.uri !== context.uri) : attachments);
	const workspaceRootsXml = mode === 'agent' ? formatWorkspaceRootsXml(workspaceRoots) : '';
	const contextBudget = Math.max(2000, inputCharacterBudget - maximumRequestCharacters - historyCharacters - attachmentsXml.length - workspaceRootsXml.length - 1000);
	const contextXml = context ? formatContextXml(context, contextBudget) : '<local_code_context />';
	return [
		{
			role: 'system',
			content: modeSystemPrompt(mode),
		},
		...boundedHistory,
		{
			role: 'user',
			content: `${contextXml}${workspaceRootsXml ? `\n${workspaceRootsXml}` : ''}${attachmentsXml ? `\n${attachmentsXml}` : ''}\n<user_request>${cdata(boundedRequest)}</user_request>`,
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
