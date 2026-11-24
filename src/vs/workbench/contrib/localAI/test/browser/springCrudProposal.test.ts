/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { checkSpringCrudProposal, createInMemorySpringCrudFiles, getSpringCrudContract } from '../../browser/context/springCrudProposal.js';

suite('Local Agent Spring CRUD proposal', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const path = 'src/main/java/com/example/demo/EmployeeService.java';
	const reference = 'package com.example.demo;\nimport org.springframework.stereotype.Service;\n@Service class EmployeeService { private List<Employee> staff = new ArrayList<>(); }';
	const instruction = 'i want create new service for User with his controller and with curd method and his logic';

	test('checks a missing class, update route and controller return contract', () => {
		const contract = getSpringCrudContract(instruction, path, reference);
		assert.ok(contract?.boilerplate);
		const proposal = new Map([
			['UserService.java', 'package com.example.demo;\nclass UserService { void save(User user) {} }'],
			['UserController.java', 'package com.example.demo;\nclass UserController { UserService userService; @PostMapping User create(User user) { return userService.save(user); } @GetMapping void read() {} @DeleteMapping void delete() {} }'],
		]);
		const errors = checkSpringCrudProposal(contract, proposal, new Set());
		assert.strictEqual(errors.length, 3);
		assert.ok(errors.some(error => error.includes('User.java')));
		assert.ok(errors.some(error => error.includes('@PutMapping')));
		assert.ok(errors.some(error => error.includes('returns void')));
	});

	test('builds a complete proposal and respects explicit schema requirements', () => {
		const contract = getSpringCrudContract(instruction, path, reference);
		assert.ok(contract);
		const files = createInMemorySpringCrudFiles(contract);
		assert.deepStrictEqual([...files.keys()], ['User.java', 'UserService.java', 'UserController.java']);
		assert.deepStrictEqual(checkSpringCrudProposal(contract, files, new Set()), []);
		assert.strictEqual(getSpringCrudContract(`${instruction} with an email field`, path, reference)?.boilerplate, false);
		assert.strictEqual(getSpringCrudContract(instruction, path, reference.replace('@Service', '')), undefined);
	});
});
