/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { getLocalLLMContextWindowTokens, getLocalLLMGenerationTokens } from '../../../../../platform/localLLM/common/localLLMContextProfile.js';
import { parseLocalAIAgentResponse, validateLocalAIAgentProposal } from '../../browser/context/agentEditProtocol.js';
import { formatAgentFeatureImplementerMessages, formatAgentFeatureReviewerMessages, formatAgentPlannerMessages, formatAgentRepairMessages, formatAgentTaskPlannerMessages, formatAgentTesterMessages, formatChatMessages, ILocalAIAgentFeatureTask, isNewSourceCreationRequest } from '../../browser/context/promptFormatter.js';
import { scoreLocalAIWorkspacePath } from '../../browser/context/smartWorkspaceContext.js';

suite('Local AI Agent edit protocol', () => {
	test('detects a named service without an explicit file mention', () => {
		const prompt = 'Add a saveById method in employee service';
		const sourceScore = scoreLocalAIWorkspacePath(prompt, 'src/main/java/com/example/demo/EmployeeService.java');
		const entityScore = scoreLocalAIWorkspacePath(prompt, 'src/main/java/com/example/demo/Employee.java');
		const testScore = scoreLocalAIWorkspacePath(prompt, 'src/test/java/com/example/demo/EmployeeServiceTest.java');

		assert.ok(sourceScore >= 360);
		assert.ok(sourceScore > entityScore);
		assert.ok(entityScore < 90);
		assert.ok(sourceScore > testScore);
	});

	test('prefers the service test when the prompt explicitly requests tests', () => {
		const prompt = 'Update EmployeeServiceTest for the new behavior';
		const sourceScore = scoreLocalAIWorkspacePath(prompt, 'src/main/java/com/example/demo/EmployeeService.java');
		const testScore = scoreLocalAIWorkspacePath(prompt, 'src/test/java/com/example/demo/EmployeeServiceTest.java');

		assert.ok(testScore > sourceScore);
	});

	test('selects an existing service as read-only context for a like-named creation request', () => {
		const prompt = 'Create StudentService like EmployeeService';
		const serviceScore = scoreLocalAIWorkspacePath(prompt, 'src/main/java/com/example/demo/EmployeeService.java');
		const controllerScore = scoreLocalAIWorkspacePath(prompt, 'src/main/java/com/example/demo/EmployeeController.java');

		assert.ok(serviceScore >= 90);
		assert.ok(controllerScore < 90);
		assert.ok(serviceScore > controllerScore);
	});

	test('selects a hardware-aware long context and bounded generation budget', () => {
		assert.strictEqual(getLocalLLMContextWindowTokens(32_768, 8 * 1024 ** 3, 6 * 1024 ** 3, 8 * 1024 ** 3), 32_768);
		assert.strictEqual(getLocalLLMContextWindowTokens(65_536, 16 * 1024 ** 3, 8 * 1024 ** 3, 16 * 1024 ** 3), 65_536);
		assert.strictEqual(getLocalLLMContextWindowTokens(131_072, 16 * 1024 ** 3, 16 * 1024 ** 3, 24 * 1024 ** 3), 8_192);
		assert.strictEqual(getLocalLLMContextWindowTokens(131_072, 20 * 1024 ** 3, 16 * 1024 ** 3, 24 * 1024 ** 3), 69_632);
		assert.strictEqual(getLocalLLMContextWindowTokens(131_072, 32 * 1024 ** 3, 16 * 1024 ** 3, 32 * 1024 ** 3), 131_072);
		assert.strictEqual(getLocalLLMGenerationTokens(65_536, 'implementer'), 8_192);
		assert.strictEqual(getLocalLLMGenerationTokens(8_192, 'planner'), 768);
	});

	test('retains multiple large target files when the selected model has a 32K context', () => {
		const firstMarker = 'FIRST_FILE_REQUIRED_BEHAVIOR';
		const secondMarker = 'SECOND_FILE_REQUIRED_CONTRACT';
		const messages = formatChatMessages(undefined, 'Update both services without changing their contracts.', [], 'agent', [{
			uri: 'file:///workspace/FirstService.java',
			name: 'FirstService.java',
			content: `${'class FirstService { /* padding */ }\n'.repeat(420)}${firstMarker}`,
		}, {
			uri: 'file:///workspace/SecondService.java',
			name: 'SecondService.java',
			content: `${'class SecondService { /* padding */ }\n'.repeat(420)}${secondMarker}`,
		}], [{ uri: 'file:///workspace', name: 'workspace', files: ['FirstService.java', 'SecondService.java'] }], 32_768);

		assert.ok(messages.at(-1)?.content.includes(firstMarker));
		assert.ok(messages.at(-1)?.content.includes(secondMarker));
		assert.ok(messages.at(-1)?.content.includes('Update both services'));
	});

	test('recognizes CamelCase Java service creation requests', () => {
		assert.strictEqual(isNewSourceCreationRequest('Add a new EmployeeService with add, update, and delete methods'), true);
		assert.strictEqual(isNewSourceCreationRequest('Update EmployeeService delete behavior'), false);
	});

	test('recovers a complete new Java service when a small model emits insert instead of create', () => {
		const uri = 'file:///workspace/src/main/java/com/example/demo/StudentService.java';
		const result = parseLocalAIAgentResponse(`<local_ai_agent_response><changes>
<insert uri="${uri}" position="before_main"><![CDATA[package com.example.demo;

import org.springframework.stereotype.Service;

@Service
public class StudentService {
	public String findById(long id) {
		return "student-" + id;
	}
}
]]></insert>
</changes></local_ai_agent_response>`, [], 'Create StudentService like EmployeeService');

		assert.deepStrictEqual(result.errors, []);
		assert.strictEqual(result.files.length, 0);
		assert.strictEqual(result.creates.length, 1);
		assert.strictEqual(result.creates[0].uri, uri);
		assert.ok(result.creates[0].content.includes('public class StudentService'));
	});

	test('rejects an unknown Java insert when it is not a complete matching source file', () => {
		const result = parseLocalAIAgentResponse(`<insert uri="file:///workspace/src/main/java/com/example/demo/StudentService.java" position="before_main"><![CDATA[
public void save(Student student) { }
]]></insert>`, [], 'Create StudentService like EmployeeService');

		assert.strictEqual(result.creates.length, 0);
		assert.ok(result.errors.some(error => error.startsWith('Unknown insert target:')));
	});

	test('planner subagent receives bounded workspace paths without editable directory targets', () => {
		const messages = formatAgentPlannerMessages('Implement EmployeeService', [{
			uri: 'file:///workspace',
			name: 'workspace',
			files: ['pom.xml', 'src/main/java/com/example/EmployeeService.java'],
		}], []);

		assert.ok(messages[0].content.includes('Planner subagent'));
		assert.ok(messages[0].content.includes('Never use untitled: URIs'));
		assert.ok(messages[0].content.includes('new workspace-relative file path'));
		assert.ok(messages[1].content.includes('src/main/java/com/example/EmployeeService.java'));
	});

	test('lead planner splits large requests into isolated feature tasks', () => {
		const messages = formatAgentTaskPlannerMessages('Add employee CRUD and audit logging', [{
			uri: 'file:///workspace',
			name: 'workspace',
			files: ['src/EmployeeService.java', 'src/AuditService.java'],
		}], [], 4);

		assert.ok(messages[0].content.includes('at most 4 cohesive feature tasks'));
		assert.ok(messages[0].content.includes('needs_tests="true|false"'));
		assert.ok(messages[0].content.includes('A path may belong to only one parallel task'));
		assert.ok(messages[1].content.includes('src/EmployeeService.java'));
	});

	test('feature subagents receive isolated task prompts for implementation review and testing', () => {
		const task: ILocalAIAgentFeatureTask = {
			id: 'feature-employee',
			title: 'Employee storage',
			instruction: 'Store employees in an ArrayList.',
			paths: ['src/EmployeeService.java'],
			needsTests: true,
		};
		const attachments = [{
			uri: 'file:///workspace/src/EmployeeService.java',
			name: 'src/EmployeeService.java',
			content: 'public class EmployeeService {}',
		}];
		const roots = [{ uri: 'file:///workspace', name: 'workspace', files: ['src/EmployeeService.java'] }];

		const implementer = formatAgentFeatureImplementerMessages(undefined, 'Add employee storage', task, attachments, roots);
		assert.ok(implementer[0].content.includes('Feature Implementer feature-employee'));
		assert.ok(implementer.at(-1)?.content.includes('<feature_task id="feature-employee"'));
		assert.ok(implementer.at(-1)?.content.includes('src/EmployeeService.java'));

		const reviewer = formatAgentFeatureReviewerMessages('Add employee storage', task, '<edit>candidate</edit>', attachments, ['Check initialization']);
		assert.ok(reviewer[0].content.includes('verdict="approved|changes_required"'));
		assert.ok(reviewer[1].content.includes('<candidate_response>'));
		assert.ok(reviewer[1].content.includes('Check initialization'));

		const tester = formatAgentTesterMessages('Add employee storage', task, '<edit>candidate</edit>', attachments, ['./mvnw test']);
		assert.ok(tester[0].content.includes('Never claim that a command ran'));
		assert.ok(tester[1].content.includes('./mvnw test'));
		assert.ok(tester[1].content.includes('feature-employee'));
	});

	test('reviewer subagent receives exact parser feedback for one repair attempt', () => {
		const messages = formatAgentRepairMessages(undefined, 'Implement EmployeeService', '<insert position="before_main">bad</insert>', [
			'before_main insertion is only supported for Python files: EmployeeService.java',
		], [{
			uri: 'file:///workspace/EmployeeService.java',
			name: 'EmployeeService.java',
			content: 'public class EmployeeService {}',
		}], [{ uri: 'file:///workspace', name: 'workspace', files: ['EmployeeService.java'] }]);

		assert.strictEqual(messages.at(-1)?.role, 'user');
		assert.ok(messages.at(-1)?.content.includes('Reviewer subagent'));
		assert.ok(messages.at(-1)?.content.includes('before_main insertion is only supported for Python'));
		assert.ok(messages.at(-1)?.content.includes('Do not explain the error'));
	});

	test('reviewer converts an invalid new Java insert into a create operation', () => {
		const messages = formatAgentRepairMessages(undefined, 'Create StudentService like EmployeeService', '<insert uri="file:///workspace/src/main/java/com/example/StudentService.java" position="before_main">bad</insert>', [
			'Unknown insert target: file:///workspace/src/main/java/com/example/StudentService.java',
		], [], [{ uri: 'file:///workspace', name: 'workspace', files: ['src/main/java/com/example/EmployeeService.java'] }]);

		assert.ok(messages[0].content.includes('convert the invalid insert into one create operation'));
		assert.ok(messages.at(-1)?.content.includes('complete file'));
		assert.ok(messages.at(-1)?.content.includes('workspace roots'));
	});

	test('reviewer uses a complete-file contract for an already malformed Java target', () => {
		const messages = formatAgentRepairMessages(undefined, 'Implement EmployeeService', '<edit>bad</edit>', [
			'Existing Java target is structurally invalid: The Java proposal has unbalanced braces. Return exactly one complete <file> repair for this URI: file:///workspace/EmployeeService.java',
		], [{
			uri: 'file:///workspace/EmployeeService.java',
			name: 'EmployeeService.java',
			content: 'public class EmployeeService { } }',
		}], [{ uri: 'file:///workspace', name: 'workspace', files: ['EmployeeService.java'] }]);

		assert.ok(messages[0].content.includes('MUST return exactly one file operation'));
		assert.ok(messages[0].content.includes('complete corrected Java file'));
		assert.ok(!messages[0].content.includes('Use separate exact edit operations'));
		assert.strictEqual(messages.length, 2);
		assert.ok(messages[1].content.includes('<required_file_uri><![CDATA[file:///workspace/EmployeeService.java]]></required_file_uri>'));
		assert.ok(!messages.some(message => message.role === 'assistant'));
	});

	test('applies a targeted edit without changing surrounding code', () => {
		const originalText = 'from fastapi import FastAPI\n\napp = FastAPI()\n\ndef existing():\n\treturn true\n';
		const result = parseLocalAIAgentResponse(`
<local_ai_agent_response>
<summary>Add health API</summary>
<changes>
<edit uri="file:///api.py">
<search><![CDATA[app = FastAPI()]]></search>
<replace><![CDATA[app = FastAPI()

@app.get("/health")
def health():
\treturn {"status": "ok"}]]></replace>
</edit>
</changes>
</local_ai_agent_response>`, [{ id: 'file:///api.py', displayPath: 'api.py', originalText }]);

		assert.strictEqual(result.errors.length, 0);
		assert.strictEqual(result.files.length, 1);
		assert.ok(result.files[0].content.includes('@app.get("/health")'));
		assert.ok(result.files[0].content.includes('def existing():'));
	});

	test('recovers Java imports and annotation edits emitted by a small local model', () => {
		const originalText = `package com.example.demo;

import org.springframework.web.bind.annotation.*;

@RestController
public class EmployeeController {
    @GetMapping("/{id}")
    public Employee findEmployee(@PathVariable Long id) {
        return null;
    }
}
`;
		const result = parseLocalAIAgentResponse(`<local_ai_agent_response><changes>
<insert uri='file:///EmployeeController.java' position='before_main'><![CDATA[import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
Add these imports before the controller declaration.]]></insert>
<edit uri='file:///EmployeeController.java'><search><![CDATA[@RestController]]></search><replace><![CDATA[@RestController
@Api(tags = "Employees")]]></replace></edit>
<edit uri='file:///EmployeeController.java'><search><![CDATA[@GetMapping]]></search><replace><![CDATA[@GetMapping
@ApiOperation(value = "Find employee")]]></replace></edit>
</changes></local_ai_agent_response>`, [{ id: 'file:///EmployeeController.java', displayPath: 'EmployeeController.java', originalText }]);

		assert.deepStrictEqual(result.errors, []);
		assert.strictEqual(result.files.length, 1);
		assert.ok(result.files[0].content.includes('import io.swagger.annotations.Api;'));
		assert.ok(result.files[0].content.includes('@GetMapping("/{id}")\n    @ApiOperation'));
		assert.ok(!result.files[0].content.includes('@ApiOperation(value = "Find employee")("/{id}")'));
	});

	test('recovers the exact Swagger request when a 3B model returns no file operations', () => {
		const controller = `package com.example.demo;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/employees")
public class EmployeeController {
    private final EmployeeService employeeService;

    @PostMapping
    public ResponseEntity<String> createEmployee(@RequestBody Employee employee) {
        employeeService.save(employee);
        return ResponseEntity.ok("Employee created successfully");
    }

    @DeleteMapping("/{id}")
    public void deleteEmployee(@PathVariable Long id) {
        employeeService.delete(id);
    }
}
`;
		const pom = `<project>
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.1.2</version>
    </parent>
    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-webmvc</artifactId>
        </dependency>
    </dependencies>
</project>
`;
		const instruction = 'I want to add Swagger API documentation to @{src/main/java/com/example/demo/EmployeeController.java} and add the required dependencies.';
		const result = parseLocalAIAgentResponse('I added Swagger documentation and the required dependency.', [{
			id: 'file:///workspace/src/main/java/com/example/demo/EmployeeController.java',
			displayPath: 'src/main/java/com/example/demo/EmployeeController.java',
			originalText: controller,
		}, {
			id: 'file:///workspace/pom.xml',
			displayPath: 'pom.xml',
			originalText: pom,
		}], instruction);

		assert.deepStrictEqual(result.errors, []);
		assert.strictEqual(result.files.length, 2);
		const updatedController = result.files.find(file => file.targetId.endsWith('EmployeeController.java'))?.content ?? '';
		const updatedPom = result.files.find(file => file.targetId.endsWith('pom.xml'))?.content ?? '';
		assert.ok(updatedController.includes('import io.swagger.v3.oas.annotations.Operation;'));
		assert.ok(updatedController.includes('import io.swagger.v3.oas.annotations.tags.Tag;'));
		assert.ok(updatedController.includes('@Tag(name = "Employee API", description = "Employee management endpoints")'));
		assert.ok(updatedController.includes('@Operation(summary = "Create employee")\n    @PostMapping'));
		assert.ok(updatedController.includes('@Operation(summary = "Delete employee")\n    @DeleteMapping("/{id}")'));
		assert.ok(updatedController.includes('employeeService.save(employee);'));
		assert.ok(updatedController.includes('employeeService.delete(id);'));
		assert.ok(updatedPom.includes('<artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>'));
		assert.ok(updatedPom.includes('<version>3.2.0</version>'));
	});

	test('recovers independently when the planner splits Swagger annotations and dependencies', () => {
		const controller = 'package demo;\n\nimport org.springframework.web.bind.annotation.*;\n\n@RestController\npublic class EmployeeController {\n    @GetMapping("/{id}")\n    public String findEmployee() { return "employee"; }\n}\n';
		const controllerResult = parseLocalAIAgentResponse('', [{
			id: 'file:///workspace/EmployeeController.java',
			displayPath: 'src/EmployeeController.java',
			originalText: controller,
		}], 'Add Swagger API documentation to EmployeeController');
		assert.deepStrictEqual(controllerResult.errors, []);
		assert.strictEqual(controllerResult.files.length, 1);
		assert.ok(controllerResult.files[0].content.includes('@Operation(summary = "Find employee")'));

		const pom = '<project>\n<parent><groupId>org.springframework.boot</groupId><version>4.1.2</version></parent>\n<dependencies>\n</dependencies>\n</project>\n';
		const dependencyResult = parseLocalAIAgentResponse('', [{
			id: 'file:///workspace/pom.xml',
			displayPath: 'pom.xml',
			originalText: pom,
		}], 'Add the required Swagger dependencies');
		assert.deepStrictEqual(dependencyResult.errors, []);
		assert.strictEqual(dependencyResult.files.length, 1);
		assert.ok(dependencyResult.files[0].content.includes('springdoc-openapi-starter-webmvc-ui'));
	});

	test('places dependency inserts inside an XML dependencies element', () => {
		const originalText = '<project>\n\t<dependencies>\n\t</dependencies>\n</project>\n';
		const result = parseLocalAIAgentResponse(`<local_ai_agent_response><changes>
<insert uri="file:///pom.xml" position="before_main"><![CDATA[<dependency>
    <groupId>org.springdoc</groupId>
    <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>
</dependency>]]></insert>
</changes></local_ai_agent_response>`, [{ id: 'file:///pom.xml', displayPath: 'pom.xml', originalText }]);

		assert.deepStrictEqual(result.errors, []);
		assert.strictEqual(result.files.length, 1);
		assert.ok(result.files[0].content.indexOf('<artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>') < result.files[0].content.indexOf('</dependencies>'));
	});

	test('accepts one complete fenced repair only when the target is unambiguous', () => {
		const repaired = 'package demo;\n\npublic class EmployeeController {\n}\n';
		const result = parseLocalAIAgentResponse(`Here is the corrected file:\n\n\`\`\`java\n${repaired}\`\`\``, [{
			id: 'file:///EmployeeController.java',
			displayPath: 'EmployeeController.java',
			originalText: 'package demo;\npublic class EmployeeController {}\n',
		}]);

		assert.deepStrictEqual(result.errors, []);
		assert.strictEqual(result.files.length, 1);
		assert.strictEqual(result.files[0].content, repaired);
	});

	test('does not apply a file when a search block is ambiguous', () => {
		const result = parseLocalAIAgentResponse('<edit uri="file:///api.py"><search>same</search><replace>new</replace></edit>', [{
			id: 'file:///api.py',
			displayPath: 'api.py',
			originalText: 'same\nsame\n',
		}]);

		assert.strictEqual(result.files.length, 0);
		assert.ok(result.errors[0].includes('matched 2 times'));
	});

	test('inserts a Python route deterministically before the main entrypoint', () => {
		const originalText = 'app = FastAPI()\n\ndef existing():\n\treturn True\n\nif __name__ == "__main__":\n\timport uvicorn\n\tuvicorn.run(app)\n';
		const result = parseLocalAIAgentResponse(`
<local_ai_agent_response><summary>Add health route</summary><changes>
<insert uri="file:///api.py" position="before_main"><![CDATA[@app.get("/health")
async def health():
	return {"ok": True}]]></insert>
</changes></local_ai_agent_response>`, [{ id: 'file:///api.py', displayPath: 'api.py', originalText }]);

		assert.deepStrictEqual(result.errors, []);
		assert.strictEqual(result.files.length, 1);
		assert.ok(result.files[0].content.indexOf('async def health') > result.files[0].content.indexOf('def existing'));
		assert.ok(result.files[0].content.indexOf('async def health') < result.files[0].content.indexOf('if __name__'));
		assert.ok(result.files[0].content.includes('def existing():\n\treturn True'));
	});

	test('rejects a before_main insertion that is not a top-level definition', () => {
		const result = parseLocalAIAgentResponse('<insert uri="file:///api.py" position="before_main"><![CDATA[session = get_session()]]></insert>', [{
			id: 'file:///api.py',
			displayPath: 'api.py',
			originalText: 'app = FastAPI()\n',
		}]);

		assert.strictEqual(result.files.length, 0);
		assert.ok(result.errors[0].includes('standalone top-level Python definition'));
	});

	test('parses a complete new file without treating it as an existing-file replacement', () => {
		const result = parseLocalAIAgentResponse(`
<local_ai_agent_response><summary>Add employee service</summary><changes>
<create uri="file:///workspace/src/main/java/com/example/service/EmployeeService.java"><![CDATA[package com.example.service;

public class EmployeeService {
}]]></create>
</changes></local_ai_agent_response>`, []);

		assert.deepStrictEqual(result.errors, []);
		assert.strictEqual(result.files.length, 0);
		assert.strictEqual(result.creates.length, 1);
		assert.strictEqual(result.creates[0].uri, 'file:///workspace/src/main/java/com/example/service/EmployeeService.java');
		assert.ok(result.creates[0].content.includes('public class EmployeeService'));
	});

	test('rejects a truncated complete-file response for an additive request', () => {
		const originalText = Array.from({ length: 100 }, (_, index) => `existing_line_${index}`).join('\n');
		const validation = validateLocalAIAgentProposal(originalText, 'new_api_service\n', 'add a new API service');

		assert.strictEqual(validation.safe, false);
		assert.strictEqual(validation.removedNonEmptyLines, 100);
	});

	test('allows explicit destructive requests', () => {
		const originalText = Array.from({ length: 100 }, (_, index) => `existing_line_${index}`).join('\n');
		const validation = validateLocalAIAgentProposal(originalText, 'replacement\n', 'rewrite the entire file');

		assert.strictEqual(validation.safe, true);
	});

	test('allows a standalone Python endpoint after an existing complete definition', () => {
		const originalText = '@app.get("/history")\nasync def get_history():\n\treturn []\n';
		const proposedText = `${originalText}\n@app.get("/os-specs")\nasync def get_os_specs():\n\treturn {"os": "test"}\n`;
		const validation = validateLocalAIAgentProposal(originalText, proposedText, 'add a new API endpoint for OS specs', 'api.py');

		assert.strictEqual(validation.safe, true);
	});

	test('rejects a Python endpoint inserted inside an existing function body', () => {
		const originalText = '@app.get("/history")\nasync def get_history():\n\tsession = get_session()\n\thistory = []\n\treturn history\n';
		const proposedText = '@app.get("/history")\nasync def get_history():\n\tsession = get_session()\n\n@app.get("/os-specs")\nasync def get_os_specs():\n\treturn {"os": "test"}\n\n\thistory = []\n\treturn history\n';
		const validation = validateLocalAIAgentProposal(originalText, proposedText, 'add a new API service for OS specs', 'api.py');

		assert.strictEqual(validation.safe, false);
		assert.ok(validation.reason?.includes('get_history'));
	});

	test('allows a Python service before the main entrypoint', () => {
		const originalText = 'app = FastAPI()\n\nif __name__ == "__main__":\n\timport uvicorn\n\tuvicorn.run(app)\n';
		const proposedText = 'app = FastAPI()\n\n@app.get("/health")\ndef health():\n\treturn {"ok": True}\n\nif __name__ == "__main__":\n\timport uvicorn\n\tuvicorn.run(app)\n';
		const validation = validateLocalAIAgentProposal(originalText, proposedText, 'add a new API service', 'api.py');

		assert.strictEqual(validation.safe, true);
	});

	test('rejects executable Python code after the main entrypoint', () => {
		const originalText = 'app = FastAPI()\n\nif __name__ == "__main__":\n\timport uvicorn\n\tuvicorn.run(app)\n';
		const proposedText = `${originalText}\n@app.get("/health")\ndef health():\n\treturn {"ok": True}\n`;
		const validation = validateLocalAIAgentProposal(originalText, proposedText, 'add a new API service', 'api.py');

		assert.strictEqual(validation.safe, false);
		assert.ok(validation.reason?.includes('last executable section'));
	});

	test('instructs additive Agent edits to preserve existing definitions', () => {
		const messages = formatChatMessages(undefined, 'add a health API service', [], 'agent', [], [{
			uri: 'file:///workspace',
			name: 'workspace',
			files: ['pom.xml', 'src/main/java/com/example/DemoApplication.java'],
		}]);
		const systemPrompt = messages[0].content;
		const userPrompt = messages.at(-1)!.content;

		assert.ok(systemPrompt.includes('add new standalone definitions'));
		assert.ok(systemPrompt.includes('do not repurpose an existing function, route, or service'));
		assert.ok(systemPrompt.includes('position="before_main"'));
		assert.ok(systemPrompt.includes('Orbyte will calculate its safe placement'));
		assert.ok(systemPrompt.includes('<create uri='));
		assert.ok(systemPrompt.includes('<edit uri='));
		assert.ok(!systemPrompt.includes('complete replacement file content'));
		assert.ok(userPrompt.includes('<workspace_root uri="file:///workspace"'));
		assert.ok(userPrompt.includes('src/main/java/com/example/DemoApplication.java'));
	});
});
