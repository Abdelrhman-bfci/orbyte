/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { parseLocalAIAgentResponse, validateLocalAIAgentProposal } from '../../browser/context/agentEditProtocol.js';
import { formatChatMessages } from '../../browser/context/promptFormatter.js';

suite('Local AI Java Agent protocol', () => {
	const employeeServiceUri = 'file:///workspace/src/main/java/com/example/demo/service/EmployeeService.java';
	const originalEmployeeService = `package com.example.demo.service;

import com.example.demo.model.Employee;
import org.springframework.stereotype.Service;

@Service
public class EmployeeService {

	public Employee addEmployee(Employee employee) {
		return employee;
	}

	public Employee updateEmployee(Employee employee) {
		return employee;
	}

	public void deleteEmployee(long id) {
	}
}
`;

	test('applies separate import, field, and method edits without moving code outside the class', () => {
		const result = parseLocalAIAgentResponse(`
<local_ai_agent_response><summary>Store employees in memory</summary><changes>
<edit uri="${employeeServiceUri}">
<search><![CDATA[import com.example.demo.model.Employee;
import org.springframework.stereotype.Service;]]></search>
<replace><![CDATA[import com.example.demo.model.Employee;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Service;]]></replace>
</edit>
<edit uri="${employeeServiceUri}">
<search><![CDATA[public class EmployeeService {

	public Employee addEmployee]]></search>
<replace><![CDATA[public class EmployeeService {

	private final List<Employee> employees = new ArrayList<>();

	public Employee addEmployee]]></replace>
</edit>
<edit uri="${employeeServiceUri}">
<search><![CDATA[	public Employee addEmployee(Employee employee) {
		return employee;
	}]]></search>
<replace><![CDATA[	public Employee addEmployee(Employee employee) {
		employees.add(employee);
		return employee;
	}]]></replace>
</edit>
</changes></local_ai_agent_response>`, [{
			id: employeeServiceUri,
			displayPath: 'src/main/java/com/example/demo/service/EmployeeService.java',
			originalText: originalEmployeeService,
		}]);

		assert.deepStrictEqual(result.errors, []);
		assert.strictEqual(result.files.length, 1);
		const content = result.files[0].content;
		assert.ok(content.includes('private final List<Employee> employees = new ArrayList<>();'));
		assert.ok(content.indexOf('private final List<Employee>') > content.indexOf('public class EmployeeService {'));
		assert.ok(content.indexOf('private final List<Employee>') < content.indexOf('public Employee addEmployee'));
		assert.ok(content.trimEnd().endsWith('}'));
		assert.strictEqual(validateLocalAIAgentProposal(originalEmployeeService, content, 'Implement EmployeeService to save data in an ArrayList', 'EmployeeService.java').safe, true);
	});

	test('repairs an uninitialized ArrayList field emitted inside a method', () => {
		const result = parseLocalAIAgentResponse(`
<local_ai_agent_response><summary>Store employees in memory</summary><changes>
<edit uri="${employeeServiceUri}">
<search><![CDATA[	public Employee addEmployee(Employee employee) {
		return employee;
	}]]></search>
<replace><![CDATA[	public Employee addEmployee(Employee employee) {
		private final List<Employee> employees;
		employees.add(employee);
		return employee;
	}]]></replace>
</edit>
</changes></local_ai_agent_response>`, [{
			id: employeeServiceUri,
			displayPath: 'src/main/java/com/example/demo/service/EmployeeService.java',
			originalText: originalEmployeeService,
		}], 'Implement EmployeeService to save data in an ArrayList');

		assert.deepStrictEqual(result.errors, []);
		assert.strictEqual(result.files.length, 1);
		const content = result.files[0].content;
		assert.ok(content.includes('import java.util.List;'));
		assert.ok(content.includes('import java.util.ArrayList;'));
		assert.strictEqual(content.match(/private final List<Employee> employees = new ArrayList<>\(\);/g)?.length, 1);
		assert.ok(content.indexOf('private final List<Employee> employees') > content.indexOf('public class EmployeeService {'));
		assert.ok(content.indexOf('private final List<Employee> employees') < content.indexOf('public Employee addEmployee'));
		assert.ok(!content.includes('\t\tprivate final List<Employee>'));
		assert.strictEqual(validateLocalAIAgentProposal(originalEmployeeService, content, 'Implement EmployeeService to save data in an ArrayList', 'EmployeeService.java').safe, true);
	});

	test('converts a Java before_main field mistake into a class member', () => {
		const result = parseLocalAIAgentResponse(`
<local_ai_agent_response><summary>Add storage</summary><changes>
<insert uri="${employeeServiceUri}" position="before_main"><![CDATA[private final List<Employee> employees = new ArrayList<>();]]></insert>
</changes></local_ai_agent_response>`, [{
			id: employeeServiceUri,
			displayPath: 'src/main/java/com/example/demo/service/EmployeeService.java',
			originalText: originalEmployeeService,
		}], 'Implement EmployeeService to save data in an ArrayList');

		assert.deepStrictEqual(result.errors, []);
		assert.strictEqual(result.files.length, 1);
		const content = result.files[0].content;
		assert.ok(content.includes('import java.util.List;'));
		assert.ok(content.includes('import java.util.ArrayList;'));
		assert.ok(content.indexOf('private final List<Employee> employees = new ArrayList<>();') > content.indexOf('public class EmployeeService {'));
		assert.strictEqual(validateLocalAIAgentProposal(originalEmployeeService, content, 'Implement EmployeeService to save data in an ArrayList', 'EmployeeService.java').safe, true);
	});

	test('allows a complete validated repair of an already malformed Java class', () => {
		const malformed = `package com.example.demo;

public class EmployeeService {
	public void save(Employee employee) {
	}
}
}
`;
		const repaired = `package com.example.demo;

import java.util.ArrayList;
import java.util.List;

public class EmployeeService {
	private final List<Employee> employees = new ArrayList<>();

	public void save(Employee employee) {
		employees.add(employee);
	}
}
`;
		const validation = validateLocalAIAgentProposal(malformed, repaired, 'Implement EmployeeService to save data in an ArrayList', 'EmployeeService.java');

		assert.strictEqual(validation.safe, true, validation.reason);
	});

	test('rejects an EmployeeService field placed after the class closing brace', () => {
		const misplaced = `${originalEmployeeService}\nprivate final List<Employee> employees = new ArrayList<>();\n`;
		const validation = validateLocalAIAgentProposal(originalEmployeeService, misplaced, 'Implement EmployeeService to save data in an ArrayList', 'EmployeeService.java');

		assert.strictEqual(validation.safe, false);
		assert.ok(validation.reason?.includes('outside'));
	});

	test('rejects an in-memory collection that is used without initialization', () => {
		const uninitialized = originalEmployeeService
			.replace('public class EmployeeService {', 'public class EmployeeService {\n\n\tprivate final List<Employee> employees;')
			.replace('\t\treturn employee;', '\t\temployees.add(employee);\n\t\treturn employee;');
		const validation = validateLocalAIAgentProposal(originalEmployeeService, uninitialized, 'Implement EmployeeService to save data in an ArrayList', 'EmployeeService.java');

		assert.strictEqual(validation.safe, false);
		assert.ok(validation.reason?.includes('initialized'));
	});

	test('tells the model to initialize Java collection fields inside the owning class', () => {
		const messages = formatChatMessages(undefined, 'Implement EmployeeService to save data in an ArrayList', [], 'agent', [{
			uri: employeeServiceUri,
			name: 'EmployeeService.java',
			content: originalEmployeeService,
		}]);
		const prompt = messages[0].content;

		assert.ok(prompt.includes('inside the owning class'));
		assert.ok(prompt.includes('new ArrayList<>()'));
	});
});
