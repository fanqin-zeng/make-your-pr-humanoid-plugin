"use strict";

const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
const git = require("./git");
const handoff = require("./handoff");
const changes = require("./changes");
const versions = require("./versions");
const { uncoveredFiles, mergePoints } = require("./clarifications");

const id = "workspacePrReview";
const scheme = "workspace-pr-review";
const key = id + ".comparison";
const directoryKey = id + ".exportDirectory";
const statusLabels = { A: "新增", C: "复制", D: "删除", M: "修改", R: "重命名", T: "类型变更", U: "行意见" };

function comparisonId(repository, target, source) {
    return git.digest([repository, target, source].join("\0"));
}

function editorRange(start, end) {
    return new vscode.Range(start - 1, 0, end - 1, 1);
}

function selectedLines(range) {
    const start = range.start.line + 1;
    const end = range.end.line + (range.end.character === 0 && range.end.line > range.start.line ? 0 : 1);
    return { start, end };
}

class Files {
    constructor(review) {
        this.review = review;
        this.change = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.change.event;
    }

    getChildren(node) {
        return node ? node.children || [] : this.roots || [];
    }

    reset() {
        const root = { children: [] };
        for (const file of this.review.snapshot?.files || []) {
            const parts = file.path.split("/");
            let parent = root;
            for (const part of parts.slice(0, -1)) {
                let folder = parent.children.find(item => item.children && item.label === part);
                if (!folder) {
                    folder = { label: part, children: [] };
                    parent.children.push(folder);
                }
                parent = folder;
            }
            parent.children.push({ label: parts.at(-1), file });
        }
        this.roots = root.children;
        this.change.fire();
    }

    getTreeItem(node) {
        const item = new vscode.TreeItem(node.label, node.children
            ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        if (node.children) {
            item.iconPath = vscode.ThemeIcon.Folder;
        } else {
            const { file } = node;
            const record = this.review.record?.read[file.id];
            const read = record === file.digest ? "已读" : record ? "待复看" : "未读";
            const count = this.review.opinions(file).length;
            item.description = statusLabels[file.status[0]] + " · " + read + (count ? " · " + count + " 条意见" : "");
            item.tooltip = file.oldPath ? file.oldPath + " → " + file.path : file.path;
            item.resourceUri = this.review.uri(file, file.status[0] === "D" ? "old" : "new");
            item.command = { command: id + ".openFile", title: "打开 Diff", arguments: [file.id] };
        }
        return item;
    }

    dispose() { this.change.dispose(); }
}

class Review {
    constructor(context) {
        this.context = context;
        this.files = new Files(this);
        this.scanning = [];
        this.refs = [];
        this.status = { kind: "idle", text: "选择 Git 仓库以开始评阅" };
        this.snapshots = new Map();
        this.threads = new Map();
        this.pending = 0;
        this.exports = new handoff.ResultWatcher(context.workspaceState,
            (job, result) => this.receiveResult(job, result),
            message => vscode.window.showWarningMessage("评阅回传：" + message),
            () => this.notify());
        this.comments = vscode.comments.createCommentController(id, "分支评阅");
        this.comments.options = { placeHolder: "对当前行范围填写评阅意见", prompt: "添加评阅意见" };
        this.comments.commentingRangeProvider = {
            provideCommentingRanges: document => {
                const location = this.locate(document.uri);
                return this.isLatest && location && location.snapshot === this.snapshot && location.present
                    ? [new vscode.Range(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length)]
                    : [];
            },
        };
    }

    get isLatest() { return Boolean(this.record && this.record === this.data?.versions.at(-1)); }

    notify() {
        const history = this.data?.versions || [];
        this.controls?.webview.postMessage({ type: "state", state: {
            repositories: this.scanning.map(item => ({ id: item, label: this.repositoryLabel(item) })),
            refs: this.refs, repository: this.repository, target: this.target, source: this.source,
            versions: history.map((item, index) => ({
                id: item.number, label: item.number + (index === history.length - 1 ? "（最新）" : ""),
            })).reverse(),
            version: this.record?.number, historical: Boolean(this.record && !this.isLatest),
            status: this.status, ready: this.isLatest && Boolean(this.snapshot?.files.length || this.record?.opinions.length),
            clarificationReady: this.isLatest && this.snapshot.files.some(file => file.rows.length),
            directory: this.snapshot ? this.exportDirectory : "",
            waiting: Object.values(this.exports.pending).filter(job => job.storeKey === this.storeKey).length,
            automation: changes.automation(this.data?.automation),
            busy: this.busy,
            comparison: this.snapshot && {
                target: this.snapshot.targetCommit.slice(0, 7), base: this.snapshot.base.slice(0, 7),
                head: this.snapshot.sourceCommit.slice(0, 7), working: this.snapshot.working, count: this.snapshot.files.length,
            },
        } });
        const file = this.currentFile;
        this.detail?.webview.postMessage({ type: "state", state: {
            comparison: this.snapshot?.token || null,
            version: this.record?.number, historical: Boolean(this.record && !this.isLatest),
            file: file && { id: file.id, path: file.path, oldPath: file.oldPath },
            selection: this.selection,
            points: file && this.record?.clarifications[file.id]?.digest === file.digest
                ? this.record.clarifications[file.id].points : [],
            opinions: file ? this.opinions(file).map(opinion => ({
                ...opinion, stale: opinion.digest !== file.digest,
                pending: opinion.replies.at(-1)?.revision !== opinion.revision,
            })) : [],
            archived: this.snapshot ? this.record.opinions.filter(opinion => !this.fileFor(opinion)).map(opinion => ({
                ...opinion, stale: true, pending: opinion.replies.at(-1)?.revision !== opinion.revision,
            })) : [],
            updating: Object.values(this.exports.pending).some(job => job.storeKey === this.storeKey),
        } });
    }

    repositoryLabel(repository) {
        const folder = vscode.workspace.workspaceFolders?.find(item => {
            const relative = path.relative(item.uri.fsPath, repository);
            return !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
        });
        if (!folder) return repository;
        return path.relative(folder.uri.fsPath, repository) || folder.name;
    }

    async discover() {
        if (this.busy) return;
        const request = ++this.pending;
        this.loading = true;
        this.status = { kind: "busy", text: "正在扫描工作区的 Git 仓库…" };
        this.notify();
        const folders = vscode.workspace.workspaceFolders || [];
        const roots = folders.filter(item => item.uri.scheme === "file" || item.uri.scheme === "vscode-remote")
            .map(item => item.uri.fsPath);
        try {
            const found = await git.repositories(roots);
            if (request !== this.pending) return;
            const depth = repository => this.repositoryLabel(repository).split(path.sep).length;
            this.scanning = found.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
        } catch (error) {
            if (request === this.pending) {
                this.loading = false;
                this.status = { kind: "error", text: "扫描仓库失败。 " + error.message.slice(0, 280) };
                this.notify();
            }
            throw error;
        }
        if (request !== this.pending) return;
        if (!this.scanning.length) {
            this.loading = false;
            this.status = { kind: "idle", text: "当前工作区未找到 Git 仓库" };
            this.clear();
            this.notify();
            return;
        }
        const remembered = this.context.workspaceState.get(key);
        await this.select(this.scanning.includes(this.repository) ? this.repository
            : this.scanning.includes(remembered?.repository) ? remembered.repository : this.scanning[0]);
    }

    async select(repository, target, source) {
        if (this.exporting || this.receiving || !this.scanning.includes(repository)) return;
        const request = ++this.pending;
        const previousFile = this.repository === repository ? this.currentFile?.path : null;
        const previousToken = this.snapshot?.token;
        this.repository = repository;
        this.loading = true;
        this.status = { kind: "busy", text: "正在生成分支比较…" };
        this.clear();
        this.notify();
        try {
            const choices = await git.branches(repository);
            if (request !== this.pending) return;
            this.refs = choices.refs;
            const remembered = this.context.workspaceState.get(key);
            if (remembered?.repository === repository) {
                target ||= remembered.target;
                source ||= remembered.source;
            }
            this.source = this.refs.some(ref => ref.id === source) ? source : choices.source;
            this.target = this.refs.some(ref => ref.id === target) ? target
                : choices.defaultTargets.find(ref => ref !== this.source);
            if (!this.target) {
                this.status = { kind: "idle", text: "请选择目标分支。默认使用本地已有的 origin/main 或 origin/master。" };
                return;
            }
            if (!this.source || this.source === this.target) {
                this.status = { kind: "idle", text: "请选择两个不同的分支" };
                return;
            }
            const storageId = comparisonId(repository, this.target, this.source);
            const storeKey = id + ".review." + storageId;
            let stored = this.context.workspaceState.get(storeKey);
            if (!stored && git.originTargets.includes(this.target)) {
                // Reuse the saved history on the first switch to the corresponding origin target.
                const oldTarget = git.retiredTargets[git.originTargets.indexOf(this.target)];
                stored = this.context.workspaceState.get(id + ".review." + comparisonId(repository, oldTarget, this.source));
            }
            const data = structuredClone(stored || { versions: [] });
            const { version, snapshot } = await versions.refresh(repository, this.target, this.source, data, storageId);
            const directory = await this.requestDirectory();
            if (request !== this.pending) return;
            this.storeKey = storeKey;
            this.data = data;
            this.exportDirectory = directory;
            this.show(snapshot, version, previousFile);
            await this.context.workspaceState.update(key, { repository, target: this.target, source: this.source });
            await this.save();
            this.status = { kind: "idle", text: version.number + (snapshot.working ? " · 含未提交修改" : " · 分支快照") };
            if (previousToken && previousToken !== snapshot.token) await this.reopen(previousToken);
        } catch (error) {
            if (request === this.pending) this.status = { kind: "error", text: "生成比较失败。 " + error.message.slice(0, 350) };
        } finally {
            if (request === this.pending) {
                this.loading = false;
                this.files.reset();
                this.notify();
            }
        }
    }

    show(snapshot, version, filePath) {
        snapshot.token = git.digest([snapshot.repository, snapshot.target, snapshot.source, version.number,
            snapshot.base, snapshot.head].join("\0")).slice(0, 24);
        snapshot.number = version.number;
        snapshot.fileMap = new Map(snapshot.files.map(file => [file.id, file]));
        this.snapshots.set(snapshot.token, snapshot);
        this.snapshot = snapshot;
        this.record = version;
        this.selection = null;
        this.currentFile = snapshot.files.find(file => file.path === filePath);
        this.syncThreads();
    }

    async reopen(previousToken, preserveFocus = false) {
        const active = vscode.window.tabGroups.all.find(group => group.viewColumn === vscode.ViewColumn.One)?.activeTab;
        const wasReviewDiff = active?.input instanceof vscode.TabInputTextDiff && active.input.modified.scheme === scheme
            && active.input.modified.authority === previousToken;
        if (preserveFocus && !wasReviewDiff) return;
        if (this.currentFile) await this.openFile(this.currentFile.id, preserveFocus);
        if (wasReviewDiff && active.group.tabs.includes(active)) {
            await vscode.window.tabGroups.close(active);
        }
    }

    async selectVersion(number) {
        if (this.busy || !this.snapshot) return;
        const version = this.data.versions.find(item => item.number === number);
        if (!version || version === this.record) return;
        if (version === this.data.versions.at(-1)) {
            await this.select(this.repository, this.target, this.source);
            return;
        }
        this.loading = true;
        this.notify();
        try {
            const previousToken = this.snapshot.token;
            const snapshot = await versions.load(this.repository, this.target, this.source, version);
            this.show(snapshot, version, this.currentFile?.path);
            this.status = { kind: "idle", text: "历史版本 " + version.number };
            await this.reopen(previousToken);
        } finally {
            this.loading = false;
            this.files.reset();
            this.notify();
        }
    }

    clear() {
        this.snapshot = null;
        this.data = null;
        this.record = null;
        this.currentFile = null;
        this.selection = null;
        for (const thread of this.threads.values()) thread.dispose();
        this.threads.clear();
        this.files.reset();
    }

    uri(file, side, snapshot = this.snapshot) {
        const name = side === "old" ? file.oldPath || file.path : file.path;
        return vscode.Uri.from({ scheme, authority: snapshot.token, path: "/" + name, query: side + "/" + file.id });
    }

    locate(uri) {
        if (uri.scheme !== scheme) return null;
        const snapshot = this.snapshots.get(uri.authority);
        const [side, fileId] = uri.query.split("/");
        const file = snapshot?.fileMap.get(fileId);
        if (!file || !["old", "new"].includes(side)) return null;
        return { snapshot, side, file, present: !(side === "old" && file.status[0] === "A" || side === "new" && file.status[0] === "D") };
    }

    async document(uri) {
        const location = this.locate(uri);
        if (!location?.present) return "";
        const text = await git.blob(location.snapshot, location.file, location.side).catch(() => location.file.patch);
        return text.includes("\0") ? "二进制文件\n\n" + location.file.patch : text;
    }

    selectEditor(editor, range = editor?.selection) {
        if (!editor || !range) return;
        const location = this.locate(editor.document.uri);
        if (!location || location.snapshot !== this.snapshot || !location.present) return;
        this.currentFile = location.file;
        this.selection = { fileId: location.file.id, side: location.side, ...selectedLines(range) };
        this.notify();
    }

    async focusDetail(preserveFocus = true) {
        if (this.detail) {
            this.detail.reveal(vscode.ViewColumn.Two, preserveFocus);
            return;
        }
        if (!vscode.window.tabGroups.all.some(group => group.viewColumn === vscode.ViewColumn.Two)) {
            await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup");
            await vscode.commands.executeCommand("workbench.action.newGroupRight");
        }
        const panel = vscode.window.createWebviewPanel(id + ".detail", "评阅详情",
            { viewColumn: vscode.ViewColumn.Two, preserveFocus }, { retainContextWhenHidden: true });
        panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "review.svg");
        await this.bind(panel, "detail");
    }

    async openFile(fileId, preserveFocus = false) {
        const file = this.snapshot?.fileMap.get(fileId);
        if (!file) return;
        this.currentFile = file;
        const side = file.status[0] === "D" ? "old" : "new";
        const first = file.rows.find(row => side === "new" ? row.new && row.text.startsWith("+") : row.old && row.text.startsWith("-"));
        const line = first?.[side] || file.rows.find(row => row[side])?.[side] || 1;
        this.selection = { fileId: file.id, side, start: line, end: line };
        this.record.read[file.id] = file.digest;
        await this.save();
        await vscode.commands.executeCommand("vscode.diff", this.uri(file, "old"), this.uri(file, "new"),
            file.path + " · " + this.record.number + " / PR 基点",
            { viewColumn: vscode.ViewColumn.One, preview: true, preserveFocus });
        if (!preserveFocus && !this.detail?.visible) await this.focusDetail();
    }

    async reveal(fileId, side, start, end) {
        const file = this.snapshot?.fileMap.get(fileId);
        if (!file || !["old", "new"].includes(side) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return;
        const first = vscode.window.tabGroups.all.find(group => group.viewColumn === vscode.ViewColumn.One);
        const input = first?.activeTab?.input;
        if (!(input instanceof vscode.TabInputTextDiff) || this.locate(input.modified)?.file !== file) {
            await this.openFile(fileId);
        }
        const uri = this.uri(file, side);
        await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup");
        await vscode.commands.executeCommand("workbench.action.compareEditor." + (side === "old" ? "focusSecondarySide" : "focusPrimarySide"));
        const active = vscode.window.activeTextEditor;
        const visible = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString());
        const editor = active?.document.uri.toString() === uri.toString() ? active
            : visible || await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One, preview: true });
        const range = editor.document.validateRange(editorRange(start, end));
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        this.selectEditor(editor, range);
    }

    fileFor(opinion) {
        return this.snapshot?.fileMap.get(opinion.fileId)
            || this.snapshot?.files.find(file => file.oldPath === opinion.path);
    }

    opinions(file) {
        return this.record?.opinions.filter(opinion => this.fileFor(opinion) === file) || [];
    }

    async addOpinion(selection, text, editingId) {
        if (!this.isLatest) throw new Error("请选择最新评阅版本后添加或编辑意见。");
        if (typeof text !== "string" || !text.trim() || text.length > 8000) throw new Error("意见长度须为 1–8000 字符。");
        if (this.busy) throw new Error("请等评阅状态更新后再保存意见。");
        const file = this.snapshot?.fileMap.get(selection?.fileId);
        const previous = editingId && this.record?.opinions.find(opinion => opinion.id === editingId);
        if (previous) {
            previous.text = text.trim();
            previous.revision = randomUUID();
        } else {
            if (!file || !["old", "new"].includes(selection?.side)) throw new Error("请先打开 diff 并选择行范围。");
            const { side, start, end } = selection;
            const location = this.locate(this.uri(file, side));
            if (!location?.present) throw new Error("此侧没有文件内容。");
            const document = await vscode.workspace.openTextDocument(this.uri(file, side));
            if (this.busy || this.snapshot !== location.snapshot) throw new Error("比较已切换，请重新选择行范围。");
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > document.lineCount) {
                throw new Error("意见行范围不在文件内。");
            }
            const last = Math.min(end, start + 24) - 1;
            const excerpt = document.getText(new vscode.Range(start - 1, 0, last, document.lineAt(last).text.length)).slice(0, 3500);
            this.record.opinions.push({
                id: randomUUID(), revision: randomUUID(), path: file.path, fileId: file.id, side, start, end,
                digest: file.digest, excerpt, text: text.trim(), createdAt: new Date().toISOString(), replies: [],
            });
        }
        this.syncThreads();
        await this.save();
    }

    async addFromEditor(reply) {
        const location = reply?.thread && this.locate(reply.thread.uri);
        if (!location || location.snapshot !== this.snapshot) return;
        const range = selectedLines(reply.thread.range);
        await this.addOpinion({ fileId: location.file.id, side: location.side, ...range }, reply.text);
        reply.thread.dispose();
    }

    syncThreads() {
        const ids = new Set();
        for (const opinion of this.record?.opinions || []) {
            const file = this.fileFor(opinion);
            if (!file || opinion.digest !== file.digest) continue;
            ids.add(opinion.id);
            const toComment = (name, body, time, label) => ({
                author: { name }, body, mode: vscode.CommentMode.Preview, timestamp: new Date(time), label,
            });
            const comments = [toComment("我", opinion.text, opinion.createdAt, ""),
                ...opinion.replies.map(reply => toComment("Agent", reply.text, reply.at, ""))];
            const existing = this.threads.get(opinion.id);
            if (existing && existing.uri.toString() === this.uri(file, opinion.side).toString()) existing.comments = comments;
            else {
                existing?.dispose();
                const thread = this.comments.createCommentThread(this.uri(file, opinion.side),
                    editorRange(opinion.start, opinion.end), comments);
                thread.canReply = false;
                thread.contextValue = "savedOpinion";
                thread.label = "评阅意见";
                this.threads.set(opinion.id, thread);
            }
        }
        for (const [opinionId, thread] of this.threads) {
            if (!ids.has(opinionId)) {
                thread.dispose();
                this.threads.delete(opinionId);
            }
        }
    }

    async save() {
        await this.context.workspaceState.update(this.storeKey, structuredClone(this.data));
        this.files.change.fire();
        this.notify();
    }

    needsReply(opinion, edit) {
        return opinion.replies.at(-1)?.revision !== opinion.revision || (edit && opinion.editRevision !== opinion.revision);
    }

    get busy() { return Boolean(this.loading || this.exporting || this.receiving); }

    async requestDirectory(input) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || this.repository || this.context.storageUri?.fsPath;
        const isQoder = /^qoder(?:-|$)/i.test(vscode.env.uriScheme);
        const names = isQoder ? [".qoder-review", ".vscode-review"] : [".vscode-review", ".qoder-review"];
        const locations = names.map(name => path.join(root, name, "requests"));
        const compare = value => process.platform === "win32" ? value.toLowerCase() : value;
        const value = typeof input === "string" ? input.trim() : undefined;
        const typed = value && path.resolve(root, value);
        if (typed && compare(typed) !== compare(this.exportDirectory || "")) return typed;

        const saved = this.context.workspaceState.get(directoryKey);
        if (value !== "" && saved && !locations.some(item => compare(item) === compare(saved))) return saved;
        for (const location of locations) {
            const folder = await fs.stat(path.dirname(location)).catch(() => null);
            if (folder?.isDirectory()) return location;
        }
        return locations[0];
    }

    async browseDirectory(input) {
        if (this.busy || !this.snapshot) return;
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            defaultUri: vscode.Uri.file(await this.requestDirectory(input)), title: "选择评阅需求保存目录",
        });
        if (!picked?.length) return;
        await this.context.workspaceState.update(directoryKey, picked[0].fsPath);
        this.exportDirectory = picked[0].fsPath;
        this.controls?.webview.postMessage({ type: "directory", value: picked[0].fsPath });
        this.notify();
    }

    async exportRequest(input, requested, purpose = "review") {
        if (!this.isLatest || this.busy) return;
        const { repository, source, target, sourceCommit, head, base, targetCommit } = this.snapshot;
        const clarificationOnly = purpose === "clarifications";
        const actions = changes.automation(clarificationOnly ? undefined : requested);
        const version = this.record.number;
        const storageId = comparisonId(repository, target, source);
        this.exporting = true;
        this.notify();
        try {
            if (sourceCommit !== await git.resolve(repository, source)) throw new Error("来源分支已前进，请先刷新比较。");
            const latest = await versions.currentRange(repository, target, source, this.data);
            if (latest.head !== head || latest.base !== base || latest.sourceCommit !== sourceCommit) {
                throw new Error("分支或工作树内容已变化，请先刷新比较。");
            }
            if (actions.edit) await changes.assertHead(repository, source, sourceCommit);
            const pushDestination = actions.push ? await changes.pushDestination(repository, source) : null;
            const pendingOpinions = clarificationOnly ? [] : this.record.opinions.filter(note => this.needsReply(note, actions.edit));
            const opinions = pendingOpinions.map(note => {
                const { id, revision, path, side, start, end, text, excerpt } = note;
                const file = this.fileFor(note);
                return { id, revision, path, sidePath: side === "old" ? file?.oldPath || path : path,
                    side, start, end, text, excerpt, previousReply: note.replies.at(-1)?.text };
            });
            const clarificationFiles = clarificationOnly
                ? uncoveredFiles(this.snapshot.files, this.record.clarifications)
                : this.snapshot.files
                    .filter(file => file.status !== "U" && this.record.clarifications[file.id]?.digest !== file.digest)
                    .map(({ path, oldPath, status, digest }) => ({ path, oldPath, status, digest }));
            if (clarificationOnly && !clarificationFiles.length) {
                void vscode.window.showInformationMessage("当前版本没有待澄清的文本变更行。");
                return;
            }
            if (!opinions.length && !clarificationFiles.length) throw new Error("没有待回复的意见或待澄清的文件。");
            const directory = await this.requestDirectory(input);
            const job = await handoff.writeRequest(directory, {
                purpose, version, repository, target, source, targetCommit, base, sourceHead: sourceCommit,
                sourceTree: head, actions, pushDestination, opinions, clarificationFiles,
            });
            await this.exports.add({ ...job, storeKey: this.storeKey, storageId });
            if (!clarificationOnly) this.data.automation = actions;
            await this.context.workspaceState.update(directoryKey, directory);
            this.exportDirectory = directory;
            await this.save();
            const exported = clarificationOnly ? clarificationFiles.length + " 个文件待澄清" : opinions.length + " 条意见";
            this.status = { kind: "success", text: "已导出 " + version + " · " + exported };
            void this.showExportActions(job.filename);
            return job;
        } finally {
            this.exporting = false;
            this.notify();
        }
    }

    async showExportActions(filename) {
        const choice = await vscode.window.showInformationMessage(
            "需求已导出，请把 Markdown 文档交给你的 Agent。", "打开文件夹", "复制文件目录",
        );
        if (choice === "打开文件夹") {
            await this.guard(() => vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(filename)));
        }
        if (choice === "复制文件目录") {
            await this.guard(() => vscode.env.clipboard.writeText(path.dirname(filename)));
        }
    }

    async receiveResult(job, result) {
        if (this.busy) return false;
        this.receiving = true;
        try {
            const { request, storeKey, storageId } = job;
            const { repository, source, target } = request;
            const clarificationOnly = request.purpose === "clarifications";
            const active = storeKey === this.storeKey && Boolean(this.data);
            const data = structuredClone(active ? this.data : this.context.workspaceState.get(storeKey));
            if (data?.receipts?.[request.requestId]) return true;
            if (!data?.versions.find(version => version.number === request.version)) {
                throw new Error("找不到导出时的评阅版本。");
            }
            const head = await git.resolve(repository, source);
            if (head !== result.sourceHead) throw new Error("来源分支当前提交与 Agent 回传不一致。");
            if (result.commit) {
                const parent = (await git.git(repository, ["rev-parse", head + "^"])).trim();
                if (parent !== request.sourceHead) throw new Error("Agent 回传的提交须直接基于导出时的来源提交。");
                const touched = (await git.git(repository, ["diff", "--no-renames", "--name-only", "-z", parent, head, "--"]))
                    .split("\0").filter(Boolean);
                const reported = new Set(result.changedPaths);
                if (touched.some(name => !reported.has(name))) throw new Error("Agent 回传的路径遗漏了本轮提交的文件。");
            }
            if (request.actions.edit && head === request.sourceHead && result.changedPaths.length) {
                await changes.assertHead(repository, source, head);
                data.workingPaths = [...new Set([...(data.workingPaths || []), ...result.changedPaths])];
            }

            const replies = new Map(result.replies.map(reply => [reply.id, reply]));
            const at = new Date().toISOString();
            for (const revision of data.versions) {
                if (Number(revision.number.slice(1)) < Number(request.version.slice(1))) continue;
                for (const note of revision.opinions) {
                    const reply = replies.get(note.id);
                    if (reply?.revision !== note.revision) continue;
                    note.replies.push({ requestId: request.requestId, revision: note.revision, text: reply.text, at });
                    if (request.actions.edit && reply.handled) note.editRevision = note.revision;
                }
            }
            const { version, snapshot } = await versions.refresh(repository, target, source, data, storageId);
            if (clarificationOnly && (result.status !== "blocked" || result.clarifications.length)
                && (snapshot.base !== request.base || snapshot.head !== request.sourceTree
                    || snapshot.sourceCommit !== request.sourceHead)) {
                throw new Error("导出时的快照已变化。请刷新比较并重新导出修改澄清需求。");
            }
            const clarifications = new Map();
            const filesByPath = new Map(snapshot.files.map(file => [file.path, file]));
            const cachedBlobs = new Map();
            for (const point of result.clarifications) {
                const file = filesByPath.get(point.path);
                if (!file) continue;
                const name = point.side === "old" ? file.oldPath || file.path : file.path;
                const object = point.side === "old" ? snapshot.base : snapshot.head;
                const cacheKey = object + "\0" + name;
                if (!cachedBlobs.has(cacheKey)) {
                    const blob = await versions.blobId(repository, object, name);
                    const length = blob ? (await git.blob(snapshot, file, point.side)).split("\n").length : 0;
                    cachedBlobs.set(cacheKey, { blob, length });
                }
                const { blob, length } = cachedBlobs.get(cacheKey);
                if (blob !== point.blob || point.end > length) continue;
                if (!clarifications.has(file.id)) clarifications.set(file.id, { digest: file.digest, points: [] });
                const { side, start, end, text } = point;
                clarifications.get(file.id).points.push({ side, start, end, text });
            }
            for (const [fileId, value] of clarifications) {
                const previous = version.clarifications[fileId];
                if (clarificationOnly && previous?.digest === value.digest) {
                    value.points = mergePoints(previous.points, value.points);
                }
                version.clarifications[fileId] = value;
            }
            if (clarificationOnly && result.status === "completed") {
                const missing = uncoveredFiles(snapshot.files, version.clarifications);
                if (missing.length) {
                    const [{ side, start, end }] = missing[0].ranges;
                    const line = start === end ? "L" + start : "L" + start + "–" + end;
                    throw new Error("还有 " + missing.length + " 个文件的变更行缺少澄清。"
                        + missing[0].path + " " + (side === "old" ? "旧侧 " : "新侧 ") + line
                        + "。补齐后重新保存回传文件。");
                }
            }
            (data.receipts ||= {})[request.requestId] = { version: version.number, status: result.status, summary: result.summary, at };
            await this.context.workspaceState.update(storeKey, data);
            const success = result.status === "completed";
            const task = clarificationOnly ? "修改澄清" : "评阅";
            const message = task + (success ? "完成 · " : result.status === "partial" ? "部分完成 · " : "受阻 · ")
                + version.number + " · " + result.summary.slice(0, 160);
            if (active) {
                const wasLatest = this.isLatest;
                const selected = this.record?.number;
                const previousToken = this.snapshot?.token;
                this.data = data;
                if (wasLatest) {
                    this.show(snapshot, version, this.currentFile?.path);
                    if (previousToken !== snapshot.token) {
                        await this.guard(() => this.reopen(previousToken, true));
                    }
                }
                else {
                    this.record = data.versions.find(item => item.number === selected);
                    this.syncThreads();
                }
                this.status = { kind: success ? "success" : "error", text: message };
                this.files.reset();
            }
            const toast = success ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
            void toast(message, "查看版本").then(choice => {
                if (choice) void this.guard(async () => {
                    if (!this.scanning.includes(repository)) await this.discover();
                    await this.select(repository, target, source);
                    await this.selectVersion(version.number);
                    if (this.currentFile) await this.openFile(this.currentFile.id);
                    await vscode.commands.executeCommand(id + ".controls.focus", { preserveFocus: true });
                });
            });
            return true;
        } finally {
            this.receiving = false;
            this.notify();
        }
    }

    async importClarifications() {
        if (!this.snapshot || this.busy) throw new Error("请先生成分支比较。");
        const snapshot = this.snapshot;
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ["json"] }, title: "选择 HTML 的 clarifications.json" });
        if (!picked?.length) return;
        const raw = await vscode.workspace.fs.readFile(picked[0]);
        const data = JSON.parse(Buffer.from(raw).toString("utf8"));
        if (this.busy || snapshot !== this.snapshot || data.base !== snapshot.base
            || data.head !== snapshot.head && (snapshot.working || data.head !== snapshot.sourceCommit)) {
            throw new Error("澄清文件的合并基点和源提交必须与当前比较一致。");
        }
        for (const file of snapshot.files) {
            const points = data.files?.[file.path];
            if (!Array.isArray(points)) continue;
            this.record.clarifications[file.id] = {
                digest: file.digest,
                points: points.flatMap(point => {
                    if (!["new", "old"].includes(point.side) || typeof point.reason !== "string" || !Array.isArray(point.ranges)) return [];
                    const ranges = point.ranges.length ? point.ranges : [{ start: 0, end: 0 }];
                    return ranges.filter(range => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
                        && range.start >= 0 && range.end >= range.start).map(range => ({ ...range, side: point.side, text: point.reason }));
                }),
            };
        }
        await this.save();
    }

    async message(message, panel) {
        if (!message || typeof message !== "object") return;
        if (message.type === "ready") {
            this.notify();
            if (panel === "controls" && !this.scanning.length && !this.loading) await this.discover();
        } else if (panel === "controls") {
            if (message.type === "discover") await this.discover();
            if (message.type === "select") await this.select(message.repository, message.target, message.source);
            if (message.type === "version") await this.selectVersion(message.version);
            if (message.type === "refresh") await this.select(this.repository, this.target, this.source);
            if (message.type === "automation" && this.isLatest && !this.busy) {
                this.data.automation = changes.automation(message.automation);
                await this.save();
            }
            if (message.type === "browseDirectory") await this.browseDirectory(message.directory);
            if (message.type === "export") await this.exportRequest(message.directory, message.automation);
            if (message.type === "exportClarifications") await this.exportRequest(message.directory, undefined, "clarifications");
        } else {
            if (message.type === "reveal") await this.reveal(message.fileId, message.side, message.start, message.end);
            if (message.type === "opinion") {
                try {
                    if (message.comparison !== this.snapshot?.token) throw new Error("比较已切换，请重新选择行范围。");
                    await this.addOpinion(message.selection, message.text, message.editingId);
                    this.detail?.webview.postMessage({ type: "submitted" });
                } catch (error) {
                    this.detail?.webview.postMessage({ type: "submissionError" });
                    throw error;
                }
            }
        }
    }

    documentSaved(document) {
        if (!this.isLatest || this.busy || document.uri.scheme !== "file") return;
        const relative = path.relative(this.repository, document.uri.fsPath);
        if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return;
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            if (this.isLatest && !this.busy) {
                this.guard(() => this.select(this.repository, this.target, this.source));
            }
        }, 550);
    }

    async bind(view, panel) {
        this[panel] = view;
        const uri = this.context.extensionUri;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(uri, "media")] };
        view.webview.onDidReceiveMessage(message => this.guard(() => this.message(message, panel)));
        const onVisibility = panel === "detail" ? view.onDidChangeViewState : view.onDidChangeVisibility;
        onVisibility(() => { if (view.visible) this.notify(); });
        view.onDidDispose(() => { if (this[panel] === view) this[panel] = undefined; });
        const file = name => view.webview.asWebviewUri(vscode.Uri.joinPath(uri, "media", name)).toString();
        const template = await fs.readFile(vscode.Uri.joinPath(uri, "media", panel + ".html").fsPath, "utf8");
        view.webview.html = template.replaceAll("{{csp}}", view.webview.cspSource).replace("{{style}}", file("review.css"))
            .replace("{{script}}", file(panel + ".js"));
    }

    async guard(action) {
        try { return await action(); }
        catch (error) { vscode.window.showErrorMessage("分支评阅：" + error.message); }
    }

    dispose() {
        clearTimeout(this.refreshTimer);
        this.exports.dispose();
        this.comments.dispose();
        this.files.dispose();
    }
}

function activate(context) {
    const review = new Review(context);
    const register = (command, handler) => vscode.commands.registerCommand(id + "." + command,
        (...args) => review.guard(() => handler(...args)));
    context.subscriptions.push(
        review,
        vscode.window.registerTreeDataProvider(id + ".files", review.files),
        vscode.window.registerWebviewViewProvider(id + ".controls", { resolveWebviewView: view => review.bind(view, "controls") }),
        vscode.workspace.registerTextDocumentContentProvider(scheme, { provideTextDocumentContent: uri => review.document(uri) }),
        vscode.window.onDidChangeTextEditorSelection(event => review.selectEditor(event.textEditor, event.selections[0])),
        vscode.window.onDidChangeActiveTextEditor(editor => review.selectEditor(editor)),
        vscode.workspace.onDidSaveTextDocument(document => review.documentSaved(document)),
        vscode.workspace.onDidChangeWorkspaceFolders(() => review.guard(() => review.discover())),
        register("open", async () => {
            await vscode.commands.executeCommand(id + ".controls.focus", { preserveFocus: true });
            await review.focusDetail();
        }),
        register("refresh", () => review.select(review.repository, review.target, review.source)),
        register("openFile", fileId => review.openFile(fileId)),
        register("selectLines", async () => {
            review.selectEditor(vscode.window.activeTextEditor);
            await review.focusDetail(false);
            review.detail?.webview.postMessage({ type: "focusOpinion" });
        }),
        register("addEditorComment", reply => review.addFromEditor(reply)),
        register("importClarifications", () => review.importClarifications()),
    );
    return review;
}

module.exports = { activate };
