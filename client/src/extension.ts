/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import {
	commands,
	debug,
	extensions,
	ExtensionContext,
	workspace,
	window,
	Range
} from 'vscode';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient';
import * as child_process from 'child_process';
import { resolve } from 'path';
import { existsSync, unlinkSync } from 'fs';

let client: LanguageClient;
let channel = window.createOutputChannel('AutoHotkey2');
let ahkprocess: child_process.ChildProcess | undefined;
let ahkhelp: child_process.ChildProcessWithoutNullStreams | undefined;

export function activate(context: ExtensionContext) {
	// The server is implemented in node
	let serverModule: string, serverPath = process.env.VSCODE_AHK_SERVER_PATH;
	if (serverPath) serverModule = context.asAbsolutePath(`server/${serverPath}/server.js`);
	else serverModule = context.asAbsolutePath('server/' + __dirname.replace(/^.*[\\/]/, '') + '/server.js');
	// The debug options for the server
	// --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
	let debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	let serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: { kind: TransportKind.socket, port: 1219 },
			options: debugOptions
		}
	};

	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{ scheme: 'file', language: 'ahk2' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'ahk2',
		'Autohotkey2 Server',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();
	context.subscriptions.push(
		commands.registerCommand('ahk2.run', () => runCurrentScriptFile()),
		commands.registerCommand('ahk2.selection.run', () => runCurrentScriptFile(true)),
		commands.registerCommand('ahk2.stop', () => stopRunningScript()),
		commands.registerCommand('ahk2.compile', () => compileScript()),
		commands.registerCommand('ahk2.help', () => quickHelp())
	);
	let extlist: string[] = [], debugexts: { [type: string]: string } = {};
	for (const ext of extensions.all) {
		if (ext.id.match(/ahk|autohotkey/i) && ext.packageJSON?.contributes?.debuggers) {
			for (const debuger of ext.packageJSON.contributes.debuggers)
				if (debuger.type)
					debugexts[debuger.type] = ext.id;
		}
	}
	extlist = Object.values(debugexts);
	context.subscriptions.push(commands.registerCommand('ahk2.debug', async () => {
		const editor = window.activeTextEditor, executePath = workspace.getConfiguration('AutoHotkey2').get('Path');
		if (!editor) return;
		let extname: string | undefined;
		if (extlist.length === 0) {
			window.showErrorMessage('未找到debug插件, 请先安装debug插件!');
			extname = await window.showQuickPick(['zero-plusplus.vscode-autohotkey-debug', 'helsmy.autohotkey-debug', 'cweijan.vscode-autohotkey-plus']);
			if (extname)
				commands.executeCommand('workbench.extensions.installExtension', extname);
			return;
		} else if (extlist.length === 1)
			extname = extlist[0];
		else
			extname = await window.showQuickPick(extlist);
		if (extname) {
			let config: any = {
				type: '',
				request: "launch",
				name: "AutoHotkey Debug",
				runtime: executePath,
				AhkExecutable: executePath,
				program: editor.document.uri.fsPath
			};
			for (const t in debugexts)
				if (debugexts[t] === extname) {
					config.type = t;
					if (extname === 'zero-plusplus.vscode-autohotkey-debug') {
						let input = await window.showInputBox({ prompt: '输入需要传递的命令行参数' });
						if (input = input?.trim()) {
							let args: string[] = [];
							input.replace(/('|")(.*?(?<!\\))\1(?=(\s|$))|(\S+)/g, (...m) => {
								args.push(m[4] || m[2]);
								return '';
							});
							config.args = args;
						}
					}
					break;
				}
			debug.startDebugging(workspace.getWorkspaceFolder(editor.document.uri), config);
		}
	}));
	commands.executeCommand('setContext', 'ahk2:isRunning', false);
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}

async function runCurrentScriptFile(selection = false): Promise<void> {
	const editor = window.activeTextEditor, executePath = workspace.getConfiguration('AutoHotkey2').get('Path');
	if (!editor) return;
	let selecttext = '', path = '*', command = `"${executePath}" /ErrorStdOut `;
	let startTime: Date;
	await stopRunningScript(true);
	channel.show(true), channel.clear();
	if (selection || editor.document.isUntitled) selecttext = editor.document.getText(editor.selection);
	if (selecttext !== '') {
		command += path, channel.appendLine('[Running] ' + command), startTime = new Date();
		ahkprocess = child_process.spawn(command, { cwd: `${resolve(editor.document.fileName, '..')}`, shell: true });
		ahkprocess.stdin?.write(selecttext), ahkprocess.stdin?.end();
	} else {
		commands.executeCommand('workbench.action.files.save');
		path = editor.document.fileName, command += `"${path}"`;
		channel.appendLine('[Running] ' + command), startTime = new Date();
		ahkprocess = child_process.spawn(command, { cwd: resolve(path, '..'), shell: true });
	}
	if (ahkprocess) {
		commands.executeCommand('setContext', 'ahk2:isRunning', true);
		ahkprocess.stderr?.on('data', (data) => {
			channel.append(`[Error] ${data.toString().trim()}`);
		});
		ahkprocess.on('error', (error) => {
			console.error(error.message);
		});
		ahkprocess.stdout?.on('data', (data) => {
			channel.append(data.toString());
		});
		ahkprocess.on('exit', (code) => {
			ahkprocess = undefined;
			commands.executeCommand('setContext', 'ahk2:isRunning', false);
			channel.appendLine('');
			channel.appendLine('[Done] exited with code=' + code + ' in ' + ((new Date()).getTime() - startTime.getTime()) / 1000 + ' seconds');
		});
	} else
		commands.executeCommand('setContext', 'ahk2:isRunning', false);
}

async function stopRunningScript(wait = false) {
	if (ahkprocess) {
		child_process.execSync('taskkill /pid ' + ahkprocess.pid + ' /T /F');
		if (wait) {
			while (ahkprocess)
				await sleep(200);
		}
	}
}

async function compileScript() {
	const editor = window.activeTextEditor, executePath = workspace.getConfiguration('AutoHotkey2').get('Path');
	let compilePath = executePath + '';
	if (!editor) return;
	compilePath = resolve(compilePath, '..\\Compiler\\Ahk2Exe.exe')
	if (!existsSync(compilePath)) {
		window.showErrorMessage(compilePath + '不存在');
		return;
	}
	if (editor.document.isUntitled) {
		window.showErrorMessage('不支持编译临时脚本');
		return;
	}
	commands.executeCommand('workbench.action.files.save');
	const currentPath = editor.document.uri.fsPath;
	const exePath = currentPath.replace(/\.\w+$/, '.exe');
	unlinkSync(exePath);
	if (child_process.exec(`"${compilePath}" /in "${currentPath}" /out "${exePath}" /compress 0`, { cwd: resolve(currentPath, '..') })) {
		let start = new Date().getTime();
		let timer = setInterval(() => {
			let end = new Date().getTime();
			if (!checkcompilesuccess()) {
				if (end - start > 5000) {
					clearInterval(timer);
					window.showErrorMessage('编译失败!');
				}
			} else
				clearInterval(timer);
			function checkcompilesuccess() {
				if (existsSync(exePath)) {
					window.showInformationMessage('编译成功!');
					return true;
				}
				return false;
			}
		}, 1000);
	} else
		window.showErrorMessage('编译失败!');
}

async function quickHelp() {
	const editor = window.activeTextEditor;
	if (!editor) return;
	const document = editor.document, path = document.fileName, position = editor.selection.active;
	const range = document.getWordRangeAtPosition(position), line = position.line;
	let word = '';
	if (range && (word = document.getText(range)).match(/^[a-z_]+$/i)) {
		if (range.start.character > 0 && document.getText(new Range(line, range.start.character - 1, line, range.start.character)) === "#")
			word = "#" + word;
	}
	const executePath: string = workspace.getConfiguration('AutoHotkey2').get('Path') || '';
	if (!ahkhelp) {
		let helpPath = resolve(executePath, '..\\AutoHotkey.chm')
		ahkhelp = child_process.spawn('C:/Windows/hh.exe', [helpPath]);
		if (!ahkhelp.pid) {
			window.showInformationMessage("打开帮助文件失败"), ahkhelp = undefined;
			return;
		}
		ahkhelp.on('close', () => { ahkhelp = undefined; })
	}
	if (word !== '' && executePath !== '' && existsSync(executePath)) {
		let ahkpro = child_process.exec(`\"${executePath}\" /ErrorStdOut *`, { cwd: `${resolve(editor.document.fileName, '..')}` });
		ahkpro.stdin?.write(`#NoTrayIcon\ntry if (WinGetMinMax("ahk_pid ${ahkhelp.pid}")=-1)\nWinRestore("ahk_pid ${ahkhelp.pid}"), Sleep(500)\nWinActivate("ahk_pid ${ahkhelp.pid}")\nif !WinWaitActive("ahk_pid ${ahkhelp.pid}", , 5)\nExitApp()\nSendInput("!s"), Sleep(100)\nSendInput("^{Backspace}"), Sleep(200)\nSendInput("{Text}${word}\`n")`);
		ahkpro.stdin?.end();
	}
}

async function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}