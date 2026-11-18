/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ILocalAIAgentTargetSnapshot {
	readonly id: string;
	readonly displayPath: string;
	readonly originalText: string;
}

export interface ILocalAIAgentFileProposal {
	readonly targetId: string;
	readonly content: string;
}

export interface ILocalAIAgentCreateProposal {
	readonly uri: string;
	readonly content: string;
}

export interface IParsedLocalAIAgentResponse {
	readonly summary: string;
	readonly files: readonly ILocalAIAgentFileProposal[];
	readonly creates: readonly ILocalAIAgentCreateProposal[];
	readonly errors: readonly string[];
}

type AgentEditOperation =
	| { readonly kind: 'replace'; readonly search: string; readonly replace: string }
	| { readonly kind: 'insertBeforeMain'; readonly content: string }
	| { readonly kind: 'insertJavaMember'; readonly content: string }
	| { readonly kind: 'insertJavaImports'; readonly content: string }
	| { readonly kind: 'insertXmlDependencies'; readonly content: string };

export interface ILocalAIAgentProposalValidation {
	readonly safe: boolean;
	readonly removedNonEmptyLines: number;
	readonly originalNonEmptyLines: number;
	readonly reason?: string;
}

function decodeXml(value: string): string {
	return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');
}

function elementContent(value: string): string {
	const body = value.trim();
	const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(body);
	return cdata?.[1] ?? decodeXml(body);
}

function basename(path: string): string {
	return path.replaceAll('\\', '/').split('/').at(-1) ?? path;
}

function resolveTarget(value: string, targets: readonly ILocalAIAgentTargetSnapshot[]): ILocalAIAgentTargetSnapshot | undefined {
	const decoded = decodeXml(value).trim();
	const exact = targets.find(target => target.id === decoded || target.displayPath === decoded);
	if (exact) {
		return exact;
	}
	const basenameMatches = targets.filter(target => basename(target.displayPath) === decoded);
	return basenameMatches.length === 1 ? basenameMatches[0] : undefined;
}

function occurrenceCount(content: string, search: string): number {
	let count = 0;
	let offset = 0;
	while (offset <= content.length - search.length) {
		const index = content.indexOf(search, offset);
		if (index < 0) {
			break;
		}
		count++;
		offset = index + Math.max(1, search.length);
	}
	return count;
}

function isStandalonePythonDefinition(content: string): boolean {
	const lines = content.trim().split(/\r?\n/);
	let declarationLine = 0;
	while (declarationLine < lines.length && /^@[A-Za-z_]/.test(lines[declarationLine])) {
		declarationLine++;
	}
	if (declarationLine >= lines.length || !/^(?:async\s+def|def|class)\s+[A-Za-z_]\w*\b/.test(lines[declarationLine])) {
		return false;
	}
	const definitions = pythonTopLevelDefinitions(content);
	return definitions.length === 1 && definitions[0].text.trim() === content.trim();
}

function insertBeforePythonMain(originalText: string, addition: string): string | undefined {
	if (!isStandalonePythonDefinition(addition)) {
		return undefined;
	}
	const normalizedAddition = addition.trim();
	const lines = originalText.split(/\r?\n/);
	const mainLine = lines.findIndex(line => /^if\s+__name__\s*==\s*(["'])__main__\1\s*:\s*(?:#.*)?$/.test(line));
	if (mainLine < 0) {
		return `${originalText.trimEnd()}\n\n${normalizedAddition}\n`;
	}
	const beforeMain = lines.slice(0, mainLine).join('\n').trimEnd();
	const mainAndAfter = lines.slice(mainLine).join('\n').trimEnd();
	return `${beforeMain}\n\n${normalizedAddition}\n\n${mainAndAfter}\n`;
}

function isCompleteJavaCreate(uri: string, content: string, instruction: string): boolean {
	const decodedUri = decodeXml(uri).trim().split(/[?#]/, 1)[0];
	const fileName = basename(decodedUri);
	if (!fileName.toLowerCase().endsWith('.java')) {
		return false;
	}
	const expectedType = fileName.slice(0, -'.java'.length);
	const code = javaCodeWithoutCommentsOrStrings(content);
	const matchingType = new RegExp(`\\b(?:(?:public|protected|private|abstract|final|sealed|non-sealed|static)\\s+)*(?:class|interface|record|enum)\\s+${escapeRegExp(expectedType)}\\b`).test(code);
	return matchingType && !validateJavaStructure(content, instruction);
}

/**
 * Parses targeted Agent edits and applies them to snapshots in memory. Each file is transactional:
 * if any search block is missing or ambiguous, no proposal is returned for that file.
 */
export function parseLocalAIAgentResponse(response: string, targets: readonly ILocalAIAgentTargetSnapshot[], instruction = ''): IParsedLocalAIAgentResponse {
	const summaryMatch = /<summary>([\s\S]*?)<\/summary>/i.exec(response);
	const summary = summaryMatch ? decodeXml(summaryMatch[1].trim()) : '';
	const errors: string[] = [];
	const creates: ILocalAIAgentCreateProposal[] = [];
	const createdUris = new Set<string>();
	const editGroups = new Map<string, { target: ILocalAIAgentTargetSnapshot; operations: AgentEditOperation[] }>();
	const editPattern = /<edit\s+[^>]*(?:path|uri)\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/edit>/gi;
	for (const match of response.matchAll(editPattern)) {
		const target = resolveTarget(match[2], targets);
		if (!target) {
			errors.push(`Unknown edit target: ${decodeXml(match[2])}`);
			continue;
		}
		const searchMatch = /<search>([\s\S]*?)<\/search>/i.exec(match[3]);
		const replaceMatch = /<replace>([\s\S]*?)<\/replace>/i.exec(match[3]);
		if (!searchMatch || !replaceMatch) {
			errors.push(`Edit for ${target.displayPath} is missing a search or replace element.`);
			continue;
		}
		const search = elementContent(searchMatch[1]);
		if (!search) {
			errors.push(`Edit for ${target.displayPath} has an empty search block.`);
			continue;
		}
		const group = editGroups.get(target.id) ?? { target, operations: [] };
		group.operations.push({ kind: 'replace', search, replace: elementContent(replaceMatch[1]) });
		editGroups.set(target.id, group);
	}

	const insertPattern = /<insert\s+[^>]*(?:path|uri)\s*=\s*(["'])(.*?)\1[^>]*position\s*=\s*(["'])before_main\3[^>]*>([\s\S]*?)<\/insert>/gi;
	for (const match of response.matchAll(insertPattern)) {
		const uri = decodeXml(match[2]).trim();
		const content = elementContent(match[4]);
		const target = resolveTarget(match[2], targets);
		if (!target) {
			// Small local models sometimes use Python's insert operation while creating
			// a Java file. Recover only a complete, structurally valid compilation unit;
			// the orchestrator still enforces task ownership and workspace boundaries.
			if (isCompleteJavaCreate(uri, content, instruction)) {
				if (createdUris.has(uri)) {
					errors.push(`Duplicate create target: ${uri}`);
				} else {
					createdUris.add(uri);
					creates.push({ uri, content });
				}
				continue;
			}
			errors.push(`Unknown insert target: ${uri}`);
			continue;
		}
		if (target.displayPath.toLowerCase().endsWith('.java')) {
			const group = editGroups.get(target.id) ?? { target, operations: [] };
			const imports = javaImportsFromBlock(content);
			if (isStandaloneJavaField(content)) {
				group.operations.push({ kind: 'insertJavaMember', content });
			} else if (imports.length) {
				group.operations.push({ kind: 'insertJavaImports', content: imports.join('\n') });
			} else {
				errors.push(`Java insert for ${target.displayPath} must contain imports or one standalone field declaration.`);
				continue;
			}
			editGroups.set(target.id, group);
			continue;
		}
		if (target.displayPath.toLowerCase().endsWith('.xml') && isXmlDependencyBlock(content)) {
			const group = editGroups.get(target.id) ?? { target, operations: [] };
			group.operations.push({ kind: 'insertXmlDependencies', content });
			editGroups.set(target.id, group);
			continue;
		}
		if (!target.displayPath.toLowerCase().endsWith('.py')) {
			errors.push(`before_main insertion is only supported for Python files: ${target.displayPath}`);
			continue;
		}
		if (!isStandalonePythonDefinition(content)) {
			errors.push(`Insert for ${target.displayPath} must contain one standalone top-level Python definition.`);
			continue;
		}
		const group = editGroups.get(target.id) ?? { target, operations: [] };
		group.operations.push({ kind: 'insertBeforeMain', content });
		editGroups.set(target.id, group);
	}

	const files: ILocalAIAgentFileProposal[] = [];
	for (const { target, operations } of editGroups.values()) {
		let content = target.originalText;
		let valid = true;
		for (const operation of operations) {
			if (operation.kind === 'insertJavaImports') {
				content = insertJavaImports(content, operation.content);
				continue;
			}
			if (operation.kind === 'insertXmlDependencies') {
				const inserted = insertXmlDependencies(content, operation.content);
				if (!inserted) {
					errors.push(`Could not insert dependencies into ${target.displayPath}.`);
					valid = false;
					break;
				}
				content = inserted;
				continue;
			}
			if (operation.kind === 'insertJavaMember') {
				const inserted = insertJavaClassMember(content, operation.content);
				if (!inserted) {
					errors.push(`Could not insert a Java field into ${target.displayPath}.`);
					valid = false;
					break;
				}
				content = inserted;
				continue;
			}
			if (operation.kind === 'insertBeforeMain') {
				const inserted = insertBeforePythonMain(content, operation.content);
				if (!inserted) {
					errors.push(`Could not insert a standalone Python definition into ${target.displayPath}.`);
					valid = false;
					break;
				}
				content = inserted;
				continue;
			}
			const normalizedOperation = target.displayPath.toLowerCase().endsWith('.java')
				? normalizeJavaAnnotationEdit(content, operation.search, operation.replace)
				: operation;
			const matches = occurrenceCount(content, normalizedOperation.search);
			if (matches !== 1) {
				errors.push(`Search block for ${target.displayPath} matched ${matches} times; expected exactly once.`);
				valid = false;
				break;
			}
			content = content.replace(normalizedOperation.search, normalizedOperation.replace);
		}
		if (valid) {
			content = normalizeJavaInMemoryCollection(target.originalText, content, instruction, target.displayPath);
		}
		if (valid && content !== target.originalText) {
			files.push({ targetId: target.id, content });
		}
	}

	// Accept the previous explicit complete-file protocol as a compatibility fallback.
	if (!editGroups.size) {
		const filePattern = /<file\s+[^>]*(?:path|uri)\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/file>/gi;
		for (const match of response.matchAll(filePattern)) {
			const target = resolveTarget(match[2], targets);
			if (!target) {
				errors.push(`Unknown file target: ${decodeXml(match[2])}`);
				continue;
			}
			files.push({ targetId: target.id, content: elementContent(match[3]) });
		}
	}

	const createPattern = /<create\s+[^>]*(?:path|uri)\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/create>/gi;
	for (const match of response.matchAll(createPattern)) {
		const uri = decodeXml(match[2]).trim();
		const content = elementContent(match[3]);
		if (!uri) {
			errors.push('A create operation is missing its URI.');
			continue;
		}
		if (!content.trim()) {
			errors.push(`New file ${uri} has no content.`);
			continue;
		}
		if (createdUris.has(uri)) {
			errors.push(`Duplicate create target: ${uri}`);
			continue;
		}
		createdUris.add(uri);
		creates.push({ uri, content });
	}

	// A 3B local model can understand a Spring/Swagger request but still answer
	// with prose instead of the XML edit protocol. Swagger setup is sufficiently
	// structured to recover deterministically from the current file snapshots.
	// This keeps the normal proposal validators and review UI in the loop while
	// preventing one formatting mistake from cancelling the whole task graph.
	const swaggerRecovery = recoverSwaggerDocumentation(instruction, targets);
	if (swaggerRecovery.length) {
		const proposedTargets = new Set(files.map(file => file.targetId));
		for (const proposal of swaggerRecovery) {
			if (!proposedTargets.has(proposal.targetId)) {
				files.push(proposal);
			}
		}
		if (files.length) {
			errors.length = 0;
		}
	}

	// Small local models occasionally ignore the XML envelope during a repair and
	// return one complete fenced file. This is unambiguous only for a single target;
	// the normal destructive-change and structural validators still run afterward.
	if (!errors.length && !files.length && !creates.length && !editGroups.size && targets.length === 1) {
		const fenced = [...response.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/g)];
		if (fenced.length === 1 && fenced[0][1].trim()) {
			files.push({ targetId: targets[0].id, content: `${fenced[0][1].trimEnd()}\n` });
		}
	}

	return { summary, files, creates, errors };
}

function isSwaggerDocumentationRequest(instruction: string): boolean {
	return /\b(?:swagger|openapi)\b/i.test(instruction)
		&& /\b(?:add|document|documentation|annotat|dependenc|enable|integrat|support|use)\w*\b/i.test(instruction);
}

function recoverSwaggerDocumentation(instruction: string, targets: readonly ILocalAIAgentTargetSnapshot[]): ILocalAIAgentFileProposal[] {
	if (!isSwaggerDocumentationRequest(instruction)) {
		return [];
	}

	const proposals: ILocalAIAgentFileProposal[] = [];
	for (const target of targets) {
		let content = target.originalText;
		const path = target.displayPath.toLowerCase();
		if (path.endsWith('.java') && (path.endsWith('controller.java') || /@RestController\b/.test(content))) {
			content = addSwaggerJavaDocumentation(content);
		} else if ((path.endsWith('pom.xml') || path.endsWith('.xml')) && /<project\b[\s\S]*?<dependencies\b/.test(content)) {
			content = addSpringdocMavenDependency(content);
		}

		if (content !== target.originalText) {
			proposals.push({ targetId: target.id, content });
		}
	}
	return proposals;
}

function addSwaggerJavaDocumentation(originalText: string): string {
	let content = insertJavaImport(originalText, 'io.swagger.v3.oas.annotations.Operation');
	content = insertJavaImport(content, 'io.swagger.v3.oas.annotations.tags.Tag');
	let lines = content.split(/\r?\n/);

	if (!/^\s*@Tag\b/m.test(content)) {
		const classMatch = /\b(?:public\s+)?class\s+([A-Za-z_]\w*)Controller\b/.exec(content);
		const resourceName = classMatch?.[1] ?? 'Application';
		const annotationIndex = lines.findIndex(line => /^\s*@RestController\b/.test(line));
		const classIndex = lines.findIndex(line => /\bclass\s+[A-Za-z_]\w*Controller\b/.test(line));
		const insertionIndex = annotationIndex >= 0 ? annotationIndex : classIndex;
		if (insertionIndex >= 0) {
			const indentation = /^\s*/.exec(lines[insertionIndex])?.[0] ?? '';
			lines.splice(insertionIndex, 0, `${indentation}@Tag(name = "${resourceName} API", description = "${resourceName} management endpoints")`);
		}
	}

	for (let index = 0; index < lines.length; index++) {
		if (!/^\s*@(?:Get|Post|Put|Patch|Delete|Request)Mapping\b/.test(lines[index])) {
			continue;
		}
		let annotationStart = index;
		while (annotationStart > 0 && /^\s*@\w/.test(lines[annotationStart - 1])) {
			annotationStart--;
		}
		if (lines.slice(annotationStart, index + 1).some(line => /^\s*@Operation\b/.test(line))) {
			continue;
		}

		const declaration = lines.slice(index + 1, Math.min(lines.length, index + 6)).join(' ');
		const methodMatch = /\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:throws\s+[^{]+)?\{/.exec(declaration);
		if (!methodMatch) {
			continue;
		}
		const words = methodMatch[1].replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
		const summary = `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
		const indentation = /^\s*/.exec(lines[index])?.[0] ?? '';
		lines.splice(index, 0, `${indentation}@Operation(summary = "${summary}")`);
		index++;
	}

	return lines.join('\n');
}

function addSpringdocMavenDependency(originalText: string): string {
	if (/<groupId>\s*org\.springdoc\s*<\/groupId>[\s\S]*?<artifactId>\s*springdoc-openapi-starter-(?:webmvc|webflux)-ui\s*<\/artifactId>/i.test(originalText)) {
		return originalText;
	}
	const springBootVersion = /<parent>[\s\S]*?<groupId>\s*org\.springframework\.boot\s*<\/groupId>[\s\S]*?<version>\s*(\d+)(?:\.[^<]+)?<\/version>[\s\S]*?<\/parent>/i.exec(originalText);
	const springBootMajor = Number(springBootVersion?.[1] ?? 3);
	const springdocVersion = springBootMajor >= 4 ? '3.2.0' : springBootMajor >= 3 ? '2.8.17' : '1.8.0';
	const webStack = /<artifactId>\s*spring-boot-starter-webflux\s*<\/artifactId>/i.test(originalText) ? 'webflux' : 'webmvc';
	return insertXmlDependencies(originalText, `<dependency>
	<groupId>org.springdoc</groupId>
	<artifactId>springdoc-openapi-starter-${webStack}-ui</artifactId>
	<version>${springdocVersion}</version>
</dependency>`) ?? originalText;
}

function countRemovedNonEmptyLines(originalText: string, proposedText: string): { removed: number; original: number } {
	const proposedLineCounts = new Map<string, number>();
	for (const line of proposedText.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
		proposedLineCounts.set(line, (proposedLineCounts.get(line) ?? 0) + 1);
	}

	let original = 0;
	let removed = 0;
	for (const line of originalText.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
		original++;
		const available = proposedLineCounts.get(line) ?? 0;
		if (available > 0) {
			proposedLineCounts.set(line, available - 1);
		} else {
			removed++;
		}
	}
	return { removed, original };
}

interface IPythonTopLevelDefinition {
	readonly name: string;
	readonly text: string;
}

function pythonTopLevelDefinitions(value: string): IPythonTopLevelDefinition[] {
	const lines = value.split(/\r?\n/);
	const definitions: IPythonTopLevelDefinition[] = [];
	const starts: { line: number; declarationLine: number; name: string }[] = [];
	for (let line = 0; line < lines.length; line++) {
		const match = /^(?:async\s+def|def|class)\s+([A-Za-z_]\w*)\b/.exec(lines[line]);
		if (match) {
			let start = line;
			while (start > 0 && /^@[A-Za-z_]/.test(lines[start - 1])) {
				start--;
			}
			starts.push({ line: start, declarationLine: line, name: match[1] });
		}
	}

	for (let index = 0; index < starts.length; index++) {
		const start = starts[index];
		let end = lines.length;
		for (let line = start.declarationLine + 1; line < lines.length; line++) {
			if (lines[line].trim() && !/^\s/.test(lines[line])) {
				end = line;
				break;
			}
		}
		definitions.push({
			name: start.name,
			text: lines.slice(start.line, end).join('\n').trimEnd(),
		});
	}
	return definitions;
}

function validateStandalonePythonAddition(originalText: string, proposedText: string): string | undefined {
	const originalDefinitions = pythonTopLevelDefinitions(originalText);
	const proposedDefinitions = pythonTopLevelDefinitions(proposedText);
	for (const definition of originalDefinitions) {
		if (!proposedText.includes(definition.text)) {
			return `Existing Python definition "${definition.name}" was modified or split while adding a new definition.`;
		}
	}
	if (proposedDefinitions.length <= originalDefinitions.length) {
		return 'The proposal did not add a new top-level Python definition.';
	}
	return undefined;
}

function pythonMainGuard(value: string): { line: number; text: string } | undefined {
	const lines = value.split(/\r?\n/);
	for (let line = 0; line < lines.length; line++) {
		if (/^if\s+__name__\s*==\s*(["'])__main__\1\s*:\s*(?:#.*)?$/.test(lines[line])) {
			return { line, text: lines.slice(line).join('\n').trimEnd() };
		}
	}
	return undefined;
}

function validatePythonMainGuard(originalText: string, proposedText: string, additiveIntent: boolean): string | undefined {
	const originalGuard = pythonMainGuard(originalText);
	const proposedGuard = pythonMainGuard(proposedText);
	if (originalGuard && !proposedGuard) {
		return 'The Python __main__ entrypoint was removed.';
	}
	if (!proposedGuard) {
		return undefined;
	}

	const lines = proposedText.split(/\r?\n/);
	for (let line = proposedGuard.line + 1; line < lines.length; line++) {
		if (lines[line].trim() && !/^\s/.test(lines[line]) && !/^\s*#/.test(lines[line])) {
			return 'The Python __main__ entrypoint must remain the last executable section in the file.';
		}
	}
	if (additiveIntent && originalGuard && !proposedText.includes(originalGuard.text)) {
		return 'The existing Python __main__ entrypoint was modified while adding unrelated code.';
	}
	return undefined;
}

function isStandaloneJavaField(content: string): boolean {
	const value = content.trim();
	if (!value || value.includes('{') || value.includes('}') || (value.match(/;/g)?.length ?? 0) !== 1) {
		return false;
	}
	return /^(?:(?:@[A-Za-z_][\w.]*(?:\([^\n]*\))?)\s+)*(?:public|protected|private)\s+(?:(?:static|final|volatile|transient)\s+)*[A-Za-z_][\w<>, ?.\[\]]*\s+[A-Za-z_]\w*\s*(?:=\s*[^;]+)?;$/.test(value);
}

function javaImportsFromBlock(content: string): string[] {
	return content.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => /^import\s+(?:static\s+)?[A-Za-z_][\w.]*\*?\s*;$/.test(line));
}

function insertJavaImports(originalText: string, addition: string): string {
	let content = originalText;
	for (const line of addition.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
		const qualifiedName = /^import\s+(.+?)\s*;$/.exec(line)?.[1];
		if (qualifiedName && !content.includes(`import ${qualifiedName};`)) {
			const lines = content.split(/\r?\n/);
			let insertionLine = lines.findLastIndex(candidate => /^\s*import\s+(?:static\s+)?[\w.*]+\s*;\s*$/.test(candidate));
			if (insertionLine < 0) {
				insertionLine = lines.findIndex(candidate => /^\s*package\s+[\w.]+\s*;\s*$/.test(candidate));
			}
			lines.splice(insertionLine + 1, 0, `import ${qualifiedName};`);
			content = lines.join('\n');
		}
	}
	return content;
}

function isXmlDependencyBlock(content: string): boolean {
	const value = content.trim();
	return value.length > 0
		&& /<dependency\b[\s\S]*?<\/dependency>/.test(value)
		&& value.replace(/<dependency\b[\s\S]*?<\/dependency>/g, '').trim() === '';
}

function insertXmlDependencies(originalText: string, addition: string): string | undefined {
	const closing = originalText.lastIndexOf('</dependencies>');
	if (closing < 0) {
		return undefined;
	}
	const dependencies = [...addition.matchAll(/<dependency\b[\s\S]*?<\/dependency>/g)].map(match => match[0].trim());
	const missing = dependencies.filter(dependency => {
		const groupId = /<groupId>\s*([^<]+?)\s*<\/groupId>/.exec(dependency)?.[1];
		const artifactId = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(dependency)?.[1];
		if (!artifactId) {
			return !originalText.includes(dependency);
		}
		const existingDependency = new RegExp(`<dependency\\b[\\s\\S]*?<groupId>\\s*${escapeRegExp(groupId ?? '')}\\s*<\\/groupId>[\\s\\S]*?<artifactId>\\s*${escapeRegExp(artifactId)}\\s*<\\/artifactId>[\\s\\S]*?<\\/dependency>`);
		return !existingDependency.test(originalText);
	});
	if (!missing.length) {
		return originalText;
	}
	const lineStart = originalText.lastIndexOf('\n', closing) + 1;
	const indent = /^\s*/.exec(originalText.slice(lineStart, closing))?.[0] ?? '';
	const block = missing.map(dependency => dependency.split(/\r?\n/).map(line => `${indent}${line}`).join('\n')).join('\n');
	return `${originalText.slice(0, lineStart)}${block}\n${originalText.slice(lineStart)}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeJavaAnnotationEdit(content: string, search: string, replace: string): { readonly kind: 'replace'; readonly search: string; readonly replace: string } {
	const annotation = /^\s*(@[A-Za-z_][\w.]*)\s*$/.exec(search)?.[1];
	if (!annotation || !replace.trimStart().startsWith(annotation)) {
		return { kind: 'replace', search, replace };
	}
	const linePattern = new RegExp(`^\\s*${escapeRegExp(annotation)}(?:\\([^\\r\\n]*\\))?\\s*$`, 'gm');
	const matches = [...content.matchAll(linePattern)];
	if (matches.length !== 1) {
		return { kind: 'replace', search, replace };
	}
	const originalLine = matches[0][0];
	const indentation = /^\s*/.exec(originalLine)?.[0] ?? '';
	const originalAnnotation = originalLine.trim();
	const normalizedReplace = replace.replace(annotation, originalAnnotation);
	return {
		kind: 'replace',
		search: originalLine,
		replace: normalizedReplace.split(/\r?\n/).map(line => `${indentation}${line}`).join('\n'),
	};
}

function insertJavaClassMember(originalText: string, addition: string): string | undefined {
	if (!isStandaloneJavaField(addition)) {
		return undefined;
	}
	const body = javaTypeBodyRange(originalText);
	if (!body) {
		return undefined;
	}
	const declarationLineStart = originalText.lastIndexOf('\n', body.opening) + 1;
	const classIndent = /^\s*/.exec(originalText.slice(declarationLineStart, body.opening))?.[0] ?? '';
	const memberIndent = `${classIndent}\t`;
	const suffix = originalText.slice(body.opening + 1);
	const separator = suffix.startsWith('\n') || suffix.startsWith('\r\n') ? '' : '\n';
	return `${originalText.slice(0, body.opening + 1)}\n\n${memberIndent}${addition.trim()}${separator}${suffix}`;
}

function hasJavaArrayListIntent(instruction: string): boolean {
	return /\b(?:array\s*list|arraylist|in[- ]memory\s+(?:list|collection|store|storage))\b/i.test(instruction);
}

function javaCodeWithoutCommentsOrStrings(value: string): string {
	return value
		.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
		.replace(/\/\/[^\n]*/g, match => ' '.repeat(match.length))
		.replace(/"(?:\\.|[^"\\])*"/g, match => ' '.repeat(match.length))
		.replace(/'(?:\\.|[^'\\])*'/g, match => ' '.repeat(match.length));
}

function javaBraceDepthAt(code: string, offset: number): number {
	let depth = 0;
	for (let index = 0; index < Math.min(offset, code.length); index++) {
		if (code[index] === '{') {
			depth++;
		} else if (code[index] === '}') {
			depth--;
		}
	}
	return depth;
}

function javaTypeBodyRange(value: string): { opening: number; closing: number } | undefined {
	const code = javaCodeWithoutCommentsOrStrings(value);
	const declaration = /\b(?:class|interface|record|enum)\s+[A-Za-z_]\w*\b/.exec(code);
	if (!declaration) {
		return undefined;
	}
	const opening = code.indexOf('{', declaration.index + declaration[0].length);
	if (opening < 0) {
		return undefined;
	}
	let depth = 0;
	for (let index = opening; index < code.length; index++) {
		if (code[index] === '{') {
			depth++;
		} else if (code[index] === '}') {
			depth--;
			if (depth === 0) {
				return { opening, closing: index };
			}
		}
	}
	return undefined;
}

const javaCollectionFieldPattern = /^\s*(?:(?:public|protected|private)\s+)(?:(?:static|final|volatile|transient)\s+)*(?:List|ArrayList)\s*<[^;=\n]+>\s+([A-Za-z_]\w*)\s*(?:=\s*new\s+ArrayList\s*<[^>]*>\s*\(\s*\))?\s*;\s*$/;

function relocateNewJavaCollectionFields(originalText: string, proposedText: string): string {
	const body = javaTypeBodyRange(proposedText);
	if (!body) {
		return proposedText;
	}
	const originalLines = new Set(originalText.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
	const code = javaCodeWithoutCommentsOrStrings(proposedText);
	const misplaced: string[] = [];
	let offset = 0;
	const keptLines: string[] = [];
	for (const line of proposedText.split(/(?<=\n)/)) {
		const content = line.replace(/\r?\n$/, '');
		const match = javaCollectionFieldPattern.exec(content);
		const outsideMemberScope = javaBraceDepthAt(code, offset) !== 1;
		if (match && outsideMemberScope && !originalLines.has(content.trim())) {
			misplaced.push(content.trim());
		} else {
			keptLines.push(line);
		}
		offset += line.length;
	}
	if (!misplaced.length) {
		return proposedText;
	}
	const withoutMisplaced = keptLines.join('');
	const updatedBody = javaTypeBodyRange(withoutMisplaced);
	if (!updatedBody) {
		return proposedText;
	}
	const declarationLineStart = withoutMisplaced.lastIndexOf('\n', updatedBody.opening) + 1;
	const classIndent = /^\s*/.exec(withoutMisplaced.slice(declarationLineStart, updatedBody.opening))?.[0] ?? '';
	const memberIndent = `${classIndent}\t`;
	const fields = misplaced.map(field => `${memberIndent}${field}`).join('\n');
	return `${withoutMisplaced.slice(0, updatedBody.opening + 1)}\n\n${fields}${withoutMisplaced.slice(updatedBody.opening + 1)}`;
}

function insertJavaImport(content: string, qualifiedName: string): string {
	const importLine = `import ${qualifiedName};`;
	if (content.includes(importLine) || content.includes(qualifiedName)) {
		return content;
	}
	const lines = content.split(/\r?\n/);
	let insertionLine = lines.findLastIndex(line => /^\s*import\s+[\w.*]+\s*;\s*$/.test(line));
	if (insertionLine < 0) {
		insertionLine = lines.findIndex(line => /^\s*package\s+[\w.]+\s*;\s*$/.test(line));
	}
	lines.splice(insertionLine + 1, 0, importLine);
	return lines.join('\n');
}

function normalizeJavaInMemoryCollection(originalText: string, proposedText: string, instruction: string, displayPath: string): string {
	if (!displayPath.toLowerCase().endsWith('.java') || !hasJavaArrayListIntent(instruction)) {
		return proposedText;
	}
	let content = relocateNewJavaCollectionFields(originalText, proposedText);
	content = content.replace(/^(\s*(?:(?:public|protected|private)\s+)(?:(?:static|final|volatile|transient)\s+)*(?:List|ArrayList)\s*<[^;=\n]+>\s+([A-Za-z_]\w*))\s*;\s*$/gm, (field, declaration: string, name: string) => {
		const assignment = new RegExp(`(?:this\\.)?${name}\\s*=\\s*new\\s+ArrayList\\s*<`);
		return assignment.test(content) ? field : `${declaration} = new ArrayList<>();`;
	});
	if (/(^|[^.\w])List\s*</m.test(content)) {
		content = insertJavaImport(content, 'java.util.List');
	}
	if (/(^|[^.\w])ArrayList\s*</m.test(content) || /new\s+ArrayList\s*</.test(content)) {
		content = insertJavaImport(content, 'java.util.ArrayList');
	}
	return content;
}

function validateJavaStructure(proposedText: string, instruction: string): string | undefined {
	const code = javaCodeWithoutCommentsOrStrings(proposedText);
	let depth = 0;
	for (const character of code) {
		if (character === '{') {
			depth++;
		} else if (character === '}') {
			depth--;
			if (depth < 0) {
				return 'The Java proposal closes a block before it is opened.';
			}
		}
	}
	if (depth !== 0) {
		return 'The Java proposal has unbalanced braces.';
	}

	const body = javaTypeBodyRange(proposedText);
	if (!body) {
		return 'The Java proposal no longer contains a complete type declaration.';
	}
	if (/\bimport\s+[\w.*]+\s*;/.test(code.slice(body.opening))) {
		return 'Java imports must remain before the type declaration.';
	}
	if (code.slice(body.closing + 1).trim()) {
		return 'Java members or executable code cannot remain outside the main type declaration.';
	}
	let offset = 0;
	for (const line of proposedText.split(/(?<=\n)/)) {
		const content = line.replace(/\r?\n$/, '');
		const braceDepth = javaBraceDepthAt(code, offset);
		if (javaCollectionFieldPattern.test(content) && braceDepth !== 1) {
			return 'A Java collection field was placed outside its owning class member scope.';
		}
		const methodDeclaration = /^\s*(?:public|protected|private)\s+(?:(?:static|final|synchronized|abstract|native)\s+)*(?:<[^>]+>\s+)?[A-Za-z_][\w<>, ?.\[\]]*\s+[A-Za-z_]\w*\s*\(/.test(content);
		if (methodDeclaration && braceDepth !== 1) {
			return 'A Java method was placed outside its owning class member scope.';
		}
		offset += line.length;
	}
	if (hasJavaArrayListIntent(instruction)) {
		const hasUninitializedField = /^\s*(?:(?:public|protected|private)\s+)(?:(?:static|final|volatile|transient)\s+)*(?:List|ArrayList)\s*<[^;=\n]+>\s+[A-Za-z_]\w*\s*;\s*$/m.test(proposedText);
		if (hasUninitializedField || !/new\s+ArrayList\s*<[^>]*>\s*\(\s*\)/.test(proposedText)) {
			return 'The in-memory Java collection must be initialized with new ArrayList<>().';
		}
	}
	return undefined;
}

/** Rejects unexpectedly destructive proposals unless the user explicitly requested removal. */
export function validateLocalAIAgentProposal(originalText: string, proposedText: string, instruction: string, displayPath = ''): ILocalAIAgentProposalValidation {
	const { removed, original } = countRemovedNonEmptyLines(originalText, proposedText);
	const destructiveIntent = /\b(remove|delete|discard|clear|empty|truncate|rewrite|replace\s+(?:the\s+)?(?:whole|entire))\b/i.test(instruction);
	const additiveIntent = /\b(add|create|implement|introduce|append|extend|register|support)\b/i.test(instruction);
	const repairsMalformedJava = displayPath.toLowerCase().endsWith('.java')
		&& Boolean(validateJavaStructure(originalText, ''))
		&& !validateJavaStructure(proposedText, '');
	const generalLimit = Math.max(12, Math.ceil(original * 0.20));
	const additiveLimit = Math.max(6, Math.ceil(original * 0.08));
	if (!proposedText.trim()) {
		return { safe: false, removedNonEmptyLines: removed, originalNonEmptyLines: original, reason: 'The proposal was empty.' };
	}
	if (!destructiveIntent && !repairsMalformedJava && removed > (additiveIntent ? additiveLimit : generalLimit)) {
		return {
			safe: false,
			removedNonEmptyLines: removed,
			originalNonEmptyLines: original,
			reason: `The proposal removed ${removed} of ${original} existing non-empty lines.`,
		};
	}

	const standaloneAddition = additiveIntent && /\b(api|endpoint|route|service|function|class|handler)\b/i.test(instruction);
	if (!destructiveIntent && displayPath.toLowerCase().endsWith('.py')) {
		const mainGuardReason = validatePythonMainGuard(originalText, proposedText, additiveIntent);
		if (mainGuardReason) {
			return { safe: false, removedNonEmptyLines: removed, originalNonEmptyLines: original, reason: mainGuardReason };
		}
	}
	if (!destructiveIntent && standaloneAddition && displayPath.toLowerCase().endsWith('.py')) {
		const reason = validateStandalonePythonAddition(originalText, proposedText);
		if (reason) {
			return { safe: false, removedNonEmptyLines: removed, originalNonEmptyLines: original, reason };
		}
	}
	if (!destructiveIntent && displayPath.toLowerCase().endsWith('.java')) {
		const reason = validateJavaStructure(proposedText, instruction);
		if (reason) {
			return { safe: false, removedNonEmptyLines: removed, originalNonEmptyLines: original, reason };
		}
	}
	return { safe: true, removedNonEmptyLines: removed, originalNonEmptyLines: original };
}
