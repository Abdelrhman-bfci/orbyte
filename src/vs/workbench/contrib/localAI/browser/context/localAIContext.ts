/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Schemas } from '../../../../../base/common/network.js';
import { getCodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IPosition } from '../../../../../editor/common/core/position.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ILocalAISymbolChunk, ILocalAISymbolRetrieverService } from './localAISymbolRetriever.js';

export interface ILocalAIDiagnostic {
	readonly severity: 'error' | 'warning';
	readonly message: string;
	readonly source?: string;
	readonly range: IRange;
}

export interface ILocalAIContext {
	readonly uri: string;
	readonly languageId: string;
	readonly content: string;
	readonly cursor: IPosition;
	readonly selection: IRange;
	readonly selectedText: string;
	readonly openTabs: readonly string[];
	readonly diagnostics: readonly ILocalAIDiagnostic[];
	readonly symbolChunks: readonly ILocalAISymbolChunk[];
}

export const ILocalAIContextService = createDecorator<ILocalAIContextService>('localAIContextService');

export interface ILocalAIContextService {
	readonly _serviceBrand: undefined;
	collect(token?: CancellationToken): Promise<ILocalAIContext | undefined>;
}

export class LocalAIContextService implements ILocalAIContextService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IMarkerService private readonly _markerService: IMarkerService,
		@ILocalAISymbolRetrieverService private readonly _symbolRetrieverService: ILocalAISymbolRetrieverService,
	) { }

	async collect(token: CancellationToken = CancellationToken.None): Promise<ILocalAIContext | undefined> {
		const editor = getCodeEditor(this._editorService.activeTextEditorControl);
		const model = editor?.getModel();
		const cursor = editor?.getPosition();
		const selection = editor?.getSelection();
		if (!editor || !model || !cursor || !selection) {
			return undefined;
		}
		// The empty workbench/Welcome editor can surface as an untitled model whose
		// path is the workspace root. It is not a source file and including it makes
		// the model target the project directory instead of the relevant code.
		if (model.uri.scheme === Schemas.untitled && !model.getValue().trim()) {
			return undefined;
		}

		const diagnostics = this._markerService.read({
			resource: model.uri,
			severities: MarkerSeverity.Error | MarkerSeverity.Warning,
			take: 50,
		}).map(marker => ({
			severity: marker.severity === MarkerSeverity.Error ? 'error' as const : 'warning' as const,
			message: marker.message,
			source: marker.source,
			range: {
				startLineNumber: marker.startLineNumber,
				startColumn: marker.startColumn,
				endLineNumber: marker.endLineNumber,
				endColumn: marker.endColumn,
			},
		}));

		const openTabs = this._editorService.editors
			.map(editorInput => editorInput.resource?.toString())
			.filter((resource): resource is string => Boolean(resource));

		return {
			uri: model.uri.toString(),
			languageId: model.getLanguageId(),
			content: model.getValue(),
			cursor,
			selection,
			selectedText: model.getValueInRange(selection),
			openTabs: [...new Set(openTabs)],
			diagnostics,
			symbolChunks: await this._symbolRetrieverService.retrieve(model, cursor, token),
		};
	}
}
