import { ColorInformation, ColorPresentation, ColorPresentationParams, DocumentColorParams, TextEdit } from 'vscode-languageserver';
import { Maybe, lexers } from './server';

export async function colorPresentation(params: ColorPresentationParams): Promise<Maybe<ColorPresentation[]>> {
	let label = 'RGB: ', textEdit: TextEdit = { range: params.range, newText: '' }, color = params.color, m: any;
	let text = lexers[params.textDocument.uri.toLowerCase()].document.getText(params.range), hex = '';
	for (const i of [color.alpha, color.red, color.green, color.blue])
		hex += ('00' + Math.round(i * 255).toString(16)).substr(-2);
	if (m = text.match(/^(0x)?([\da-f]{6}([\da-f]{2})?)/i))
		textEdit.newText = (m[1] === undefined ? '' : '0x') + hex.slice(-m[2].length);
	else textEdit.newText = hex.substring(2);
	label += textEdit.newText
	return [{ label, textEdit }];
}

export async function colorProvider(params: DocumentColorParams): Promise<ColorInformation[]> {
	return lexers[params.textDocument.uri.toLowerCase()].colors;
}