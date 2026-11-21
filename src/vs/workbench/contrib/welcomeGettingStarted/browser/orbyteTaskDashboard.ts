/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode } from '../../../../base/browser/dom.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { orbyteBrandIconSrc } from '../../../browser/orbyteBrand.js';

export type OrbyteTaskProvider = 'jira' | 'azure';
export type OrbyteTaskState = 'open' | 'in-progress' | 'blocked' | 'done';

export interface IOrbyteTask {
	readonly provider: OrbyteTaskProvider;
	readonly id: string;
	readonly key: string;
	readonly title: string;
	readonly project: string;
	readonly state: OrbyteTaskState;
	readonly stateLabel: string;
	readonly priority: string;
	readonly updated?: string;
	readonly url: string;
}

export interface IOrbyteProjectSummary {
	readonly name: string;
	readonly provider: OrbyteTaskProvider;
	readonly total: number;
	readonly inProgress: number;
	readonly attention: number;
}

interface IJiraConnection {
	readonly provider: 'jira';
	readonly baseUrl: string;
	readonly email: string;
	readonly project?: string;
}

interface IAzureConnection {
	readonly provider: 'azure';
	readonly organizationUrl: string;
	readonly project: string;
}

type OrbyteTaskConnection = IJiraConnection | IAzureConnection;

export interface IOrbyteTaskDashboardSnapshot {
	readonly tasks: readonly IOrbyteTask[];
	readonly projects: readonly IOrbyteProjectSummary[];
	readonly connectedProviders: readonly OrbyteTaskProvider[];
	readonly errors: ReadonlyMap<OrbyteTaskProvider, string>;
	readonly syncedAt: number;
}

const CONNECTIONS_STORAGE_KEY = 'orbyte.taskDashboard.connections.v1';
const JIRA_TOKEN_SECRET_KEY = 'orbyte.taskDashboard.jira.apiToken';
const AZURE_TOKEN_SECRET_KEY = 'orbyte.taskDashboard.azure.pat';

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function asArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function normalizeUrl(value: string): string {
	return value.trim().replace(/\/+$/, '');
}

function classifyState(label: string): OrbyteTaskState {
	const normalized = label.toLowerCase();
	if (/done|closed|resolved|complete|removed/.test(normalized)) {
		return 'done';
	}
	if (/blocked|impediment|on hold/.test(normalized)) {
		return 'blocked';
	}
	if (/progress|active|doing|implementation|development/.test(normalized)) {
		return 'in-progress';
	}
	return 'open';
}

export function normalizeJiraTasks(value: unknown, connection: IJiraConnection): IOrbyteTask[] {
	const response = asRecord(value);
	return asArray(response?.issues).flatMap(issueValue => {
		const issue = asRecord(issueValue);
		const fields = asRecord(issue?.fields);
		const key = asString(issue?.key);
		const title = asString(fields?.summary);
		if (!key || !title) {
			return [];
		}
		const status = asRecord(fields?.status);
		const priority = asRecord(fields?.priority);
		const project = asRecord(fields?.project);
		const stateLabel = asString(status?.name, localize('orbyte.task.open', "Open"));
		return [{
			provider: 'jira' as const,
			id: asString(issue?.id, key),
			key,
			title,
			project: asString(project?.name, asString(project?.key, connection.project ?? 'Jira')),
			state: classifyState(stateLabel),
			stateLabel,
			priority: asString(priority?.name, localize('orbyte.task.normalPriority', "Normal")),
			updated: asString(fields?.updated) || undefined,
			url: `${connection.baseUrl}/browse/${encodeURIComponent(key)}`,
		}];
	});
}

export function normalizeAzureTasks(value: unknown, connection: IAzureConnection): IOrbyteTask[] {
	const response = asRecord(value);
	return asArray(response?.value).flatMap(itemValue => {
		const item = asRecord(itemValue);
		const fields = asRecord(item?.fields);
		const id = typeof item?.id === 'number' ? String(item.id) : asString(item?.id);
		const title = asString(fields?.['System.Title']);
		if (!id || !title) {
			return [];
		}
		const stateLabel = asString(fields?.['System.State'], localize('orbyte.task.open', "Open"));
		const priorityValue = fields?.['Microsoft.VSTS.Common.Priority'];
		const priority = typeof priorityValue === 'number'
			? localize('orbyte.task.priorityNumber', "P{0}", priorityValue)
			: asString(priorityValue, localize('orbyte.task.normalPriority', "Normal"));
		return [{
			provider: 'azure' as const,
			id,
			key: `#${id}`,
			title,
			project: asString(fields?.['System.TeamProject'], connection.project),
			state: classifyState(stateLabel),
			stateLabel,
			priority,
			updated: asString(fields?.['System.ChangedDate']) || undefined,
			url: `${connection.organizationUrl}/${encodeURIComponent(connection.project)}/_workitems/edit/${encodeURIComponent(id)}`,
		}];
	});
}

export function summarizeTaskProjects(tasks: readonly IOrbyteTask[]): IOrbyteProjectSummary[] {
	const projects = new Map<string, IOrbyteProjectSummary>();
	for (const task of tasks) {
		const mapKey = `${task.provider}:${task.project}`;
		const current = projects.get(mapKey);
		projects.set(mapKey, {
			name: task.project,
			provider: task.provider,
			total: (current?.total ?? 0) + 1,
			inProgress: (current?.inProgress ?? 0) + (task.state === 'in-progress' ? 1 : 0),
			attention: (current?.attention ?? 0) + (task.state === 'blocked' || /highest|high|p1/i.test(task.priority) ? 1 : 0),
		});
	}
	return [...projects.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

class OrbyteTaskDashboardModel {

	constructor(
		private readonly requestService: IRequestService,
		private readonly secretStorageService: ISecretStorageService,
		private readonly storageService: IStorageService,
	) { }

	getConnections(): OrbyteTaskConnection[] {
		try {
			const stored = JSON.parse(this.storageService.get(CONNECTIONS_STORAGE_KEY, StorageScope.PROFILE, '[]')) as unknown;
			const connections: OrbyteTaskConnection[] = [];
			for (const value of asArray(stored)) {
				const candidate = asRecord(value);
				if (candidate?.provider === 'jira' && typeof candidate.baseUrl === 'string' && typeof candidate.email === 'string') {
					connections.push({ provider: 'jira', baseUrl: normalizeUrl(candidate.baseUrl), email: candidate.email, project: asString(candidate.project) || undefined });
				}
				if (candidate?.provider === 'azure' && typeof candidate.organizationUrl === 'string' && typeof candidate.project === 'string') {
					connections.push({ provider: 'azure', organizationUrl: normalizeUrl(candidate.organizationUrl), project: candidate.project });
				}
			}
			return connections;
		} catch {
			return [];
		}
	}

	private storeConnections(connections: readonly OrbyteTaskConnection[]): void {
		this.storageService.store(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections), StorageScope.PROFILE, StorageTarget.USER);
	}

	async connectJira(connection: IJiraConnection, token: string): Promise<void> {
		const connections = this.getConnections().filter(item => item.provider !== 'jira');
		this.storeConnections([...connections, connection]);
		await this.secretStorageService.set(JIRA_TOKEN_SECRET_KEY, token);
	}

	async connectAzure(connection: IAzureConnection, token: string): Promise<void> {
		const connections = this.getConnections().filter(item => item.provider !== 'azure');
		this.storeConnections([...connections, connection]);
		await this.secretStorageService.set(AZURE_TOKEN_SECRET_KEY, token);
	}

	async disconnect(provider: OrbyteTaskProvider): Promise<void> {
		this.storeConnections(this.getConnections().filter(item => item.provider !== provider));
		await this.secretStorageService.delete(provider === 'jira' ? JIRA_TOKEN_SECRET_KEY : AZURE_TOKEN_SECRET_KEY);
	}

	async sync(): Promise<IOrbyteTaskDashboardSnapshot> {
		const connections = this.getConnections();
		const results = await Promise.allSettled(connections.map(connection => connection.provider === 'jira' ? this.syncJira(connection) : this.syncAzure(connection)));
		const tasks: IOrbyteTask[] = [];
		const errors = new Map<OrbyteTaskProvider, string>();
		results.forEach((result, index) => {
			const provider = connections[index].provider;
			if (result.status === 'fulfilled') {
				tasks.push(...result.value);
			} else {
				errors.set(provider, getErrorMessage(result.reason));
			}
		});
		tasks.sort((a, b) => {
			const rank = (task: IOrbyteTask) => task.state === 'blocked' ? 0 : /highest|high|p1/i.test(task.priority) ? 1 : task.state === 'in-progress' ? 2 : 3;
			return rank(a) - rank(b) || (b.updated ?? '').localeCompare(a.updated ?? '');
		});
		return {
			tasks,
			projects: summarizeTaskProjects(tasks),
			connectedProviders: connections.map(connection => connection.provider),
			errors,
			syncedAt: Date.now(),
		};
	}

	private async syncJira(connection: IJiraConnection): Promise<IOrbyteTask[]> {
		const token = await this.secretStorageService.get(JIRA_TOKEN_SECRET_KEY);
		if (!token) {
			throw new Error(localize('orbyte.task.jiraTokenMissing', "The Jira API token is missing. Reconnect Jira."));
		}
		const projectClause = connection.project ? ` AND project = \"${connection.project.replace(/\"/g, '\\\"')}\"` : '';
		const context = await this.requestService.request({
			type: 'POST',
			url: `${connection.baseUrl}/rest/api/3/search/jql`,
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Basic ${encodeBase64(VSBuffer.fromString(`${connection.email}:${token}`))}`,
			},
			data: JSON.stringify({
				jql: `assignee = currentUser() AND (statusCategory != Done OR updated >= -90d)${projectClause} ORDER BY priority ASC, updated DESC`,
				fields: ['summary', 'status', 'priority', 'project', 'updated'],
				maxResults: 50,
			}),
			timeout: 20_000,
			logUrl: false,
			callSite: 'orbyte.taskDashboard.jira',
		}, CancellationToken.None);
		return normalizeJiraTasks(await asJson(context), connection);
	}

	private async syncAzure(connection: IAzureConnection): Promise<IOrbyteTask[]> {
		const token = await this.secretStorageService.get(AZURE_TOKEN_SECRET_KEY);
		if (!token) {
			throw new Error(localize('orbyte.task.azureTokenMissing', "The Azure DevOps PAT is missing. Reconnect Azure DevOps."));
		}
		const headers = {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			Authorization: `Basic ${encodeBase64(VSBuffer.fromString(`:${token}`))}`,
		};
		const projectPath = encodeURIComponent(connection.project);
		const queryContext = await this.requestService.request({
			type: 'POST',
			url: `${connection.organizationUrl}/${projectPath}/_apis/wit/wiql?$top=50&api-version=7.1`,
			headers,
			data: JSON.stringify({ query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me AND ([System.State] NOT IN ('Closed', 'Done', 'Removed') OR [System.ChangedDate] >= @Today - 90) ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC" }),
			timeout: 20_000,
			logUrl: false,
			callSite: 'orbyte.taskDashboard.azure.wiql',
		}, CancellationToken.None);
		const queryResponse = asRecord(await asJson(queryContext));
		const ids = asArray(queryResponse?.workItems).map(item => asRecord(item)?.id).filter((id): id is number => typeof id === 'number');
		if (!ids.length) {
			return [];
		}
		const fields = ['System.Id', 'System.Title', 'System.State', 'System.TeamProject', 'Microsoft.VSTS.Common.Priority', 'System.ChangedDate'].join(',');
		const itemsContext = await this.requestService.request({
			type: 'GET',
			url: `${connection.organizationUrl}/${projectPath}/_apis/wit/workitems?ids=${ids.join(',')}&fields=${encodeURIComponent(fields)}&api-version=7.1`,
			headers,
			timeout: 20_000,
			logUrl: false,
			callSite: 'orbyte.taskDashboard.azure.items',
		}, CancellationToken.None);
		return normalizeAzureTasks(await asJson(itemsContext), connection);
	}
}

function icon(icon: ThemeIcon, className?: string): HTMLElement {
	return $('span', { class: [...ThemeIcon.asClassNameArray(icon), className].filter(Boolean).join(' '), 'aria-hidden': 'true' });
}

function button(label: string, iconValue: ThemeIcon, className = ''): HTMLButtonElement {
	return $(`button.orbyte-dashboard-button${className ? `.${className.replace(/\s+/g, '.')}` : ''}`, { type: 'button' }, icon(iconValue), $('span', {}, label)) as HTMLButtonElement;
}

export class OrbyteTaskDashboard extends Disposable {

	readonly element: HTMLElement;
	private readonly content: HTMLElement;
	private readonly model: OrbyteTaskDashboardModel;
	private readonly renderDisposables = this._register(new DisposableStore());
	private loading = false;
	private taskPage = 0;
	private taskQuery = '';
	private taskState: 'all' | OrbyteTaskState = 'all';
	private taskProvider: 'all' | OrbyteTaskProvider = 'all';
	private readonly taskPageSize = 6;

	constructor(
		requestService: IRequestService,
		secretStorageService: ISecretStorageService,
		storageService: IStorageService,
		private readonly quickInputService: IQuickInputService,
		private readonly notificationService: INotificationService,
		private readonly openerService: IOpenerService,
		private readonly commandService: ICommandService,
		workspaceContextService: IWorkspaceContextService,
		workspaceSection: HTMLElement,
	) {
		super();
		this.model = new OrbyteTaskDashboardModel(requestService, secretStorageService, storageService);
		const workspaceName = workspaceContextService.getWorkspace().folders.map(folder => folder.name).join(', ') || localize('orbyte.task.noWorkspace', "No workspace open");
		const refreshButton = button(localize('orbyte.task.refresh', "Refresh"), Codicon.refresh, 'secondary');
		this._register(addDisposableListener(refreshButton, 'click', () => void this.refresh()));
		this.content = $('.orbyte-dashboard-content');
		this.element = $('.orbyte-task-dashboard', {},
			$('.orbyte-dashboard-heading', {},
				$('.orbyte-dashboard-brand', {},
					$('img.orbyte-dashboard-brand-icon', {
						src: orbyteBrandIconSrc,
						alt: '',
						draggable: 'false',
						'aria-hidden': 'true',
					}),
					$('.orbyte-dashboard-title', {},
						$('.orbyte-dashboard-eyebrow', {}, icon(Codicon.pulse), localize('orbyte.task.workspacePulse', "Orbyte workspace")),
						$('h1', {}, localize('orbyte.task.dashboardTitle', "Plan the work. Ship with confidence.")),
						$('p', {}, localize('orbyte.task.dashboardSubtitle', "One clear view of {0}, your projects, and assigned work.", workspaceName)),
					),
				),
				refreshButton,
			),
			this.content,
			workspaceSection,
		);
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		if (this.loading) {
			return;
		}
		this.loading = true;
		this.renderLoading();
		try {
			this.render(await this.model.sync());
		} catch (error) {
			this.renderFatalError(getErrorMessage(error));
		} finally {
			this.loading = false;
		}
	}

	private renderLoading(): void {
		this.renderDisposables.clear();
		clearNode(this.content);
		append(this.content, $('.orbyte-dashboard-loading', {}, icon(Codicon.loading, 'codicon-modifier-spin'), $('span', {}, localize('orbyte.task.syncing', "Syncing your work…"))));
	}

	private renderFatalError(message: string): void {
		this.renderDisposables.clear();
		clearNode(this.content);
		const retry = button(localize('orbyte.task.tryAgain', "Try again"), Codicon.refresh);
		this.renderDisposables.add(addDisposableListener(retry, 'click', () => void this.refresh()));
		append(this.content, $('.orbyte-dashboard-empty', {}, icon(Codicon.warning), $('h3', {}, localize('orbyte.task.couldNotLoad', "Could not load your work")), $('p', {}, message), retry));
	}

	private render(snapshot: IOrbyteTaskDashboardSnapshot): void {
		this.renderDisposables.clear();
		clearNode(this.content);
		const attention = snapshot.tasks.filter(task => task.state === 'blocked' || /highest|high|p1/i.test(task.priority)).length;
		const stats = $('.orbyte-dashboard-stats', {},
			this.statCard(Codicon.checklist, String(snapshot.tasks.length), localize('orbyte.task.myTasks', "My tasks"), 'cyan'),
			this.statCard(Codicon.run, String(snapshot.tasks.filter(task => task.state === 'in-progress').length), localize('orbyte.task.inProgress', "In progress"), 'violet'),
			this.statCard(Codicon.warning, String(attention), localize('orbyte.task.needsAttention', "Needs attention"), 'amber'),
			this.statCard(Codicon.project, String(snapshot.projects.length), localize('orbyte.task.projects', "Projects"), 'green'),
		);

		const main = $('.orbyte-dashboard-main', {}, this.renderTaskPanel(snapshot), this.renderProjectsPanel(snapshot));
		append(this.content, stats, main, this.renderIntegrations(snapshot));
	}

	private statCard(iconValue: ThemeIcon, value: string, label: string, accent: string): HTMLElement {
		return $(`.orbyte-stat-card.${accent}`, {}, $('.orbyte-stat-icon', {}, icon(iconValue)), $('.orbyte-stat-copy', {}, $('strong', {}, value), $('span', {}, label)));
	}

	private renderTaskPanel(snapshot: IOrbyteTaskDashboardSnapshot): HTMLElement {
		const panel = $('.orbyte-dashboard-panel.orbyte-task-panel');
		const normalizedQuery = this.taskQuery.trim().toLocaleLowerCase();
		const filteredTasks = snapshot.tasks.filter(task => {
			const matchesState = this.taskState === 'all' || task.state === this.taskState;
			const matchesProvider = this.taskProvider === 'all' || task.provider === this.taskProvider;
			const matchesQuery = !normalizedQuery || [task.title, task.key, task.project, task.priority, task.stateLabel]
				.some(value => value.toLocaleLowerCase().includes(normalizedQuery));
			return matchesState && matchesProvider && matchesQuery;
		});
		const pageCount = Math.max(1, Math.ceil(filteredTasks.length / this.taskPageSize));
		this.taskPage = Math.min(this.taskPage, pageCount - 1);
		const pageTasks = filteredTasks.slice(this.taskPage * this.taskPageSize, (this.taskPage + 1) * this.taskPageSize);
		append(panel, $('.orbyte-panel-header', {}, $('div', {}, $('h3', {}, localize('orbyte.task.myWork', "My work")), $('span', {}, localize('orbyte.task.sortedHint', "Priority and recent activity"))), $('span.orbyte-count', { title: localize('orbyte.task.filteredCount', "{0} of {1} work items", filteredTasks.length, snapshot.tasks.length) }, String(filteredTasks.length))));
		if (!snapshot.connectedProviders.length) {
			append(panel, $('.orbyte-dashboard-empty.compact', {}, icon(Codicon.plug), $('h3', {}, localize('orbyte.task.connectTitle', "Bring your tasks into Orbyte")), $('p', {}, localize('orbyte.task.connectDescription', "Connect Jira or Azure DevOps below. Credentials stay in secure storage."))));
		} else if (!snapshot.tasks.length) {
			append(panel, $('.orbyte-dashboard-empty.compact', {}, icon(Codicon.passFilled), $('h3', {}, localize('orbyte.task.clearTitle', "You're all clear")), $('p', {}, localize('orbyte.task.clearDescription', "No active assigned tasks were returned by the connected tools."))));
		} else {
			const controls = $('.orbyte-task-controls');
			const filterRow = $('.orbyte-task-filter-row');
			const search = $('input.orbyte-task-search', {
				type: 'search',
				value: this.taskQuery,
				placeholder: localize('orbyte.task.searchPlaceholder', "Search issues and work items"),
				'aria-label': localize('orbyte.task.searchLabel', "Search issues and work items"),
			}) as HTMLInputElement;
			const provider = $('select.orbyte-task-provider-filter', { 'aria-label': localize('orbyte.task.providerFilter', "Filter by task provider") },
				$('option', { value: 'all', selected: this.taskProvider === 'all' }, localize('orbyte.task.allProviders', "All tools")),
				$('option', { value: 'jira', selected: this.taskProvider === 'jira' }, 'Jira'),
				$('option', { value: 'azure', selected: this.taskProvider === 'azure' }, 'Azure DevOps'),
			) as HTMLSelectElement;
			this.renderDisposables.add(addDisposableListener(search, 'input', () => {
				this.taskQuery = search.value;
				this.taskPage = 0;
				const caret = search.selectionStart ?? this.taskQuery.length;
				this.render(snapshot);
				const replacement = this.content.querySelector<HTMLInputElement>('.orbyte-task-search');
				replacement?.focus();
				replacement?.setSelectionRange(caret, caret);
			}));
			this.renderDisposables.add(addDisposableListener(provider, 'change', () => {
				this.taskProvider = provider.value as 'all' | OrbyteTaskProvider;
				this.taskPage = 0;
				this.render(snapshot);
			}));
			append(filterRow, $('.orbyte-task-search-wrap', {}, icon(Codicon.search), search), provider);
			const tabs = $('.orbyte-task-status-tabs', { role: 'tablist', 'aria-label': localize('orbyte.task.statusFilter', "Filter by status") });
			const states: readonly { readonly value: 'all' | OrbyteTaskState; readonly label: string }[] = [
				{ value: 'all', label: localize('orbyte.task.allStatuses', "All") },
				{ value: 'open', label: localize('orbyte.task.openStatus', "Open") },
				{ value: 'in-progress', label: localize('orbyte.task.inProgressStatus', "In progress") },
				{ value: 'blocked', label: localize('orbyte.task.blockedStatus', "Blocked") },
				{ value: 'done', label: localize('orbyte.task.doneStatus', "Done") },
			];
			for (const state of states) {
				const count = state.value === 'all' ? snapshot.tasks.length : snapshot.tasks.filter(task => task.state === state.value).length;
				const tab = $(`button.orbyte-task-status-tab${this.taskState === state.value ? '.active' : ''}`, {
					type: 'button', role: 'tab', 'aria-selected': String(this.taskState === state.value),
				}, $('span', {}, state.label), $('small', {}, String(count))) as HTMLButtonElement;
				this.renderDisposables.add(addDisposableListener(tab, 'click', () => {
					this.taskState = state.value;
					this.taskPage = 0;
					this.render(snapshot);
				}));
				append(tabs, tab);
			}
			append(controls, filterRow, tabs);
			append(panel, controls);
			if (!filteredTasks.length) {
				append(panel, $('.orbyte-dashboard-empty.compact.filtered', {}, icon(Codicon.filter), $('h3', {}, localize('orbyte.task.noMatchesTitle', "No matching work")), $('p', {}, localize('orbyte.task.noMatchesDescription', "Change the search, tool, or status filter to see more items."))));
				return panel;
			}
			const list = $('.orbyte-task-list', { role: 'list' });
			for (const task of pageTasks) {
				const item = $('button.orbyte-task-row', { type: 'button', role: 'listitem', title: localize('orbyte.task.openTask', "Open {0}", task.key) },
					$(`.orbyte-provider-mark.${task.provider}`, {}, icon(task.provider === 'jira' ? Codicon.issues : Codicon.azureDevops)),
					$('.orbyte-task-copy', {}, $('.orbyte-task-title', {}, $('strong', {}, task.title), $('span', {}, task.key)), $('.orbyte-task-meta', {}, task.project, ' · ', task.priority)),
					$(`span.orbyte-state-pill.${task.state}`, {}, task.stateLabel),
					icon(Codicon.chevronRight),
				) as HTMLButtonElement;
				this.renderDisposables.add(addDisposableListener(item, 'click', () => void this.openerService.open(URI.parse(task.url))));
				append(list, item);
			}
			const previous = button(localize('orbyte.task.previousPage', "Previous"), Codicon.chevronLeft, 'secondary compact') as HTMLButtonElement;
			const next = button(localize('orbyte.task.nextPage', "Next"), Codicon.chevronRight, 'secondary compact') as HTMLButtonElement;
			previous.disabled = this.taskPage === 0;
			next.disabled = this.taskPage >= pageCount - 1;
			this.renderDisposables.add(addDisposableListener(previous, 'click', () => { this.taskPage--; this.render(snapshot); }));
			this.renderDisposables.add(addDisposableListener(next, 'click', () => { this.taskPage++; this.render(snapshot); }));
			append(panel, list, $('.orbyte-task-pagination', {}, previous, $('span', {}, localize('orbyte.task.pageStatus', "Page {0} of {1}", this.taskPage + 1, pageCount)), next));
		}
		return panel;
	}

	private renderProjectsPanel(snapshot: IOrbyteTaskDashboardSnapshot): HTMLElement {
		const panel = $('.orbyte-dashboard-panel.orbyte-project-panel');
		append(panel, $('.orbyte-panel-header', {}, $('div', {}, $('h3', {}, localize('orbyte.task.projectHealth', "Project health")), $('span', {}, localize('orbyte.task.projectHealthHint', "Open workload by project")))));
		if (!snapshot.projects.length) {
			append(panel, $('.orbyte-project-placeholder', {}, icon(Codicon.project), $('span', {}, localize('orbyte.task.projectEmpty', "Projects appear here after the first sync."))));
			return panel;
		}
		const list = $('.orbyte-project-list');
		for (const project of snapshot.projects.slice(0, 5)) {
			const activePercent = project.total ? Math.max(8, Math.round(project.inProgress / project.total * 100)) : 0;
			append(list, $('.orbyte-project-row', {},
				$('.orbyte-project-topline', {}, $('.orbyte-project-name', {}, icon(project.provider === 'jira' ? Codicon.issues : Codicon.azureDevops), $('strong', {}, project.name)), $('span', {}, localize('orbyte.task.openCount', "{0} open", project.total))),
				$('.orbyte-project-bar', {}, $('span', { style: `width:${activePercent}%` })),
				$('.orbyte-project-detail', {}, $('span', {}, localize('orbyte.task.activeCount', "{0} active", project.inProgress)), $(`span${project.attention ? '.attention' : ''}`, {}, project.attention ? localize('orbyte.task.attentionCount', "{0} need attention", project.attention) : localize('orbyte.task.onTrack', "On track"))),
			));
		}
		append(panel, list);
		return panel;
	}

	private renderIntegrations(snapshot: IOrbyteTaskDashboardSnapshot): HTMLElement {
		const section = $('.orbyte-integrations');
		append(section, $('.orbyte-section-heading', {}, $('div', {}, $('h3', {}, localize('orbyte.task.integrations', "Task integrations")), $('span', {}, localize('orbyte.task.integrationsHint', "Your tokens are encrypted and never shown in the dashboard."))), $('span.orbyte-sync-time', {}, localize('orbyte.task.syncedNow', "Synced now"))));
		const cards = $('.orbyte-integration-cards');
		append(cards,
			this.integrationCard('jira', localize('orbyte.task.jiraName', "Jira Cloud"), localize('orbyte.task.jiraDescription', "Issues, priorities, and project status"), Codicon.issues, snapshot),
			this.integrationCard('azure', localize('orbyte.task.azureName', "Azure DevOps"), localize('orbyte.task.azureDescription', "Boards and assigned work items"), Codicon.azureDevops, snapshot),
		);
		const more = button(localize('orbyte.task.moreTools', "Explore more task tools"), Codicon.extensions, 'secondary more-integrations');
		this.renderDisposables.add(addDisposableListener(more, 'click', () => void this.commandService.executeCommand('workbench.extensions.search', '@tag:issue-tracker')));
		append(cards, $('.orbyte-integration-card.more', {}, $('.orbyte-integration-icon', {}, icon(Codicon.plug)), $('div', {}, $('strong', {}, localize('orbyte.task.moreName', "More integrations")), $('span', {}, localize('orbyte.task.moreDescription', "Extend Orbyte with the tools your team already uses."))), more));
		append(section, cards);
		return section;
	}

	private integrationCard(provider: OrbyteTaskProvider, name: string, description: string, iconValue: ThemeIcon, snapshot: IOrbyteTaskDashboardSnapshot): HTMLElement {
		const connected = snapshot.connectedProviders.includes(provider);
		const error = snapshot.errors.get(provider);
		const action = button(connected ? localize('orbyte.task.disconnect', "Disconnect") : localize('orbyte.task.connect', "Connect"), connected ? Codicon.close : Codicon.add, connected ? 'secondary' : '');
		this.renderDisposables.add(addDisposableListener(action, 'click', () => void (connected ? this.disconnect(provider) : this.connect(provider))));
		return $(`.orbyte-integration-card.${provider}`, {},
			$('.orbyte-integration-icon', {}, icon(iconValue)),
			$('div.orbyte-integration-copy', {}, $('strong', {}, name), $('span', {}, error || description)),
			$(`span.orbyte-connection-state${error ? '.error' : connected ? '.connected' : ''}`, {}, error ? localize('orbyte.task.syncError', "Sync error") : connected ? localize('orbyte.task.connected', "Connected") : localize('orbyte.task.notConnected', "Not connected")),
			action,
		);
	}

	private async connect(provider: OrbyteTaskProvider): Promise<void> {
		try {
			if (provider === 'jira') {
				const baseUrl = await this.promptRequired(localize('orbyte.task.jiraUrlTitle', "Connect Jira Cloud"), localize('orbyte.task.jiraUrlPrompt', "Your Jira Cloud URL"), 'https://company.atlassian.net');
				if (!baseUrl) { return; }
				const email = await this.promptRequired(localize('orbyte.task.jiraEmailTitle', "Jira account"), localize('orbyte.task.jiraEmailPrompt', "Email used for your Jira API token"), 'you@company.com');
				if (!email) { return; }
				const project = await this.quickInputService.input({ title: localize('orbyte.task.jiraProjectTitle', "Jira project filter"), prompt: localize('orbyte.task.jiraProjectPrompt', "Optional project key. Leave blank to include all assigned issues."), placeHolder: 'TEAM' });
				if (project === undefined) { return; }
				const token = await this.promptRequired(localize('orbyte.task.jiraTokenTitle', "Jira API token"), localize('orbyte.task.jiraTokenPrompt', "Stored securely on this machine"), localize('orbyte.task.secretPlaceholder', "Paste token"), true);
				if (!token) { return; }
				await this.model.connectJira({ provider: 'jira', baseUrl: normalizeUrl(baseUrl), email: email.trim(), project: project.trim() || undefined }, token);
			} else {
				const organizationUrl = await this.promptRequired(localize('orbyte.task.azureUrlTitle', "Connect Azure DevOps"), localize('orbyte.task.azureUrlPrompt', "Organization URL"), 'https://dev.azure.com/organization');
				if (!organizationUrl) { return; }
				const project = await this.promptRequired(localize('orbyte.task.azureProjectTitle', "Azure DevOps project"), localize('orbyte.task.azureProjectPrompt', "Project name"), 'Project');
				if (!project) { return; }
				const token = await this.promptRequired(localize('orbyte.task.azureTokenTitle', "Azure DevOps PAT"), localize('orbyte.task.azureTokenPrompt', "Use a token with Work Items read access"), localize('orbyte.task.secretPlaceholder', "Paste token"), true);
				if (!token) { return; }
				await this.model.connectAzure({ provider: 'azure', organizationUrl: normalizeUrl(organizationUrl), project: project.trim() }, token);
			}
			this.notificationService.info(localize('orbyte.task.connectionSaved', "Connection saved. Syncing your tasks now."));
			await this.refresh();
		} catch (error) {
			this.notificationService.error(localize('orbyte.task.connectionFailed', "Could not connect: {0}", getErrorMessage(error)));
		}
	}

	private async disconnect(provider: OrbyteTaskProvider): Promise<void> {
		await this.model.disconnect(provider);
		this.notificationService.info(localize('orbyte.task.disconnected', "{0} disconnected.", provider === 'jira' ? 'Jira' : 'Azure DevOps'));
		await this.refresh();
	}

	private promptRequired(title: string, prompt: string, placeHolder: string, password = false): Promise<string | undefined> {
		return this.quickInputService.input({
			title,
			prompt,
			placeHolder,
			password,
			ignoreFocusLost: true,
			validateInput: async value => value.trim() ? undefined : localize('orbyte.task.requiredValue', "This value is required."),
		});
	}
}
