/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { escapeRegExpCharacters } from '../../../../../base/common/strings.js';
import { IPosition, Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IOutlineModelService } from '../../../../../editor/contrib/documentSymbols/browser/outlineModel.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ISearchService, QueryType, resultIsMatch } from '../../../../services/search/common/search.js';

const maxRelatedChunks = 8;
const maxRelatedCharacters = 20_000;
const fallbackScopeRadius = 40;

export interface ILocalAISymbolChunk {
	readonly uri: string;
	readonly symbol?: string;
	readonly startLineNumber: number;
	readonly endLineNumber: number;
	readonly content: string;
}

export const ILocalAISymbolRetrieverService = createDecorator<ILocalAISymbolRetrieverService>('localAISymbolRetrieverService');

export interface ILocalAISymbolRetrieverService {
	readonly _serviceBrand: undefined;
	retrieve(model: ITextModel, position: IPosition, token: CancellationToken): Promise<readonly ILocalAISymbolChunk[]>;
}

export class LocalAISymbolRetrieverService implements ILocalAISymbolRetrieverService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IOutlineModelService private readonly _outlineModelService: IOutlineModelService,
		@ISearchService private readonly _searchService: ISearchService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) { }

	async retrieve(model: ITextModel, position: IPosition, token: CancellationToken): Promise<readonly ILocalAISymbolChunk[]> {
		const chunks: ILocalAISymbolChunk[] = [];
		let characterCount = 0;
		const outline = await this._outlineModelService.getOrCreate(model, token);
		const enclosingSymbol = outline.getItemEnclosingPosition(position)?.symbol;
		const activeRange = enclosingSymbol?.range ?? this._lineWindow(model, position.lineNumber, fallbackScopeRadius);
		const activeContent = model.getValueInRange(activeRange);
		chunks.push({
			uri: model.uri.toString(),
			symbol: enclosingSymbol?.name,
			startLineNumber: activeRange.startLineNumber,
			endLineNumber: activeRange.endLineNumber,
			content: activeContent,
		});
		characterCount += activeContent.length;

		const symbolName = enclosingSymbol?.name;
		const workspaceFolders = this._workspaceContextService.getWorkspace().folders;
		if (!symbolName || workspaceFolders.length === 0 || token.isCancellationRequested) {
			return chunks;
		}

		try {
			const searchResult = await this._searchService.textSearch({
				type: QueryType.Text,
				contentPattern: {
					pattern: escapeRegExpCharacters(symbolName),
					isRegExp: true,
					isWordMatch: true,
				},
				folderQueries: workspaceFolders.map(folder => ({ folder: folder.uri })),
				maxResults: 24,
			}, token);

			for (const fileMatch of searchResult.results) {
				if (chunks.length >= maxRelatedChunks || characterCount >= maxRelatedCharacters || token.isCancellationRequested) {
					break;
				}

				const firstMatch = fileMatch.results?.find(resultIsMatch);
				if (!firstMatch) {
					continue;
				}
				const firstRange = firstMatch.rangeLocations[0]?.source;
				if (!firstRange) {
					continue;
				}

				const lineNumber = firstRange.startLineNumber + 1;
				if (fileMatch.resource.toString() === model.uri.toString() && Range.containsPosition(activeRange, new Position(lineNumber, 1))) {
					continue;
				}

				const reference = await this._textModelService.createModelReference(fileMatch.resource);
				try {
					const relatedModel = reference.object.textEditorModel;
					const relatedOutline = await this._outlineModelService.getOrCreate(relatedModel, token);
					const relatedSymbol = relatedOutline.getItemEnclosingPosition(new Position(lineNumber, 1))?.symbol;
					const range = relatedSymbol?.range ?? this._lineWindow(relatedModel, lineNumber, 20);
					const remainingCharacters = maxRelatedCharacters - characterCount;
					const content = relatedModel.getValueInRange(range).slice(0, remainingCharacters);
					if (!content) {
						continue;
					}
					chunks.push({
						uri: relatedModel.uri.toString(),
						symbol: relatedSymbol?.name,
						startLineNumber: range.startLineNumber,
						endLineNumber: range.endLineNumber,
						content,
					});
					characterCount += content.length;
				} finally {
					reference.dispose();
				}
			}
		} catch {
			// Symbol retrieval is best effort. The active scope remains useful if search is unavailable.
		}

		return chunks;
	}

	private _lineWindow(model: ITextModel, lineNumber: number, radius: number): Range {
		const startLineNumber = Math.max(1, lineNumber - radius);
		const endLineNumber = Math.min(model.getLineCount(), lineNumber + radius);
		return new Range(startLineNumber, 1, endLineNumber, model.getLineMaxColumn(endLineNumber));
	}
}
