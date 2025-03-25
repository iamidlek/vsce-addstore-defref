import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

function getPositionFromOffset(text: string, offset: number): vscode.Position {
  const lines = text.slice(0, offset).split(/\r?\n|\r|\n/);
  const line = lines.length - 1;
  const character = lines[line] ? lines[line].length : 0;
  return new vscode.Position(line, character);
}

class LitStoreReferenceTracker implements vscode.ReferenceProvider {
  private storeFileToNamesMap = new Map<string, Set<string>>();
  private storeNameToFilesMap = new Map<string, Set<string>>();
  public componentImportsMap = new Map<string, Map<string, string>>();
  private fileCache = new Map<string, string>();
  private analyzedFiles = new Set<string>();
  private pendingAnalysis = new Map<string, NodeJS.Timeout>();

  private static readonly EXPORT_PATTERN =
    /export\s+(const|let|var)\s+(\w+)\s*=/g;
  private static readonly IMPORT_PATTERN =
    /import\s+{([^}]+)}\s+from\s+['"](.+?)['"]/g;
  private static readonly THIS_PATTERN_BASE = "this\\.";

  public async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token: vscode.CancellationToken
  ): Promise<vscode.Location[]> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return [];
    const word = document.getText(wordRange);
    const filePath = document.uri.fsPath;
    if (this.isStoreFile(filePath) && this.isStoreVariable(filePath, word)) {
      return this.findStoreVariableReferences(filePath, word, token);
    }

    const lineText = document.lineAt(position.line).text;
    const thisPattern = new RegExp(
      `${LitStoreReferenceTracker.THIS_PATTERN_BASE}(${word})\\b`
    );
    const thisMatch = lineText.match(thisPattern);

    if (thisMatch) {
      return this.findImportedStoreReferences(filePath, word, token);
    }

    return [];
  }

  public isStoreFile(filePath: string): boolean {
    return /\.store\.ts?$/.test(filePath);
  }

  public isStoreVariable(filePath: string, varName: string): boolean {
    return this.storeFileToNamesMap.get(filePath)?.has(varName) || false;
  }

  private async findStoreVariableReferences(
    storeFilePath: string,
    storeName: string,
    token: vscode.CancellationToken
  ): Promise<vscode.Location[]> {
    const results: vscode.Location[] = [];
    const visited = new Set<string>();

    results.push(
      ...(await this.findStoreDefinitions(storeFilePath, storeName))
    );

    const allFiles = await vscode.workspace.findFiles(
      "**/*.{ts}",
      "**/node_modules/**"
    );
    for (const fileUri of allFiles) {
      if (token.isCancellationRequested) break;
      if (fileUri.fsPath === storeFilePath) continue;
      const content = await this.getDocumentText(fileUri);
      if (!content) continue;
      if (this.hasImportedStore(content, storeFilePath, storeName)) {
        results.push(
          ...this.findImportReferences(fileUri, content, storeName, visited)
        );
        results.push(
          ...this.findThisStoreReferences(fileUri, content, storeName, visited)
        );
      }
    }
    return results;
  }

  private async findImportedStoreReferences(
    componentFilePath: string,
    storeName: string,
    token: vscode.CancellationToken
  ): Promise<vscode.Location[]> {
    await this.ensureImportsAnalyzed(componentFilePath);
    const compMap = this.componentImportsMap.get(componentFilePath);
    if (!compMap) return [];

    const storeFilePath = compMap.get(storeName);
    if (!storeFilePath) return [];

    const results: vscode.Location[] = [];
    const visited = new Set<string>();

    results.push(
      ...(await this.findStoreDefinitions(storeFilePath, storeName))
    );

    const content = await this.getDocumentText(
      vscode.Uri.file(componentFilePath)
    );
    if (content) {
      results.push(
        ...this.findThisStoreReferences(
          vscode.Uri.file(componentFilePath),
          content,
          storeName,
          visited
        )
      );
    }

    return results;
  }

  public async findStoreDefinitions(
    storeFilePath: string,
    storeName: string
  ): Promise<vscode.Location[]> {
    const locations: vscode.Location[] = [];
    const storeUri = vscode.Uri.file(storeFilePath);

    const text = await this.getDocumentText(storeUri);
    if (!text) return locations;

    const exportPattern = new RegExp(
      `export\\s+(const|let|var)\\s+(${storeName})\\b`,
      "g"
    );
    let match: RegExpExecArray | null;
    while ((match = exportPattern.exec(text)) !== null) {
      const startOff = match.index + match[0].indexOf(storeName);
      const endOff = startOff + storeName.length;
      const startPos = getPositionFromOffset(text, startOff);
      const endPos = getPositionFromOffset(text, endOff);
      locations.push(
        new vscode.Location(storeUri, new vscode.Range(startPos, endPos))
      );
    }
    return locations;
  }

  private findThisStoreReferences(
    fileUri: vscode.Uri,
    content: string,
    storeName: string,
    visited: Set<string>
  ): vscode.Location[] {
    const results: vscode.Location[] = [];
    const pattern = new RegExp(
      `\\b${LitStoreReferenceTracker.THIS_PATTERN_BASE}${storeName}\\b`,
      "g"
    );
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const startOff = match.index + 5;
      const endOff = startOff + storeName.length;
      const startPos = getPositionFromOffset(content, startOff);
      const endPos = getPositionFromOffset(content, endOff);
      const key = `${fileUri.fsPath}:${startPos.line}:${startPos.character}`;
      if (!visited.has(key)) {
        visited.add(key);
        results.push(
          new vscode.Location(fileUri, new vscode.Range(startPos, endPos))
        );
      }
    }
    return results;
  }

  private findImportReferences(
    fileUri: vscode.Uri,
    content: string,
    storeName: string,
    visited: Set<string>
  ): vscode.Location[] {
    const results: vscode.Location[] = [];
    let match: RegExpExecArray | null;

    while (
      (match = LitStoreReferenceTracker.IMPORT_PATTERN.exec(content)) !== null
    ) {
      const importBlock = match[1];
      if (importBlock.includes(storeName)) {
        const importPos = match.index + match[0].indexOf(storeName);
        if (importPos >= 0) {
          const startPos = getPositionFromOffset(content, importPos);
          const endPos = getPositionFromOffset(
            content,
            importPos + storeName.length
          );
          const key = `${fileUri.fsPath}:${startPos.line}:${startPos.character}`;
          if (!visited.has(key)) {
            visited.add(key);
            results.push(
              new vscode.Location(fileUri, new vscode.Range(startPos, endPos))
            );
          }
        }
      }
    }
    return results;
  }

  private hasImportedStore(
    content: string,
    storeFilePath: string,
    storeName: string
  ): boolean {
    const baseName = path.basename(storeFilePath).replace(/\.(ts)$/, "");
    const pattern = new RegExp(
      `import\\s+{[^}]*\\b${storeName}\\b[^}]*}\\s+from\\s+(['"]).*${baseName}\\1`
    );
    return pattern.test(content);
  }

  public async ensureImportsAnalyzed(filePath: string): Promise<void> {
    if (!this.componentImportsMap.has(filePath)) {
      await this.analyzeComponentImports(filePath);
    }
  }

  private async analyzeComponentImports(filePath: string): Promise<void> {
    if (this.analyzedFiles.has(filePath)) return;
    const text = await this.getDocumentText(vscode.Uri.file(filePath));
    if (!text) return;

    const storeMap = new Map<string, string>();
    let match: RegExpExecArray | null;

    while (
      (match = LitStoreReferenceTracker.IMPORT_PATTERN.exec(text)) !== null
    ) {
      const rawNames = match[1].split(",").map((s) => s.trim());
      const importPath = match[2];
      const resolved = this.resolveImportPath(
        importPath,
        path.dirname(filePath)
      );
      if (this.isStoreFile(resolved)) {
        for (const n of rawNames) {
          const subMatch = n.match(/^(\w+)(?:\s+as\s+(\w+))?/);
          if (!subMatch) continue;
          const originalName = subMatch[1];
          const alias = subMatch[2] || originalName;
          storeMap.set(alias, resolved);
        }
      }
    }

    this.componentImportsMap.set(filePath, storeMap);
    this.analyzedFiles.add(filePath);
  }

  private resolveImportPath(importPath: string, baseDir: string): string {
    if (importPath.startsWith("./") || importPath.startsWith("../")) {
      let fullPath = path.resolve(baseDir, importPath);
      if (!/\.ts$/.test(fullPath) && fs.existsSync(fullPath + ".ts")) {
        fullPath += ".ts";
      }
      return fullPath;
    }
    return importPath;
  }

  public async getDocumentText(
    fileUri: vscode.Uri
  ): Promise<string | undefined> {
    try {
      const openDocument = vscode.workspace.textDocuments.find(
        (doc) => doc.uri.fsPath === fileUri.fsPath
      );
      if (openDocument) {
        const text = openDocument.getText();
        const cached = this.fileCache.get(fileUri.fsPath);

        if (cached !== text) {
          this.fileCache.set(fileUri.fsPath, text);
          if (this.isStoreFile(fileUri.fsPath)) {
            this.scheduleAnalysisForStore(fileUri);
          }
          this.analyzedFiles.delete(fileUri.fsPath);
        }
        return text;
      }

      const cached = this.fileCache.get(fileUri.fsPath);
      if (cached !== undefined) {
        return cached;
      }

      const text = (await vscode.workspace.fs.readFile(fileUri)).toString();
      this.fileCache.set(fileUri.fsPath, text);
      return text;
    } catch {
      return undefined;
    }
  }

  private scheduleAnalysisForStore(fileUri: vscode.Uri): void {
    const filePath = fileUri.fsPath;

    if (this.pendingAnalysis.has(filePath)) {
      clearTimeout(this.pendingAnalysis.get(filePath)!);
    }

    const timeoutId = setTimeout(() => {
      this.analyzeStoreFile(fileUri);
      this.pendingAnalysis.delete(filePath);
    }, 300);

    this.pendingAnalysis.set(filePath, timeoutId);
  }

  public async analyzeStoreFile(fileUri: vscode.Uri) {
    const text = await this.getDocumentText(fileUri);
    if (!text) return;
    const filePath = fileUri.fsPath;
    const oldSet = this.storeFileToNamesMap.get(filePath) || new Set<string>();
    const newSet = new Set<string>();

    LitStoreReferenceTracker.EXPORT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while (
      (match = LitStoreReferenceTracker.EXPORT_PATTERN.exec(text)) !== null
    ) {
      const storeName = match[2];
      newSet.add(storeName);

      if (!this.storeNameToFilesMap.has(storeName)) {
        this.storeNameToFilesMap.set(storeName, new Set<string>());
      }
      this.storeNameToFilesMap.get(storeName)!.add(filePath);
    }

    for (const oldName of oldSet) {
      if (!newSet.has(oldName)) {
        const setOfFiles = this.storeNameToFilesMap.get(oldName);
        if (setOfFiles) {
          setOfFiles.delete(filePath);
          if (setOfFiles.size === 0) {
            this.storeNameToFilesMap.delete(oldName);
          }
        }
      }
    }

    this.storeFileToNamesMap.set(filePath, newSet);
  }

  public invalidateCache(filePath: string): void {
    this.fileCache.delete(filePath);
    this.analyzedFiles.delete(filePath);

    if (this.isStoreFile(filePath)) {
      this.scheduleAnalysisForStore(vscode.Uri.file(filePath));
    }
  }
}

class LitStoreDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private referenceTracker: LitStoreReferenceTracker) {}

  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Definition | undefined> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return undefined;
    const word = document.getText(wordRange);
    const filePath = document.uri.fsPath;

    if (
      this.referenceTracker.isStoreFile(filePath) &&
      this.referenceTracker.isStoreVariable(filePath, word)
    ) {
      return this.referenceTracker.findStoreDefinitions(filePath, word);
    }
    const lineText = document.lineAt(position.line).text;
    const thisMatch = lineText.match(new RegExp(`this\\.(${word})\\b`));
    if (thisMatch) {
      return this.findImportedStoreDefinitions(filePath, word);
    }

    if (this.isInAddStoresObjectLiteral(document, position)) {
      return this.findImportedStoreDefinitions(filePath, word);
    }

    return undefined;
  }

  private async findImportedStoreDefinitions(
    componentFilePath: string,
    storeName: string
  ): Promise<vscode.Location[]> {
    await this.referenceTracker.ensureImportsAnalyzed(componentFilePath);
    const compMap =
      this.referenceTracker.componentImportsMap.get(componentFilePath);
    if (!compMap) return [];
    const storeFilePath = compMap.get(storeName);
    if (!storeFilePath) return [];
    return this.referenceTracker.findStoreDefinitions(storeFilePath, storeName);
  }

  private isInAddStoresObjectLiteral(
    document: vscode.TextDocument,
    position: vscode.Position
  ): boolean {
    const lineText = document.lineAt(position.line).text;
    const prefix = lineText.substring(0, position.character).trim();
    if (!/^[A-Za-z0-9_]+,?$/.test(prefix)) return false;
    const MAX_LINES_TO_CHECK = 20;
    let curLine = position.line;
    let foundBrace = false;
    for (let i = 0; i < MAX_LINES_TO_CHECK && curLine >= 0; i++, curLine--) {
      const txt = document.lineAt(curLine).text;
      if (!foundBrace && txt.includes("{")) {
        foundBrace = true;
      } else if (foundBrace && txt.includes("addStores(")) {
        return true;
      }
    }
    return false;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const referenceTracker = new LitStoreReferenceTracker();

  vscode.workspace
    .findFiles("**/*.store.{ts}", "**/node_modules/**")
    .then((files) => {
      Promise.all(files.map((f) => referenceTracker.analyzeStoreFile(f)));
    });

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      referenceTracker.invalidateCache(doc.fileName);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      referenceTracker.getDocumentText(event.document.uri);
    })
  );

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { scheme: "file", language: "typescript" },
      new LitStoreDefinitionProvider(referenceTracker)
    )
  );

  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(
      [{ scheme: "file", language: "typescript" }],
      referenceTracker
    )
  );
}
