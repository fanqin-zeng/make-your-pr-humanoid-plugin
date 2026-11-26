"use strict";

const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
const git = require("./git");
const handoff = require("./handoff");
const changes = require("./changes");
const versions = require("./versions");
const { uncoveredFiles, mergePoints, summaryLimit, summarySentences, pendingSummaries } = require("./clarifications");
const { AllOpinions } = require("./opinions");
const { ReviewStorage, comparisonKey, importLegacy, reviewDatabase, snapshotKey } = require("./storage");

const id = "workspacePrReview";
const scheme = "workspace-pr-review";
const key = id + ".comparison";
const directoryKey = id + ".exportDirectory";
const layoutKey = id + ".fileLayout";
const flatContext = id + ".flatFiles";
const opinionsViewId = id + ".allOpinions";
const statusLabels = { A: "新增", C: "复制", D: "删除", M: "修改", R: "重命名", T: "类型变更", U: "行意见" };

function workspaceRoots() {
    return (vscode.workspace.workspaceFolders || [])
        .filter(item => item.uri.scheme === "file" || item.uri.scheme === "vscode-remote")
        .map(item => item.uri.fsPath);
}

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
        this.flat = review.context.workspaceState.get(layoutKey) === "flat";
        this.change = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.change.event;
    }

    getChildren(node) {
        return node ? node.children || [] : this.roots || [];
    }

    getParent(node) { return node.parent; }

    reset() {
        const snapshot = this.review.snapshot;
        const root = { children: [] };
        for (const file of snapshot?.files || []) {
            const parts = file.path.split("/");
            let parent = root;
            for (const part of this.flat ? [] : parts.slice(0, -1)) {
                let folder = parent.children.find(item => item.children && item.label === part);
                if (!folder) {
                    const relative = parent.relative ? parent.relative + "/" + part : part;
                    folder = { label: part, relative, repository: snapshot.repository, children: [],
                        parent: parent === root ? undefined : parent };
                    parent.children.push(folder);
                }
                parent = folder;
            }
            parent.children.push({ label: parts.at(-1), relative: file.path, repository: snapshot.repository,
                file, parent: parent === root ? undefined : parent });
        }
        this.roots = root.children;
        this.change.fire();
    }

    getTreeItem(node) {
        const item = new vscode.TreeItem(node.label, node.children
            ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = JSON.stringify([node.repository, node.children ? "folder" : "file", node.relative]);
        item.contextValue = node.children ? "reviewFolder" : "reviewFile";
        if (node.children) {
            item.iconPath = vscode.ThemeIcon.Folder;
            item.tooltip = node.relative;
        } else {
            const { file } = node;
            const record = this.review.record?.read[file.id];
            const read = record === file.digest ? "已读" : record ? "待复看" : "未读";
            const count = this.review.opinions(file).length;
            const folder = this.flat && file.path.includes("/") ? path.posix.dirname(file.path) + " · " : "";
            item.description = folder + statusLabels[file.status[0]] + " · " + read + (count ? " · " + count + " 条意见" : "");
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
        this.allOpinions = new AllOpinions(this);
        this.scanning = [];
        this.refs = [];
        this.status = { kind: "idle", text: "选择 Git 仓库以开始评阅" };
        this.snapshots = new Map();
        this.pending = 0;
        this.storages = new Map();
        this.sharedTimer = setInterval(() => { void this.guard(() => this.refreshShared()); }, 1500);
        this.exports = new handoff.ResultWatcher(context.workspaceState,
            (job, result) => this.receiveResult(job, result),
            message => vscode.window.showWarningMessage("评阅回传：" + message),
            () => this.notify());
    }

    get isLatest() { return Boolean(this.record && this.record === this.data?.versions.at(-1)); }

    async storage(repository) {
        const roots = workspaceRoots();
        const identity = JSON.stringify([repository, ...roots.sort()]);
        if (!this.storages.has(identity)) {
            const database = await reviewDatabase(repository);
            if (!this.storages.has(identity)) this.storages.set(identity, new ReviewStorage(roots, database));
        }
        return this.storages.get(identity);
    }

    legacy(repository, target, source, knownKey) {
        const legacyKey = knownKey || id + ".review." + comparisonId(repository, target, source);
        const stored = this.context.workspaceState.get(legacyKey);
        if (stored || !git.originTargets.includes(target)) return stored;
        const oldTarget = git.retiredTargets[git.originTargets.indexOf(target)];
        return this.context.workspaceState.get(id + ".review." + comparisonId(repository, oldTarget, source));
    }

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
        if (!this.detail) return;
        const file = this.currentFile;
        const clarification = file && this.record?.clarifications[file.id];
        const points = clarification?.digest === file?.digest ? clarification?.points || [] : [];
        const storedSummary = file && this.record?.summaries?.[file.id];
        const maxSentences = file ? summaryLimit(file) : 0;
        const summary = storedSummary && storedSummary.digest === file.digest
            ? storedSummary.sentences : summarySentences(points.map(point => point.text), maxSentences);
        this.detail.webview.postMessage({ type: "state", state: {
            comparison: this.snapshot?.token || null,
            version: this.record?.number, historical: Boolean(this.record && !this.isLatest),
            file: file && { id: file.id, path: file.path, oldPath: file.oldPath },
            selection: this.selection,
            points, summary, maxSentences,
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
        const roots = workspaceRoots();
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

    async select(repository, target, source, { preserveFocus = false } = {}) {
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
            const selected = { repository, target: this.target, source: this.source };
            const storage = await this.storage(repository);
            if (request !== this.pending) return;
            const reviewKey = comparisonKey(repository, selected.target, selected.source);
            const storeKey = id + ".review." + comparisonId(repository, selected.target, selected.source);
            const legacy = this.legacy(repository, selected.target, selected.source, storeKey);
            const state = await storage.change(reviewKey, async stored => {
                const data = importLegacy(stored, legacy);
                const result = await versions.refresh(repository, selected.target, selected.source, data);
                return { data, result };
            });
            const directory = await this.requestDirectory();
            if (request !== this.pending) return;
            const { version, snapshot } = state.result;
            this.storeKey = storeKey;
            this.reviewKey = reviewKey;
            this.activeStorage = storage;
            this.sharedRevision = state.revision;
            this.data = state.data;
            this.exportDirectory = directory;
            this.show(snapshot, version, previousFile);
            await this.context.workspaceState.update(key, selected);
            this.status = { kind: "idle", text: version.number + (snapshot.working ? " · 含未提交修改" : " · 分支快照") };
            if (previousToken && previousToken !== snapshot.token) await this.reopen(previousToken, preserveFocus);
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
        this.updateAllOpinions();
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
        await this.refreshShared();
        if (this.busy || !this.snapshot) return;
        const version = this.data.versions.find(item => item.number === number);
        if (!version || version === this.record) return;
        if (version === this.data.versions.at(-1)) {
            await this.select(this.repository, this.target, this.source);
            await this.showAllOpinions();
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
        await this.showAllOpinions();
    }

    clear() {
        this.snapshot = null;
        this.data = null;
        this.record = null;
        this.currentFile = null;
        this.selection = null;
        this.activeStorage = null;
        this.reviewKey = null;
        this.files.reset();
        this.updateAllOpinions();
    }

    updateAllOpinions() {
        this.allOpinions.refresh();
        const count = this.record?.opinions.length || 0;
        this.opinionsView.description = this.record ? this.record.number + " · " + count + " 条" : undefined;
        this.opinionsView.message = count ? undefined
            : this.record ? "当前评阅版本没有评论。" : "在左侧选择仓库和分支。";
    }

    async showAllOpinions(preserveFocus = true) {
        await vscode.commands.executeCommand(opinionsViewId + ".focus", { preserveFocus });
    }

    async revealOpinion(token, opinionId) {
        if (!this.snapshot || token !== this.snapshot.token) return;
        const opinion = this.record.opinions.find(item => item.id === opinionId);
        if (!opinion) return;
        const file = this.fileFor(opinion);
        if (file?.digest === opinion.digest) {
            await this.reveal(file.id, opinion.side, opinion.start, opinion.end);
        } else if (file) {
            await this.openFile(file.id, true);
        }
        await this.focusDetail(true);
    }

    async setFileLayout(flat) {
        this.files.flat = flat;
        this.files.reset();
        await this.context.workspaceState.update(layoutKey, flat ? "flat" : "tree");
        await vscode.commands.executeCommand("setContext", flatContext, flat);
    }

    async expandFolders() {
        if (this.files.flat) return;
        const nodes = [...this.files.getChildren()];
        for (const node of nodes) {
            if (!node.children) continue;
            await this.fileTree.reveal(node, { expand: true, select: false, focus: false });
            nodes.push(...node.children);
        }
    }

    async copyPath(target, format) {
        const location = target instanceof vscode.Uri ? this.locate(target) : null;
        const repository = location?.snapshot.repository || target?.repository;
        const relative = location?.file.path || target?.relative;
        if (!repository || !relative) return;
        const value = format === "name" ? path.posix.basename(relative)
            : format === "absolute" ? path.join(repository, relative) : relative;
        await vscode.env.clipboard.writeText(value);
    }

    async openWorkingFile(node) {
        if (!node?.file) return;
        const filename = path.join(node.repository, node.relative);
        const stat = await fs.stat(filename).catch(error => {
            if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
            throw error;
        });
        if (!stat?.isFile()) {
            void vscode.window.showWarningMessage("当前检出的工作树中找不到文件 " + node.relative);
            return;
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filename));
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
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
        await this.updateRecord(record => { record.read[file.id] = file.digest; });
        if (this.snapshot?.fileMap.get(fileId) !== file) return;
        await vscode.commands.executeCommand("vscode.diff", this.uri(file, "old"), this.uri(file, "new"),
            file.path + " · " + this.record.number + " / PR 基点",
            { viewColumn: vscode.ViewColumn.One, preview: true, preserveFocus });
        if (!preserveFocus && !this.detail?.visible) await this.focusDetail();
    }

    async reveal(fileId, side, start, end) {
        const snapshot = this.snapshot;
        const file = snapshot?.fileMap.get(fileId);
        if (!file || !["old", "new"].includes(side) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return;
        const uri = this.uri(file, side, snapshot);
        if (!this.locate(uri)?.present) return;
        const first = vscode.window.tabGroups.all.find(group => group.viewColumn === vscode.ViewColumn.One);
        const input = first?.activeTab?.input;
        if (!(input instanceof vscode.TabInputTextDiff) || input.modified.toString() !== this.uri(file, "new", snapshot).toString()) {
            await this.openFile(fileId, true);
        }
        await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup");
        await vscode.commands.executeCommand("workbench.action.compareEditor." + (side === "old" ? "focusSecondarySide" : "focusPrimarySide"));
        const editor = await this.visibleDiffEditor(uri)
            || await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One, preview: true });
        if (this.snapshot !== snapshot) return;
        const range = editor.document.validateRange(editorRange(start, end));
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        this.selectEditor(editor, range);
    }

    async visibleDiffEditor(uri) {
        const value = uri.toString();
        const visible = () => [vscode.window.activeTextEditor, ...vscode.window.visibleTextEditors]
            .find(editor => editor?.document.uri.toString() === value);
        const editor = visible();
        if (editor) return editor;
        // The focus command can finish before the extension host receives the editor update.
        return new Promise(resolve => {
            const finish = editor => {
                clearTimeout(timeout);
                editors.dispose();
                active.dispose();
                resolve(editor);
            };
            const changed = () => {
                const editor = visible();
                if (editor) finish(editor);
            };
            const editors = vscode.window.onDidChangeVisibleTextEditors(changed);
            const active = vscode.window.onDidChangeActiveTextEditor(changed);
            const timeout = setTimeout(() => finish(visible()), 350);
        });
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
        if (editingId && !previous) throw new Error("找不到要编辑的意见。");
        if (previous) {
            await this.updateRecord(record => {
                const note = record.opinions.find(opinion => opinion.id === editingId);
                if (note?.revision !== previous.revision) throw new Error("此条意见已在另一窗口编辑，请重新查看。");
                note.text = text.trim();
                note.revision = randomUUID();
            }, true);
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
            const note = {
                id: randomUUID(), revision: randomUUID(), path: file.path, fileId: file.id, side, start, end,
                digest: file.digest, excerpt, text: text.trim(), createdAt: new Date().toISOString(), replies: [],
            };
            await this.updateRecord(record => { record.opinions.push(note); }, true);
        }
    }

    async updateRecord(change, latestOnly = false) {
        const { activeStorage: storage, reviewKey, record } = this;
        if (!storage || !record) throw new Error("请先生成分支比较。");
        const updated = await storage.change(reviewKey, data => {
            const version = data?.versions.find(item => item.number === record.number
                && snapshotKey(item.range) === snapshotKey(record.range));
            if (!version || latestOnly && version !== data.versions.at(-1)) {
                throw new Error("评阅版本已切换，请重新查看最新版本。");
            }
            change(version, data);
            return { data };
        });
        if (this.activeStorage === storage && this.reviewKey === reviewKey) await this.adoptShared(updated);
    }

    async adoptShared(state) {
        const { activeStorage: storage, reviewKey, record, snapshot: previous } = this;
        if (!previous || !state.data?.versions?.length || state.revision <= this.sharedRevision) return;
        const history = state.data.versions;
        const sameSnapshot = item => snapshotKey(item.range) === snapshotKey(record.range);
        const version = (this.isLatest ? null
            : history.find(item => item.number === record.number && sameSnapshot(item)) || history.findLast(sameSnapshot))
            || history.at(-1);
        const changed = version.number !== record.number || !isDeepStrictEqual(version.range, record.range)
            || !isDeepStrictEqual(version.extraFiles, record.extraFiles);
        const snapshot = changed && await versions.load(previous.repository, previous.target, previous.source, version);
        if (this.activeStorage !== storage || this.reviewKey !== reviewKey || this.snapshot !== previous
            || state.revision <= this.sharedRevision) return;
        this.data = state.data;
        this.sharedRevision = state.revision;
        if (changed) {
            this.show(snapshot, version, this.currentFile?.path);
            this.status = { kind: "idle", text: version.number + (this.isLatest
                ? snapshot.working ? " · 含未提交修改" : " · 分支快照" : " · 历史版本") };
            if (previous.token !== snapshot.token) await this.reopen(previous.token, true);
        } else {
            this.record = version;
            this.updateAllOpinions();
        }
        this.files.reset();
        this.notify();
    }

    async refreshShared() {
        const { activeStorage: storage, reviewKey } = this;
        if (!storage || this.busy || this.syncing || storage.revision(reviewKey) === this.sharedRevision) return;
        this.syncing = true;
        try {
            await this.adoptShared(storage.read(reviewKey));
        } finally {
            this.syncing = false;
        }
    }

    needsReply(opinion, edit) {
        return opinion.replies.at(-1)?.revision !== opinion.revision || (edit && opinion.editRevision !== opinion.revision);
    }

    get busy() { return Boolean(this.loading || this.exporting || this.receiving); }

    async requestDirectory(input) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || this.repository || this.context.storageUri?.fsPath;
        const isQoder = /^qoder(?:-|$)/i.test(vscode.env.uriScheme);
        const vscodeDirectory = path.join(root, ".vscode-review", "requests");
        const qoderDirectory = path.join(root, ".qoder-review", "requests");
        const locations = [vscodeDirectory, qoderDirectory];
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
        return isQoder ? qoderDirectory : vscodeDirectory;
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
        await this.refreshShared();
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
            const summaryFiles = pendingSummaries(this.snapshot.files, this.record.summaries);
            if (clarificationOnly && !clarificationFiles.length && !summaryFiles.length) {
                void vscode.window.showInformationMessage("当前版本的变更摘要和行澄清已齐全。");
                return;
            }
            if (!opinions.length && !clarificationFiles.length && !summaryFiles.length) {
                throw new Error("没有待回复的意见、摘要或澄清。");
            }
            const directory = await this.requestDirectory(input);
            const job = await handoff.writeRequest(directory, {
                purpose, version, repository, target, source, targetCommit, base, sourceHead: sourceCommit,
                sourceTree: head, actions, pushDestination, opinions, clarificationFiles, summaryFiles,
            });
            await this.exports.add({ ...job, storeKey: this.storeKey, storageId });
            if (!clarificationOnly) await this.updateRecord((_, data) => { data.automation = actions; });
            await this.context.workspaceState.update(directoryKey, directory);
            this.exportDirectory = directory;
            const exported = clarificationOnly
                ? new Set([...clarificationFiles, ...summaryFiles].map(file => file.path)).size + " 个文件待说明"
                : opinions.length + " 条意见";
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
            const { request, storeKey } = job;
            const { repository, source, target } = request;
            const clarificationOnly = request.purpose === "clarifications";
            const storage = await this.storage(repository);
            const reviewKey = comparisonKey(repository, target, source);
            const state = await storage.change(reviewKey, async stored => {
                const data = importLegacy(stored, this.legacy(repository, target, source, storeKey));
                if (data.receipts?.[request.requestId]) return { data };
                const matches = version => version.range.base === request.base
                    && (version.range.headTree || version.range.head) === request.sourceTree;
                const versionsForRequest = data.versions || [];
                const initial = versionsForRequest.find(item => item.number === request.version && matches(item))
                    || versionsForRequest.findLast(matches);
                if (!initial) throw new Error("找不到导出时的评阅版本。");
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
                for (const revision of data.versions.slice(data.versions.indexOf(initial))) {
                    for (const note of revision.opinions) {
                        const reply = replies.get(note.id);
                        if (reply?.revision !== note.revision) continue;
                        note.replies.push({ requestId: request.requestId, revision: note.revision, text: reply.text, at });
                        if (request.actions.edit && reply.handled) note.editRevision = note.revision;
                    }
                }
                const { version, snapshot } = await versions.refresh(repository, target, source, data);
                if (clarificationOnly && (result.status !== "blocked" || result.clarifications.length)
                    && (snapshot.base !== request.base || snapshot.head !== request.sourceTree
                        || snapshot.sourceCommit !== request.sourceHead)) {
                    throw new Error("导出时的快照已变化。请刷新比较并重新导出修改澄清需求。");
                }
                const clarifications = new Map();
                const filesByPath = new Map(snapshot.files.map(file => [file.path, file]));
                const cachedBlobs = new Map();
                const blobFor = (file, side) => {
                    const name = side === "old" ? file.oldPath || file.path : file.path;
                    const object = side === "old" ? snapshot.base : snapshot.head;
                    const key = object + "\0" + name;
                    if (!cachedBlobs.has(key)) cachedBlobs.set(key, versions.blobId(repository, object, name));
                    return cachedBlobs.get(key);
                };
                const cachedLengths = new Map();
                for (const point of result.clarifications) {
                    const file = filesByPath.get(point.path);
                    if (!file) continue;
                    const blob = await blobFor(file, point.side);
                    if (blob !== point.blob) continue;
                    if (!cachedLengths.has(blob)) {
                        cachedLengths.set(blob, (await git.blob(snapshot, file, point.side)).split("\n").length);
                    }
                    if (point.end > cachedLengths.get(blob)) continue;
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
                for (const item of result.fileSummaries || []) {
                    const file = filesByPath.get(item.path);
                    if (!file) continue;
                    const sentences = summarySentences(item.sentences, summaryLimit(file));
                    if (!sentences.length) continue;
                    const [oldBlob, newBlob] = await Promise.all([blobFor(file, "old"), blobFor(file, "new")]);
                    if ((oldBlob || "") !== item.oldBlob || (newBlob || "") !== item.newBlob) continue;
                    (version.summaries ||= {})[file.id] = { digest: file.digest, sentences };
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
                    const missingSummary = request.summaryFiles?.find(item => {
                        const file = filesByPath.get(item.path);
                        return file && version.summaries?.[file.id]?.digest !== file.digest;
                    });
                    if (missingSummary) {
                        throw new Error("缺少 " + missingSummary.path + " 的变更摘要。补齐后重新保存回传文件。");
                    }
                }
                (data.receipts ||= {})[request.requestId] = { version: version.number, status: result.status, summary: result.summary, at };
                return { data, result: version };
            });
            const version = state.result;
            if (!version) return true;
            const active = this.activeStorage === storage && this.reviewKey === reviewKey;
            const success = result.status === "completed";
            const task = clarificationOnly ? "修改澄清" : "评阅";
            const message = task + (success ? "完成 · " : result.status === "partial" ? "部分完成 · " : "受阻 · ")
                + version.number + " · " + result.summary.slice(0, 160);
            if (active) {
                await this.adoptShared(state);
                this.status = { kind: success ? "success" : "error", text: message };
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
        await this.updateRecord(record => {
            for (const file of snapshot.files) {
                const points = data.files?.[file.path];
                if (!Array.isArray(points)) continue;
                record.clarifications[file.id] = {
                    digest: file.digest,
                    points: points.flatMap(point => {
                        if (!["new", "old"].includes(point.side) || typeof point.reason !== "string" || !Array.isArray(point.ranges)) return [];
                        const ranges = point.ranges.length ? point.ranges : [{ start: 0, end: 0 }];
                        return ranges.filter(range => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
                            && range.start >= 0 && range.end >= range.start).map(range => ({ ...range, side: point.side, text: point.reason }));
                    }),
                };
            }
        });
    }

    async message(message, panel) {
        if (!message || typeof message !== "object") return;
        if (message.type === "ready") {
            this.notify();
            if (panel === "controls" && !this.scanning.length && !this.loading) await this.discover();
            if (panel === "controls" && this.controls?.visible) await this.showAllOpinions();
        } else if (panel === "controls") {
            if (message.type === "discover") await this.discover();
            if (message.type === "select") await this.select(message.repository, message.target, message.source);
            if (message.type === "version") await this.selectVersion(message.version);
            if (message.type === "refresh") await this.select(this.repository, this.target, this.source);
            if (message.type === "automation" && this.isLatest && !this.busy) {
                await this.updateRecord((_, data) => { data.automation = changes.automation(message.automation); }, true);
            }
            if (message.type === "browseDirectory") await this.browseDirectory(message.directory);
            if (message.type === "export") await this.exportRequest(message.directory, message.automation);
            if (message.type === "exportClarifications") await this.exportRequest(message.directory, undefined, "clarifications");
        } else {
            if (message.type === "reveal" && message.comparison === this.snapshot?.token) {
                await this.reveal(message.fileId, message.side, message.start, message.end);
            }
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
        const comparison = this.storeKey;
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            if (this.isLatest && !this.busy && this.storeKey === comparison) {
                this.guard(() => this.select(this.repository, this.target, this.source, { preserveFocus: true }));
            }
        }, 550);
    }

    async bind(view, panel) {
        this[panel] = view;
        const uri = this.context.extensionUri;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(uri, "media")] };
        view.webview.onDidReceiveMessage(message => this.guard(() => this.message(message, panel)));
        const onVisibility = panel === "detail" ? view.onDidChangeViewState : view.onDidChangeVisibility;
        onVisibility(() => {
            if (!view.visible) return;
            this.notify();
            if (panel === "controls") void this.guard(() => this.showAllOpinions());
        });
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
        clearInterval(this.sharedTimer);
        this.exports.dispose();
        for (const storage of this.storages.values()) storage.dispose();
        this.files.dispose();
        this.allOpinions.dispose();
    }
}

function activate(context) {
    const review = new Review(context);
    const register = (command, handler) => vscode.commands.registerCommand(id + "." + command,
        (...args) => review.guard(() => handler(...args)));
    review.fileTree = vscode.window.createTreeView(id + ".files", { treeDataProvider: review.files, showCollapseAll: true });
    review.opinionsView = vscode.window.createTreeView(opinionsViewId, { treeDataProvider: review.allOpinions });
    review.updateAllOpinions();
    void vscode.commands.executeCommand("setContext", flatContext, review.files.flat);
    context.subscriptions.push(
        review,
        review.fileTree,
        review.opinionsView,
        vscode.window.registerWebviewViewProvider(id + ".controls", { resolveWebviewView: view => review.bind(view, "controls") }),
        vscode.workspace.registerTextDocumentContentProvider(scheme, { provideTextDocumentContent: uri => review.document(uri) }),
        vscode.window.onDidChangeTextEditorSelection(event => review.selectEditor(event.textEditor, event.selections[0])),
        vscode.window.onDidChangeActiveTextEditor(editor => review.selectEditor(editor)),
        vscode.workspace.onDidSaveTextDocument(document => review.documentSaved(document)),
        vscode.workspace.onDidChangeWorkspaceFolders(() => review.guard(() => review.discover())),
        register("open", async () => {
            await vscode.commands.executeCommand(id + ".controls.focus", { preserveFocus: true });
            await review.focusDetail();
            await review.showAllOpinions();
        }),
        register("showAllOpinions", () => review.showAllOpinions(false)),
        register("revealOpinion", (token, opinionId) => review.revealOpinion(token, opinionId)),
        register("refresh", () => review.select(review.repository, review.target, review.source)),
        register("openFile", fileId => review.openFile(fileId)),
        register("openWorkingFile", node => review.openWorkingFile(node)),
        register("expandFolders", () => review.expandFolders()),
        register("showFlatFiles", () => review.setFileLayout(true)),
        register("showFileTree", () => review.setFileLayout(false)),
        ...["Name", "Absolute", "Relative"].flatMap(format => [
            register("copyFile" + format, target => review.copyPath(target, format.toLowerCase())),
            register("copyFolder" + format, target => review.copyPath(target, format.toLowerCase())),
        ]),
        register("importClarifications", () => review.importClarifications()),
    );
    return review;
}

module.exports = { activate };
