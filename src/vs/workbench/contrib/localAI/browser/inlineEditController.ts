/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorAction2, EditorContributionInstantiation, registerEditorContribution, ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { linesDiffComputers } from '../../../../editor/common/diff/linesDiffComputers.js';
import { IEditorContribution, IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { EditOperation } from '../../../../editor/common/core/editOperation.js';
import { IModelDeltaDecoration, ITextModel, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { localize, localize2 } from '../../../../nls.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ILocalLLMService } from '../../../../platform/localLLM/common/localLLM.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILocalAIContextService } from './context/localAIContext.js';
import { formatInlineEditMessages } from './context/promptFormatter.js';

interface IInlineEditPreview {
	readonly model: ITextModel;
	readonly range: Range;
	readonly originalText: string;
	readonly originalDocument: string;
	readonly baseVersionId: number;
	replacementText: string;
}

const localAIInlineEditVisible = new RawContextKey<boolean>('localAIInlineEditVisible', false, localize('localAIInlineEditVisible', "Whether an Orbyte AI inline edit is being previewed."));

export class InlineEditController extends Disposable implements IEditorContribution {

	static readonly ID = 'editor.contrib.localAIInlineEdit';

	static get(editor: ICodeEditor): InlineEditController | null {
		return editor.getContribution<InlineEditController>(InlineEditController.ID);
	}

	private readonly _previewDisposables = this._register(new DisposableStore());
	private readonly _zoneDisposables = this._register(new DisposableStore());
	private readonly _decorations: IEditorDecorationsCollection;
	private readonly _renderScheduler: RunOnceScheduler;
	private readonly _visibleContextKey: IContextKey<boolean>;
	private _preview: IInlineEditPreview | undefined;
	private _viewZoneId: string | undefined;
	private _activeRequestId: string | undefined;
	private _isApplying = false;

	constructor(
		private readonly _editor: ICodeEditor,
		@ILocalLLMService private readonly _localLLMService: ILocalLLMService,
		@ILocalAIContextService private readonly _contextService: ILocalAIContextService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this._decorations = _editor.createDecorationsCollection();
		this._renderScheduler = this._register(new RunOnceScheduler(() => this._renderPreview(), 80));
		this._visibleContextKey = localAIInlineEditVisible.bindTo(contextKeyService);

		this._register(this._localLLMService.onDidStreamToken(event => {
			if (event.requestId !== this._activeRequestId || !this._preview) {
				return;
			}
			this._preview.replacementText += event.token;
			this._renderScheduler.schedule();
		}));
		this._register(this._localLLMService.onDidStreamEnd(event => {
			if (event.requestId !== this._activeRequestId) {
				return;
			}
			this._activeRequestId = undefined;
			this._renderScheduler.cancel();
			if (event.error) {
				this.reject();
				this._notificationService.error(localize('localAIInlineEditFailed', "Orbyte AI edit failed: {0}", event.error));
				return;
			}
			this._renderPreview();
		}));
	}

	async generateEdit(): Promise<void> {
		if (!this._editor.hasModel()) {
			return;
		}

		const instruction = await this._quickInputService.input({
			prompt: localize('localAIEditPrompt', "Describe the code change"),
			placeHolder: localize('localAIEditPlaceholder', "For example: add input validation and tests"),
		});
		if (!instruction) {
			return;
		}

		const context = await this._contextService.collect();
		const model = this._editor.getModel();
		if (!context || !model) {
			this._notificationService.warn(localize('localAINoEditor', "Open a text editor before starting an Orbyte AI edit."));
			return;
		}

		await this._cancelActiveRequest();
		const selection = this._editor.getSelection();
		const range = this._getEditRange(model, context, selection && !selection.isEmpty() ? Range.lift(selection) : undefined);
		this._beginPreview(model, range, '');
		const requestId = generateUuid();
		this._activeRequestId = requestId;

		try {
			await this._localLLMService.streamChat({
				requestId,
				messages: formatInlineEditMessages(context, instruction, model.getValueInRange(range)),
				maxTokens: 3072,
				temperature: 0.1,
			});
		} catch (error) {
			this._activeRequestId = undefined;
			this.reject();
			this._notificationService.error(error);
		}
	}

	previewEdit(replacementText: string, range?: Range): void {
		const model = this._editor.getModel();
		if (!model) {
			return;
		}
		void this._cancelActiveRequest();
		const selection = this._editor.getSelection();
		const targetRange = range ?? (selection && !selection.isEmpty() ? Range.lift(selection) : model.getFullModelRange());
		this._beginPreview(model, targetRange, this._stripCodeFence(replacementText));
		this._renderPreview();
	}

	applyEdit(replacementText: string, range?: Range): boolean {
		const model = this._editor.getModel();
		if (!model) {
			return false;
		}

		void this._cancelActiveRequest();
		this._clearPreview();
		const selection = this._editor.getSelection();
		const targetRange = range ?? (selection && !selection.isEmpty() ? Range.lift(selection) : model.getFullModelRange());
		const replacement = this._stripCodeFence(replacementText);

		this._isApplying = true;
		try {
			model.pushStackElement();
			model.pushEditOperations(
				this._editor.getSelections(),
				[EditOperation.replace(targetRange, replacement)],
				() => [Selection.fromPositions(targetRange.getStartPosition())]
			);
			model.pushStackElement();
		} finally {
			this._isApplying = false;
		}

		this._editor.focus();
		return true;
	}

	accept(): void {
		if (this._activeRequestId) {
			return;
		}
		const preview = this._preview;
		if (!preview || preview.model.getVersionId() !== preview.baseVersionId) {
			this.reject();
			return;
		}

		const replacement = this._stripCodeFence(preview.replacementText);
		this._isApplying = true;
		try {
			preview.model.pushStackElement();
			preview.model.pushEditOperations(
				this._editor.getSelections(),
				[EditOperation.replace(preview.range, replacement)],
				() => [Selection.fromPositions(preview.range.getStartPosition())]
			);
			preview.model.pushStackElement();
		} finally {
			this._isApplying = false;
			this._clearPreview();
		}
		this._editor.focus();
	}

	reject(): void {
		void this._cancelActiveRequest();
		this._clearPreview();
		this._editor.focus();
	}

	private _beginPreview(model: ITextModel, range: Range, replacementText: string): void {
		this._clearPreview();
		this._preview = {
			model,
			range,
			originalText: model.getValueInRange(range),
			originalDocument: model.getValue(),
			baseVersionId: model.getVersionId(),
			replacementText,
		};
		this._visibleContextKey.set(true);
		this._previewDisposables.add(model.onDidChangeContent(() => {
			if (!this._isApplying) {
				this.reject();
			}
		}));
		this._previewDisposables.add(this._editor.onDidChangeModel(() => this.reject()));
	}

	private _renderPreview(): void {
		const preview = this._preview;
		if (!preview || preview.model.getVersionId() !== preview.baseVersionId) {
			return;
		}

		const replacement = this._stripCodeFence(preview.replacementText);
		if (!replacement && this._activeRequestId) {
			this._showActionZone(preview.range.endLineNumber, 0, 0, true);
			return;
		}

		const startOffset = preview.model.getOffsetAt(preview.range.getStartPosition());
		const endOffset = preview.model.getOffsetAt(preview.range.getEndPosition());
		const proposedDocument = `${preview.originalDocument.slice(0, startOffset)}${replacement}${preview.originalDocument.slice(endOffset)}`;
		const diff = linesDiffComputers.getDefault().computeDiff(
			preview.originalDocument.split(/\r?\n/),
			proposedDocument.split(/\r?\n/),
			{ ignoreTrimWhitespace: false, maxComputationTimeMs: 250, computeMoves: false }
		);

		const decorations: IModelDeltaDecoration[] = [];
		let addedLines = 0;
		let deletedLines = 0;
		let lastChangedLine = preview.range.endLineNumber;
		for (const change of diff.changes) {
			addedLines += change.modified.length;
			deletedLines += change.original.length;
			const anchorLine = Math.min(Math.max(1, change.original.startLineNumber), preview.model.getLineCount());
			lastChangedLine = Math.max(lastChangedLine, anchorLine);

			if (!change.original.isEmpty) {
				const endLineNumber = Math.min(preview.model.getLineCount(), change.original.endLineNumberExclusive - 1);
				decorations.push({
					range: new Range(change.original.startLineNumber, 1, endLineNumber, preview.model.getLineMaxColumn(endLineNumber)),
					options: {
						description: 'local-ai-inline-delete',
						className: 'local-ai-inline-delete',
						isWholeLine: true,
						stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					},
				});
			}

			if (!change.modified.isEmpty) {
				const anchorColumn = preview.model.getLineMaxColumn(anchorLine);
				decorations.push({
					range: new Range(anchorLine, anchorColumn, anchorLine, anchorColumn),
					options: {
						description: 'local-ai-inline-add',
						linesDecorationsClassName: 'local-ai-inline-add-gutter',
						after: {
							content: localize('localAIAddedLines', "  +{0} Orbyte AI line(s)", change.modified.length),
							inlineClassName: 'local-ai-inline-add-text',
						},
						stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					},
				});
			}
		}

		this._decorations.set(decorations);
		this._showActionZone(lastChangedLine, addedLines, deletedLines, Boolean(this._activeRequestId));
	}

	private _showActionZone(afterLineNumber: number, addedLines: number, deletedLines: number, streaming: boolean): void {
		this._zoneDisposables.clear();
		if (this._viewZoneId) {
			this._editor.changeViewZones(accessor => accessor.removeZone(this._viewZoneId!));
			this._viewZoneId = undefined;
		}

		const zone = dom.$('.local-ai-inline-zone');
		const status = dom.append(zone, dom.$('span.local-ai-inline-zone-status'));
		status.textContent = streaming
			? localize('localAIStreamingEdit', "Orbyte AI is generating an edit…")
			: localize('localAIEditSummary', "Orbyte AI edit: +{0} / −{1} lines", addedLines, deletedLines);

		const actions = dom.append(zone, dom.$('.local-ai-inline-zone-actions'));
		const acceptButton = dom.append(actions, dom.$<HTMLButtonElement>('button.local-ai-button'));
		acceptButton.type = 'button';
		acceptButton.textContent = localize('localAIAcceptEdit', "Accept (Ctrl+Enter)");
		acceptButton.disabled = streaming;
		const rejectButton = dom.append(actions, dom.$<HTMLButtonElement>('button.local-ai-button.secondary'));
		rejectButton.type = 'button';
		rejectButton.textContent = localize('localAIRejectEdit', "Reject (Esc)");

		this._zoneDisposables.add(dom.addDisposableListener(acceptButton, dom.EventType.CLICK, () => this.accept()));
		this._zoneDisposables.add(dom.addDisposableListener(rejectButton, dom.EventType.CLICK, () => this.reject()));
		this._editor.changeViewZones(accessor => {
			this._viewZoneId = accessor.addZone({
				afterLineNumber: Math.min(afterLineNumber, this._editor.getModel()?.getLineCount() ?? afterLineNumber),
				heightInPx: 40,
				domNode: zone,
				suppressMouseDown: true,
			});
		});
	}

	private _stripCodeFence(value: string): string {
		const openingFence = value.match(/^\s*```[^\n]*\n?/);
		if (!openingFence) {
			return value;
		}
		const withoutOpening = value.slice(openingFence[0].length);
		return withoutOpening.replace(/\n?```\s*$/, '');
	}

	private _getEditRange(model: ITextModel, context: Awaited<ReturnType<ILocalAIContextService['collect']>>, selection: Range | undefined): Range {
		let range = selection;
		const activeChunk = context?.symbolChunks[0];
		if (!range && activeChunk?.uri === model.uri.toString()) {
			range = new Range(activeChunk.startLineNumber, 1, activeChunk.endLineNumber, model.getLineMaxColumn(activeChunk.endLineNumber));
		}
		range ??= model.getFullModelRange();

		const maximumEditCharacters = 8000;
		const rangeStart = model.getOffsetAt(range.getStartPosition());
		const rangeEnd = model.getOffsetAt(range.getEndPosition());
		if (rangeEnd - rangeStart <= maximumEditCharacters) {
			return range;
		}

		const cursorOffset = model.getOffsetAt(this._editor.getPosition() ?? range.getStartPosition());
		const halfWindow = Math.floor(maximumEditCharacters / 2);
		let startOffset = Math.max(rangeStart, cursorOffset - halfWindow);
		const endOffset = Math.min(rangeEnd, startOffset + maximumEditCharacters);
		startOffset = Math.max(rangeStart, endOffset - maximumEditCharacters);
		return Range.fromPositions(model.getPositionAt(startOffset), model.getPositionAt(endOffset));
	}

	private async _cancelActiveRequest(): Promise<void> {
		const requestId = this._activeRequestId;
		this._activeRequestId = undefined;
		if (requestId) {
			await this._localLLMService.cancelRequest(requestId);
		}
	}

	private _clearPreview(): void {
		this._renderScheduler.cancel();
		this._previewDisposables.clear();
		this._zoneDisposables.clear();
		this._decorations.clear();
		if (this._viewZoneId) {
			this._editor.changeViewZones(accessor => accessor.removeZone(this._viewZoneId!));
			this._viewZoneId = undefined;
		}
		this._preview = undefined;
		this._visibleContextKey.set(false);
	}

	override dispose(): void {
		void this._cancelActiveRequest();
		this._clearPreview();
		super.dispose();
	}
}

registerEditorContribution(InlineEditController.ID, InlineEditController, EditorContributionInstantiation.Lazy);

registerAction2(class LocalAIEditAction extends EditorAction2 {
	constructor() {
		super({
			id: 'localAI.inlineEdit',
			title: localize2('localAI.inlineEdit', "Edit with Orbyte AI"),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyL,
			},
		});
	}

	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> | undefined {
		return InlineEditController.get(editor)?.generateEdit();
	}
});

registerAction2(class LocalAIAcceptEditAction extends EditorAction2 {
	constructor() {
		super({
			id: 'localAI.acceptInlineEdit',
			title: localize2('localAI.acceptInlineEdit', "Accept Orbyte AI Edit"),
			precondition: localAIInlineEditVisible,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 50,
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				mac: { primary: KeyMod.WinCtrl | KeyCode.Enter },
			},
		});
	}

	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		InlineEditController.get(editor)?.accept();
	}
});

registerAction2(class LocalAIRejectEditAction extends EditorAction2 {
	constructor() {
		super({
			id: 'localAI.rejectInlineEdit',
			title: localize2('localAI.rejectInlineEdit', "Reject Orbyte AI Edit"),
			precondition: localAIInlineEditVisible,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 50,
				primary: KeyCode.Escape,
			},
		});
	}

	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		InlineEditController.get(editor)?.reject();
	}
});
