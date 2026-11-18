/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { normalizeAzureTasks, normalizeJiraTasks, summarizeTaskProjects } from '../../browser/orbyteTaskDashboard.js';

suite('Orbyte task dashboard', () => {

	test('normalizes Jira issues and groups project workload', () => {
		const tasks = normalizeJiraTasks({
			issues: [{
				id: '1001',
				key: 'ORB-42',
				fields: {
					summary: 'Create the task dashboard',
					status: { name: 'In Progress' },
					priority: { name: 'High' },
					project: { name: 'Orbyte' },
					updated: '2026-11-18T10:00:00.000Z',
				},
			}],
		}, { provider: 'jira', baseUrl: 'https://orbyte.atlassian.net', email: 'dev@orbyte.test' });

		assert.deepStrictEqual(tasks, [{
			provider: 'jira',
			id: '1001',
			key: 'ORB-42',
			title: 'Create the task dashboard',
			project: 'Orbyte',
			state: 'in-progress',
			stateLabel: 'In Progress',
			priority: 'High',
			updated: '2026-11-18T10:00:00.000Z',
			url: 'https://orbyte.atlassian.net/browse/ORB-42',
		}]);
		assert.deepStrictEqual(summarizeTaskProjects(tasks), [{ name: 'Orbyte', provider: 'jira', total: 1, inProgress: 1, attention: 1 }]);
	});

	test('normalizes Azure DevOps work items', () => {
		const tasks = normalizeAzureTasks({
			value: [{
				id: 77,
				fields: {
					'System.Title': 'Review onboarding flow',
					'System.State': 'Active',
					'System.TeamProject': 'Developer Experience',
					'Microsoft.VSTS.Common.Priority': 1,
					'System.ChangedDate': '2026-11-18T11:00:00.000Z',
				},
			}],
		}, { provider: 'azure', organizationUrl: 'https://dev.azure.com/orbyte', project: 'Developer Experience' });

		assert.deepStrictEqual(tasks, [{
			provider: 'azure',
			id: '77',
			key: '#77',
			title: 'Review onboarding flow',
			project: 'Developer Experience',
			state: 'in-progress',
			stateLabel: 'Active',
			priority: 'P1',
			updated: '2026-11-18T11:00:00.000Z',
			url: 'https://dev.azure.com/orbyte/Developer%20Experience/_workitems/edit/77',
		}]);
	});

	test('ignores malformed task records', () => {
		assert.deepStrictEqual(normalizeJiraTasks({ issues: [{ key: 'ORB-1', fields: {} }] }, { provider: 'jira', baseUrl: 'https://orbyte.atlassian.net', email: 'dev@orbyte.test' }), []);
		assert.deepStrictEqual(normalizeAzureTasks({ value: [{ id: 1, fields: {} }] }, { provider: 'azure', organizationUrl: 'https://dev.azure.com/orbyte', project: 'Orbyte' }), []);
	});
});
